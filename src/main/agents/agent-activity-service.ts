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
  createClaudeTranscriptCollector,
  parseClaudeAgentMeta,
  type ClaudeAgentNotification,
  type ClaudeAgentSource,
  type ClaudeAgentToolUse,
  type ClaudeToolResult,
  type ClaudeTranscriptCollector
} from './claude-agent-scan'
import {
  buildCodexAgentRuns,
  createCodexActivityCollector,
  createCodexSummaryCollector,
  parseCodexAgentSpawn,
  type CodexActivityCollector,
  type CodexAgentActivity,
  type CodexAgentSource,
  type CodexAgentSpawn,
  type CodexAgentTranscriptSummary
} from './codex-agent-scan'

// Reads a session's spawned agents off disk, on a timer while a session is selected.
// Three rules, each of which cost something to learn:
//
//  1. **Never hold a transcript in memory.** A real Codex rollout here reaches
//     1.74 GB: `readFile` throws `RangeError: Invalid string length`, and even
//     streaming it into an array of lines was measured at 466 MB of heap for a
//     215 MB file. Every read below streams into a collector and keeps at most one
//     chunk.
//  2. **Never re-read what has not changed.** The two files that grow while being
//     watched — a Claude session transcript and the Codex parent rollout — are
//     TAILED from the last byte offset. A Codex child rollout is re-summarised only
//     when its size or mtime moves, and a rollout's first line is parsed once.
//  3. **Bound every cache.** These live as long as the process and gain an entry per
//     file the user's browsing touches.

// Enough agents to cover any real session; a guard against a pathological directory
// rather than a product limit.
const MAX_AGENTS = 200

type CachedSummary<T> = { size: number; mtimeMs: number; value: T }

// Every cache here is bounded. These live for the lifetime of the main process and
// gain an entry per file the user's browsing touches, so an unbounded map is a slow
// leak rather than a cache.
const CACHE_LIMIT = 64

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): void {
  // Refresh insertion order so the busy entries are not the ones evicted.
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

// Claude transcripts are tailed by byte offset for the same reason the Codex parent
// rollout is: a live session transcript is appended to on every turn, and the largest
// on a real machine is 56 MB. Re-reading one every few seconds is work that grows
// with the session for no new information.
type ClaudeTail = { offset: number; collector: ClaudeTranscriptCollector }
const claudeTails = new Map<string, ClaudeTail>()

const codexSummaryCache = new Map<string, CachedSummary<CodexAgentTranscriptSummary>>()

// A rollout's FIRST line never changes once written, so the spawn metadata parsed
// from it is cached rather than re-opening every candidate file on every poll.
const codexSpawnCache = new Map<string, CodexAgentSpawn | null>()

// The spawning rollout is read incrementally: the byte offset of the last complete
// line consumed, plus the collector holding everything seen so far. This is the
// difference between tailing a growing file and re-reading gigabytes every 4s.
type CodexParentTail = { offset: number; collector: CodexActivityCollector }
const codexParentTails = new Map<string, CodexParentTail>()

// Listing the rollout tree is directory reads only, but there are hundreds of them
// and the answer barely changes between polls.
const ROLLOUT_LIST_TTL_MS = 10_000
const rolloutListCache = new Map<string, { expiresAt: number; refs: RolloutRef[] }>()

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

async function readFirstLine(path: string): Promise<string | null> {
  for await (const line of streamLines(path)) return line
  return null
}

// Feed `onLine` every line from `start` onward and return the offset just past the
// last NEWLINE-TERMINATED one. Nothing larger than one chunk is ever held in memory.
//
// The trailing unterminated remainder is passed to `onLine` but NOT counted into the
// returned offset, so the next read sees it again. Both halves of that matter:
// a file still being appended to ends mid-row, and re-reading is how the rest of
// that row eventually arrives; but a finished file whose last line simply has no
// trailing newline would otherwise never be read at all — which is exactly what a
// test caught here. Re-ingesting a line must therefore be harmless, and it is: the
// collector only ever fills a null field, overwrites with the same value, or takes a
// maximum.
async function ingestFrom(path: string, start: number, onLine: (line: string) => void): Promise<number> {
  let offset = start
  let buffer = ''

  const stream = createReadStream(path, { encoding: 'utf8', start })
  for await (const chunk of stream) {
    buffer += chunk as string
    let index = buffer.indexOf('\n')
    while (index !== -1) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      offset += Buffer.byteLength(line, 'utf8') + 1
      onLine(line)
      index = buffer.indexOf('\n')
    }
  }

  if (buffer.trim().length > 0) onLine(buffer)
  return offset
}

async function fileStamp(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

// Re-summarise a Codex child rollout only when the file has actually changed. A
// growing transcript changes both size and mtime, so this never serves a stale
// summary for a live run. The re-read streams into a collector rather than building
// an array of lines, so even a very large child is bounded memory.
async function cachedCodexSummary(path: string): Promise<CodexAgentTranscriptSummary> {
  const stamp = await fileStamp(path)
  const cached = codexSummaryCache.get(path)
  if (stamp && cached && cached.size === stamp.size && cached.mtimeMs === stamp.mtimeMs) return cached.value

  const collector = createCodexSummaryCollector()
  for await (const line of streamLines(path)) collector.ingest(line)
  const value = collector.snapshot()
  if (stamp) cacheSet(codexSummaryCache, path, { ...stamp, value })
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
  const notifications = new Map<string, ClaudeAgentNotification>()

  // The session transcript holds the Agent calls and, crucially, the results that
  // prove a run ended.
  if (transcriptPath) {
    const scan = await claudeTranscript(transcriptPath)
    for (const [key, value] of scan.toolUses) toolUses.set(key, value)
    for (const [key, value] of scan.toolResults) toolResults.set(key, value)
    for (const [key, value] of scan.notifications) notifications.set(key, value)
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
    const scan = await claudeTranscript(path)
    for (const [key, value] of scan.toolUses) toolUses.set(key, value)
    for (const [key, value] of scan.toolResults) toolResults.set(key, value)
    for (const [key, value] of scan.notifications) notifications.set(key, value)

    let meta = null
    try {
      meta = parseClaudeAgentMeta(await readFile(join(subagentsDir, `${agentId}.meta.json`), 'utf8'))
    } catch {
      // A run whose meta file is missing or unreadable is still a real run; it is
      // named from the spawning call instead.
    }

    agents.push({ agentId, transcriptPath: path, meta, summary: scan.snapshot() })
  }

  return buildClaudeAgentRuns({ sessionId, agents, toolUses, toolResults, notifications, nowMs })
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

type RolloutRef = { path: string; id: string; startedAtMs: number }

// Codex files its rollouts under `sessions/YYYY/MM/DD/`, so listing them costs only
// directory reads. Nothing is opened here.
async function listCodexRollouts(origin: SessionOriginRoot): Promise<RolloutRef[]> {
  const cached = rolloutListCache.get(origin.codexSessionsDir)
  if (cached && cached.expiresAt > Date.now()) return cached.refs

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
  cacheSet(rolloutListCache, origin.codexSessionsDir, { expiresAt: Date.now() + ROLLOUT_LIST_TTL_MS, refs })
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
      const spawn = await readCodexSpawn(candidate.path)
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
    // a child never records about itself. It is also the one file that is large AND
    // still being written, so it is tailed from where the last poll stopped.
    const activity = await codexParentActivity(parent.path)

    const agents: CodexAgentSource[] = []
    for (const entry of descendants) {
      agents.push({
        spawn: entry.spawn,
        transcriptPath: entry.path,
        summary: await cachedCodexSummary(entry.path)
      })
    }

    return buildCodexAgentRuns({ sessionId, agents, activity, nowMs })
  }

  return []
}

// One tailed pass over a Claude transcript. Resets when the file is shorter than
// where we stopped, which means it was replaced or truncated.
async function claudeTranscript(path: string): Promise<ClaudeTranscriptCollector> {
  const stamp = await fileStamp(path)
  let tail = claudeTails.get(path)

  if (!tail || (stamp !== null && stamp.size < tail.offset)) {
    tail = { offset: 0, collector: createClaudeTranscriptCollector() }
  }

  tail.offset = await ingestFrom(path, tail.offset, tail.collector.ingest)
  cacheSet(claudeTails, path, tail)
  return tail.collector
}

async function readCodexSpawn(path: string): Promise<CodexAgentSpawn | null> {
  const cached = codexSpawnCache.get(path)
  if (cached !== undefined) return cached

  let spawn: CodexAgentSpawn | null = null
  const first = await readFirstLine(path)
  if (first && first.includes('session_meta')) {
    try {
      spawn = parseCodexAgentSpawn((JSON.parse(first) as { payload?: unknown }).payload)
    } catch {
      spawn = null
    }
  }

  cacheSet(codexSpawnCache, path, spawn)
  return spawn
}

async function codexParentActivity(path: string): Promise<Map<string, CodexAgentActivity>> {
  const stamp = await fileStamp(path)
  let tail = codexParentTails.get(path)

  // A file shorter than where we stopped was replaced or truncated; anything we
  // remember about it describes bytes that no longer exist.
  if (!tail || (stamp !== null && stamp.size < tail.offset)) {
    tail = { offset: 0, collector: createCodexActivityCollector() }
  }

  tail.offset = await ingestFrom(path, tail.offset, tail.collector.ingest)
  cacheSet(codexParentTails, path, tail)
  return tail.collector.activity
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

// Drops every cached read. Used by the tests; nothing in the app calls it, because
// each cache invalidates itself on the file's size and mtime and all of them are
// bounded.
export function clearAgentActivityCache(): void {
  claudeTails.clear()
  codexSummaryCache.clear()
  codexSpawnCache.clear()
  codexParentTails.clear()
  rolloutListCache.clear()
}
