import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { PlatformId } from '@shared/platform'
import type { AgentActivityResult, AgentRun } from '@shared/agent-activity'
import type { AssistantSessionHistoryEntry } from '@shared/sessions'
import { summariseAgentRuns } from '@shared/agent-activity'
import { getSessionOrigins, type SessionOriginRoot } from '../sessions/session-origins'
import { parseCodexRolloutFile } from '../sessions/codex-rollout'
import { readAgentTranscript } from '../sessions/session-service'
import {
  agentIdFromFilename,
  buildClaudeAgentRuns,
  collectAgentToolUses,
  collectToolResults,
  parseClaudeAgentMeta,
  summariseClaudeAgentTranscript,
  type ClaudeAgentSource,
  type ClaudeAgentToolUse,
  type ClaudeToolResult
} from './claude-agent-scan'
import {
  buildCodexAgentRuns,
  collectCodexSubAgentActivity,
  parseCodexAgentSpawn,
  summariseCodexAgentTranscript,
  type CodexAgentActivity,
  type CodexAgentSource,
  type CodexAgentSpawn
} from './codex-agent-scan'

// Reads a session's spawned agents off disk. This is polled while the Agents dock
// is open, so everything here is shaped by two facts learned the hard way:
//
//  1. **Never read a transcript whole.** A real Codex rollout on this machine is
//     large enough that `readFile(path, 'utf8')` throws `RangeError: Invalid string
//     length` before any parsing happens. Every read below streams line by line.
//  2. **Never re-parse an unchanged file.** A poll that re-read every transcript
//     would burn the disk for no new information, so summaries are cached against
//     the file's size and mtime and only recomputed when one of them moves.

// Enough agents to cover any real session; a guard against a pathological directory
// rather than a product limit.
const MAX_AGENTS = 200

type CachedSummary<T> = { size: number; mtimeMs: number; value: T }

// Everything derived from one Claude transcript in a single pass. The Agent calls
// and results are needed as well as the summary — an agent's own transcript is
// where a nested run's parentage is recorded — and reading the file twice to get
// them would make the cache pointless.
type ClaudeTranscriptScan = {
  summary: ReturnType<typeof summariseClaudeAgentTranscript>
  toolUses: Map<string, ClaudeAgentToolUse>
  toolResults: Map<string, ClaudeToolResult>
}

function scanClaudeTranscript(lines: string[]): ClaudeTranscriptScan {
  return {
    summary: summariseClaudeAgentTranscript(lines),
    toolUses: collectAgentToolUses(lines),
    toolResults: collectToolResults(lines)
  }
}

const claudeScanCache = new Map<string, CachedSummary<ClaudeTranscriptScan>>()
const codexSummaryCache = new Map<string, CachedSummary<ReturnType<typeof summariseCodexAgentTranscript>>>()

async function* streamLines(path: string): AsyncGenerator<string> {
  const reader = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  try {
    for await (const line of reader) yield line
  } finally {
    reader.close()
  }
}

async function readAllLines(path: string): Promise<string[]> {
  const lines: string[] = []
  for await (const line of streamLines(path)) lines.push(line)
  return lines
}

async function readFirstLine(path: string): Promise<string | null> {
  for await (const line of streamLines(path)) return line
  return null
}

async function fileStamp(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

// Re-summarise only when the file has actually changed. A growing transcript
// changes both size and mtime, so this never serves a stale summary for a live run.
async function cachedSummary<T>(
  cache: Map<string, CachedSummary<T>>,
  path: string,
  compute: (lines: string[]) => T
): Promise<T> {
  const stamp = await fileStamp(path)
  const cached = cache.get(path)
  if (stamp && cached && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) return cached.value

  const value = compute(await readAllLines(path))
  if (stamp) cache.set(path, { ...stamp, value })
  return value
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

// A session's subagents live at `<projects-root>/<project-dir>/<sessionId>/subagents`.
// Locate that by reading the project directories only — a recursive walk of the whole
// projects root is far too expensive to repeat on a poll.
async function findClaudeSessionDirs(
  origins: SessionOriginRoot[],
  sessionId: string
): Promise<{ transcriptPath: string | null; subagentsDir: string | null }> {
  for (const origin of origins) {
    let entries: string[]
    try {
      entries = await readdir(origin.claudeProjectsDir)
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const projectDir = join(origin.claudeProjectsDir, entry)
      const subagentsDir = join(projectDir, sessionId, 'subagents')
      const transcriptPath = join(projectDir, `${sessionId}.jsonl`)

      const hasSubagents = await directoryExists(subagentsDir)
      const hasTranscript = (await fileStamp(transcriptPath)) !== null
      if (!hasSubagents && !hasTranscript) continue

      return {
        transcriptPath: hasTranscript ? transcriptPath : null,
        subagentsDir: hasSubagents ? subagentsDir : null
      }
    }
  }

  return { transcriptPath: null, subagentsDir: null }
}

// Exported so the disk-facing half can be tested against a real directory tree
// without an Electron app to ask for the session origins.
export async function scanClaudeAgents(origins: SessionOriginRoot[], sessionId: string, nowMs: number): Promise<AgentRun[]> {
  const { transcriptPath, subagentsDir } = await findClaudeSessionDirs(origins, sessionId)
  if (!subagentsDir) return []

  const toolUses = new Map<string, ClaudeAgentToolUse>()
  const toolResults = new Map<string, ClaudeToolResult>()

  // The session transcript holds the Agent calls and, crucially, the results that
  // prove a run ended.
  if (transcriptPath) {
    const scan = await cachedSummary(claudeScanCache, transcriptPath, scanClaudeTranscript)
    for (const [key, value] of scan.toolUses) toolUses.set(key, value)
    for (const [key, value] of scan.toolResults) toolResults.set(key, value)
  }

  let entries: string[]
  try {
    entries = await readdir(subagentsDir)
  } catch {
    return []
  }

  const agents: ClaudeAgentSource[] = []
  for (const entry of entries) {
    if (agents.length >= MAX_AGENTS) break
    const agentId = agentIdFromFilename(entry)
    if (!agentId) continue

    const path = join(subagentsDir, entry)
    // One pass per file: the summary, plus the calls this agent made — which is how
    // a nested run finds the agent that spawned it rather than being attributed to
    // the session.
    const scan = await cachedSummary(claudeScanCache, path, scanClaudeTranscript)
    for (const [key, value] of scan.toolUses) toolUses.set(key, value)
    for (const [key, value] of scan.toolResults) toolResults.set(key, value)

    let meta = null
    try {
      meta = parseClaudeAgentMeta(await readFile(join(subagentsDir, `${agentId}.meta.json`), 'utf8'))
    } catch {
      // A run whose meta file is missing or unreadable is still a real run; it is
      // named from the spawning call instead.
    }

    agents.push({ agentId, transcriptPath: path, meta, summary: scan.summary })
  }

  return buildClaudeAgentRuns({ sessionId, agents, toolUses, toolResults, nowMs })
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

type RolloutRef = { path: string; id: string; startedAtMs: number }

// Codex files its rollouts under `sessions/YYYY/MM/DD/`, so listing them costs only
// directory reads. Nothing is opened here.
async function listCodexRollouts(origin: SessionOriginRoot): Promise<RolloutRef[]> {
  const refs: RolloutRef[] = []

  async function visit(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        // year / month / day, and no deeper.
        if (depth < 3) await visit(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const ref = parseCodexRolloutFile(path)
      if (ref) refs.push(ref)
    }
  }

  await visit(origin.codexSessionsDir, 0)
  return refs
}

export async function scanCodexAgents(origins: SessionOriginRoot[], sessionId: string, nowMs: number): Promise<AgentRun[]> {
  for (const origin of origins) {
    const rollouts = await listCodexRollouts(origin)
    const parent = rollouts.find((ref) => ref.id === sessionId)
    if (!parent) continue

    // A child thread is always created after its parent started, so only rollouts
    // from that point on can be its descendants. On a machine with hundreds of
    // rollouts this is what keeps the first-line scan below cheap.
    const candidates = rollouts.filter((ref) => ref.id !== sessionId && ref.startedAtMs >= parent.startedAtMs)

    const spawns = new Map<string, { spawn: CodexAgentSpawn; path: string }>()
    for (const candidate of candidates) {
      const first = await readFirstLine(candidate.path)
      if (!first || !first.includes('session_meta')) continue
      let payload: unknown
      try {
        payload = (JSON.parse(first) as { payload?: unknown }).payload
      } catch {
        continue
      }
      const spawn = parseCodexAgentSpawn(payload)
      if (spawn) spawns.set(spawn.threadId, { spawn, path: candidate.path })
    }

    // Walk outward from the session: its direct children, then theirs. Every
    // candidate's parentage is already known, so the closure costs nothing more.
    const descendants: { spawn: CodexAgentSpawn; path: string }[] = []
    const frontier = [sessionId]
    const seen = new Set<string>([sessionId])
    while (frontier.length > 0 && descendants.length < MAX_AGENTS) {
      const current = frontier.shift() as string
      for (const entry of spawns.values()) {
        if (entry.spawn.parentThreadId !== current || seen.has(entry.spawn.threadId)) continue
        seen.add(entry.spawn.threadId)
        descendants.push(entry)
        frontier.push(entry.spawn.threadId)
      }
    }

    if (descendants.length === 0) return []

    // The parent's own rollout carries the lifecycle — notably interruption, which
    // a child never records about itself.
    const activity = new Map<string, CodexAgentActivity>()
    for (const [key, value] of collectCodexSubAgentActivity(await readAllLines(parent.path))) {
      activity.set(key, value)
    }

    const agents: CodexAgentSource[] = []
    for (const entry of descendants) {
      agents.push({
        spawn: entry.spawn,
        transcriptPath: entry.path,
        summary: await cachedSummary(codexSummaryCache, entry.path, summariseCodexAgentTranscript)
      })
    }

    return buildCodexAgentRuns({ sessionId, agents, activity, nowMs })
  }

  return []
}

// ---------------------------------------------------------------------------

export async function getAgentActivity(platform: PlatformId, sessionId: string): Promise<AgentActivityResult> {
  const nowMs = Date.now()
  const empty: AgentActivityResult = {
    platform,
    sessionId,
    runs: [],
    summary: summariseAgentRuns([]),
    scannedAtMs: nowMs
  }
  if (sessionId.length === 0) return empty

  try {
    const origins = await getSessionOrigins()
    const runs =
      platform === 'claude'
        ? await scanClaudeAgents(origins, sessionId, nowMs)
        : await scanCodexAgents(origins, sessionId, nowMs)

    return { platform, sessionId, runs, summary: summariseAgentRuns(runs), scannedAtMs: nowMs }
  } catch {
    // A poll that throws would blank the panel; an empty result reads the same as
    // "this session has spawned nothing", which is the honest default here.
    return empty
  }
}

// A transcript path is only ever read if it sits inside a directory the app already
// scans for this provider. The renderer supplies the path (it came from a run we
// handed it), and a path from the renderer is an input, not a permission: without
// this, `agents:transcript` would read any file on the machine and hand it back.
export function isReadableTranscriptPath(
  origins: SessionOriginRoot[],
  platform: PlatformId,
  path: string
): boolean {
  if (path.length === 0) return false
  const target = resolve(path)

  return origins.some((origin) => {
    const root = resolve(platform === 'claude' ? origin.claudeProjectsDir : origin.codexSessionsDir)
    const inside = relative(root, target)
    // Empty means the path IS the root; a `..` prefix or an absolute result means it
    // escaped. Both are rejected.
    return inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside)
  })
}

export async function getAgentTranscript(
  platform: PlatformId,
  transcriptPath: string
): Promise<AssistantSessionHistoryEntry[]> {
  try {
    const origins = await getSessionOrigins()
    if (!isReadableTranscriptPath(origins, platform, transcriptPath)) return []
    return await readAgentTranscript(platform, transcriptPath)
  } catch {
    return []
  }
}

// Exposed for the delete path and tests: a session whose files are gone should not
// keep serving cached summaries.
export function clearAgentActivityCache(): void {
  claudeScanCache.clear()
  codexSummaryCache.clear()
}
