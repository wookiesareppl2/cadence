import { open, readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type { AssistantSession, AssistantSessionHistory, AssistantSessionHistoryEntry } from '@shared/sessions'
import type { PlatformId } from '@shared/platform'
import { contentText, resolveSessionTitle, titleCandidate, type TitleMessage } from './session-title'
import { isCodexSubagentSessionMeta, rankRolloutFiles } from './codex-rollout'
import { cleanHistoryText } from './session-history-text'
import {
  resolveGeneratedSessionTitle,
  sourceFromPath,
  type SessionTranscriptSource
} from './session-title-generation-service'
import { getSessionOrigins, toSessionOrigin, type SessionOriginRoot } from './session-origins'

type ClaudeSessionDraft = {
  id: string
  sourcePath: string
  cwd: string | null
  branch: string | null
  rawTitle: string | null
  titleMessages: TitleMessage[]
  updatedAtMs: number
  tokenTotal: number
  entrypoint: string | null
  sources: SessionTranscriptSource[]
}

type CodexSessionDraft = {
  id: string
  sourcePath: string
  cwd: string | null
  branch: string | null
  rawTitle: string | null
  titleMessages: TitleMessage[]
  updatedAtMs: number
  isSubagent: boolean
  sources: SessionTranscriptSource[]
}

type CodexSessionDetails = {
  cwd: string | null
  branch: string | null
  titleMessages: TitleMessage[]
  updatedAtMs: number
}

const MAX_SESSIONS = 80
const CODEX_SESSION_DETAIL_READ_WINDOW = 1024 * 1024

// Claude transcript filenames carry no timestamp (just `<sessionId>.jsonl`), so we
// rank candidates by mtime via a cheap stat before reading. We read a buffer above
// MAX_SESSIONS so resumed sessions (several files sharing one id, merged by
// dedupeById) still resolve to a full freshest-MAX_SESSIONS set after dedup.
const CLAUDE_SCAN_READ_LIMIT = MAX_SESSIONS * 2

export async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        return
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }))
  }

  await visit(root)
  return files
}

// A genuine Claude Code transcript lives directly inside its project directory:
// `<projects-root>/<project-dir>/<sessionId>.jsonl`. Everything deeper or hidden
// is not a session and must be ignored, otherwise it surfaces as a phantom
// project:
//   - `.claude-flow/data/*.jsonl` (claude-flow telemetry) → a bogus "data" project
//   - `<sessionId>/subagents/agent-*.jsonl` (subagent sidechains) → internal, not
//     standalone sessions
export function isClaudeTranscriptPath(root: string, path: string): boolean {
  const parts = relative(root, path).split(/[\\/]/)
  if (parts.length !== 2) return false
  return !parts[0].startsWith('.')
}

function relativeAge(timestampMs: number): string {
  const diffMs = Math.max(0, Date.now() - timestampMs)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function formatTokenLabel(value: number): string | null {
  if (!value) return null
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function projectLabel(cwd: string | null, sourcePath: string): string {
  if (cwd) return basename(cwd)
  return basename(dirname(sourcePath)).replaceAll('-', ' ')
}

function codexProjectLabel(cwd: string | null): string {
  return cwd ? basename(cwd) : 'Unindexed'
}

// WSL cwds are POSIX paths; resolve() would mangle them against the Windows drive,
// and two distros could share `/home/<user>/...`. So namespace non-Windows origins
// by id and keep their raw POSIX path. Windows ids stay byte-identical to before so
// saved project aliases/workspaces keyed by projectId are preserved.
function normalizeCwdForId(path: string, origin?: SessionOriginRoot): string {
  if (origin && origin.kind !== 'windows') return path.replace(/\\/g, '/').toLowerCase()
  return resolve(path).toLowerCase()
}

export function projectId(
  platform: PlatformId,
  cwd: string | null,
  fallbackPath?: string,
  origin?: SessionOriginRoot
): string {
  const ns = origin && origin.kind !== 'windows' ? `${origin.id}:` : ''
  if (cwd) return `${platform}:${ns}${normalizeCwdForId(cwd, origin)}`
  if (fallbackPath) return `${platform}:${ns}${normalizeCwdForId(fallbackPath, origin)}`
  return `${platform}:${ns}unindexed`
}

function claudeFallbackTitle(cwd: string | null): string {
  return cwd ? basename(cwd) : 'Claude session'
}

function codexFallbackTitle(id: string): string {
  return `Codex ${id.slice(0, 8)}`
}

function isoTimestamp(timestampMs: number): string | null {
  return timestampMs > 0 ? new Date(timestampMs).toISOString() : null
}

async function findGitDir(cwd: string): Promise<string | null> {
  let current = resolve(cwd)

  while (true) {
    const gitPath = join(current, '.git')
    try {
      const gitPathStats = await stat(gitPath)
      if (gitPathStats.isDirectory()) return gitPath
      if (gitPathStats.isFile()) {
        const raw = await readFile(gitPath, 'utf-8')
        const match = raw.match(/^gitdir:\s*(.+)\s*$/i)
        return match ? resolve(current, match[1]) : null
      }
    } catch {
      // Keep walking upward until we either find a git directory or reach the root.
    }

    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function currentGitBranch(cwd: string | null): Promise<string | null> {
  if (!cwd) return null

  try {
    const gitDir = await findGitDir(cwd)
    if (!gitDir) return null

    const head = await readFile(join(gitDir, 'HEAD'), 'utf-8')
    const match = head.match(/^ref:\s*refs\/heads\/(.+)\s*$/)
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

async function readFileSample(path: string): Promise<string> {
  const stats = await stat(path)
  if (stats.size <= CODEX_SESSION_DETAIL_READ_WINDOW * 2) return readFile(path, 'utf-8')

  const handle = await open(path, 'r')
  try {
    const first = Buffer.alloc(CODEX_SESSION_DETAIL_READ_WINDOW)
    const last = Buffer.alloc(CODEX_SESSION_DETAIL_READ_WINDOW)
    const firstRead = await handle.read(first, 0, first.length, 0)
    const lastRead = await handle.read(last, 0, last.length, Math.max(0, stats.size - last.length))

    return `${first.subarray(0, firstRead.bytesRead).toString('utf-8')}\n${last
      .subarray(0, lastRead.bytesRead)
      .toString('utf-8')}`
  } finally {
    await handle.close()
  }
}

function rowTimestampMs(row: { timestamp?: unknown }, fallbackMs: number): number {
  if (typeof row.timestamp !== 'string') return fallbackMs
  const parsed = Date.parse(row.timestamp)
  return Number.isNaN(parsed) ? fallbackMs : parsed
}

function codexTitleMessage(row: any): string | null {
  if (row?.type === 'event_msg' && row.payload?.type === 'user_message') {
    return titleCandidate(typeof row.payload.message === 'string' ? row.payload.message : null)
  }

  if (row?.type !== 'response_item') return null
  const payload = row.payload
  if (payload?.type !== 'message' || payload.role !== 'user') return null
  return titleCandidate(contentText(payload.content))
}

type HistoryDraft = AssistantSessionHistoryEntry & {
  timestampMs: number
}

function historyEntry({
  row,
  index,
  role,
  label,
  text,
  commandPrefix
}: {
  row: { timestamp?: unknown }
  index: number
  role: HistoryDraft['role']
  label: string
  text: string | null
  commandPrefix?: '$' | '/'
}): HistoryDraft | null {
  const cleanText = cleanHistoryText(text, { commandPrefix })
  if (!cleanText) return null
  const timestampMs = rowTimestampMs(row, 0)

  return {
    id: `${timestampMs || index}:${role}:${index}`,
    role,
    label,
    text: cleanText,
    timestamp: isoTimestamp(timestampMs),
    timestampMs
  }
}

function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((item) => item?.type === 'tool_result')
}

// Synthetic `user`-role rows that the user never typed: tool/MCP results, and
// slash-command/skill expansions (isMeta) like the /start skill body. These must
// never seed a session title — otherwise the skill's own instructions ("Base
// directory for this skill…", "Pass this prompt to the agent…") leak in as the
// title. The history view already excludes these via claudeHistoryEntry.
export function isSyntheticUserRow(row: any): boolean {
  return Boolean(row?.isMeta) || Boolean(row?.toolUseResult) || hasToolResultContent(row?.message?.content)
}

function claudeHistoryEntry(row: any, index: number): HistoryDraft | null {
  // Subagent turns (isSidechain) are internal scaffolding — the agent's task
  // prompt and its step-by-step work — not part of the user's conversation.
  if (row?.isSidechain === true) return null

  if (row?.type === 'queue-operation' && typeof row.content === 'string') {
    return historyEntry({ row, index, role: 'user', label: 'Queued', text: row.content, commandPrefix: '$' })
  }

  if (row?.type === 'user') {
    // Tool/MCP results return as synthetic user-role rows (toolUseResult / a
    // tool_result content block) — never something the user typed. Drop them so
    // they can't masquerade as a prompt.
    if (row.toolUseResult || hasToolResultContent(row.message?.content)) return null

    // Slash-command and skill expansions are injected as synthetic user turns
    // (isMeta). Surface them as context, not as a prompt the user entered.
    if (row.isMeta) {
      return historyEntry({
        row,
        index,
        role: 'system',
        label: 'Context',
        text: contentText(row.message?.content),
        commandPrefix: '$'
      })
    }

    return historyEntry({
      row,
      index,
      role: 'user',
      label: 'User',
      text: contentText(row.message?.content),
      commandPrefix: '$'
    })
  }

  if (row?.type === 'assistant') {
    return historyEntry({
      row,
      index,
      role: 'assistant',
      label: 'Assistant',
      text: contentText(row.message?.content),
      commandPrefix: '$'
    })
  }

  return null
}

function codexHistoryEntry(row: any, index: number): HistoryDraft | null {
  if (row?.type !== 'response_item') return null

  const payload = row.payload
  if (payload?.type === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
    if (!role) return null
    return historyEntry({
      row,
      index,
      role,
      label: role === 'assistant' ? 'Assistant' : 'User',
      text: contentText(payload.content),
      commandPrefix: '/'
    })
  }

  if (payload?.type === 'function_call' && typeof payload.name === 'string') {
    const args = typeof payload.arguments === 'string' ? payload.arguments : ''
    return historyEntry({ row, index, role: 'tool', label: payload.name, text: args || 'Tool call', commandPrefix: '/' })
  }

  return null
}

function finalizeHistoryEntries(entries: HistoryDraft[]): AssistantSessionHistoryEntry[] {
  const ordered = [...entries].sort((a, b) => a.timestampMs - b.timestampMs)

  // The agent emits many intermediate messages while working (narration between
  // tool calls). Once those tool rows are dropped, the assistant messages of one
  // turn sit adjacent — collapse each consecutive run to just its final message
  // so the transcript shows the completed answer, not every step taken.
  const collapsed: HistoryDraft[] = []
  for (const entry of ordered) {
    const previous = collapsed[collapsed.length - 1]
    if (entry.role === 'assistant' && previous?.role === 'assistant') {
      collapsed[collapsed.length - 1] = entry
      continue
    }
    collapsed.push(entry)
  }

  return collapsed.map(({ timestampMs: _timestampMs, ...entry }) => entry)
}

export async function readCodexSessionDetails(path: string): Promise<CodexSessionDetails> {
  const source = await sourceFromPath(path)
  const details: CodexSessionDetails = { cwd: null, branch: null, titleMessages: [], updatedAtMs: source?.mtimeMs ?? 0 }

  try {
    const raw = await readFileSample(path)
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (row?.type === 'session_meta') {
          if (typeof row.payload?.cwd === 'string') details.cwd = row.payload.cwd
          if (typeof row.payload?.git?.branch === 'string') details.branch = row.payload.git.branch
        }

        const timestampMs = rowTimestampMs(row, 0)
        if (timestampMs > 0) details.updatedAtMs = Math.max(details.updatedAtMs, timestampMs)
        const text = codexTitleMessage(row)
        if (text) details.titleMessages.push({ text, timestampMs })
      } catch {
        // Tail samples can start mid-line. Ignore partial or malformed rows.
      }
    }
  } catch {
    return details
  }

  return details
}

// Read everything the session list needs from a single rollout file. Large files
// are sampled (head + tail) by readFileSample: the head carries the session_meta
// (cwd/branch) and the earliest user messages used to infer a title, while the
// tail carries the most recent row timestamp used for recency.
async function readCodexSession(path: string, fallbackUpdatedAtMs: number): Promise<CodexSessionDraft | null> {
  const source = await sourceFromPath(path)
  if (!source) return null

  const draft: CodexSessionDraft = {
    id: basename(path, '.jsonl'),
    sourcePath: path,
    cwd: null,
    branch: null,
    rawTitle: null,
    titleMessages: [],
    updatedAtMs: fallbackUpdatedAtMs,
    isSubagent: false,
    sources: [source]
  }

  let raw: string
  try {
    raw = await readFileSample(path)
  } catch {
    return null
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (row?.type === 'session_meta') {
        if (isCodexSubagentSessionMeta(row.payload)) draft.isSubagent = true
        if (typeof row.payload?.id === 'string') draft.id = row.payload.id
        if (typeof row.payload?.cwd === 'string') draft.cwd = row.payload.cwd
        if (typeof row.payload?.git?.branch === 'string') draft.branch = row.payload.git.branch
      }

      const timestampMs = rowTimestampMs(row, 0)
      if (timestampMs > 0) draft.updatedAtMs = Math.max(draft.updatedAtMs, timestampMs)

      const text = codexTitleMessage(row)
      if (text) draft.titleMessages.push({ text, timestampMs })
    } catch {
      // Tail samples can start mid-line. Ignore partial or malformed rows.
    }
  }

  return draft
}

// Codex stopped maintaining session_index.jsonl on 2026-05-05, but older sessions
// captured there may carry a user-set thread name that isn't recoverable from the
// transcript. Keep it as a best-effort title enrichment, never as the source of
// truth for which sessions exist.
async function readCodexThreadNames(indexPath: string): Promise<Map<string, string>> {
  const names = new Map<string, string>()

  let raw: string
  try {
    raw = await readFile(indexPath, 'utf-8')
  } catch {
    return names
  }

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (typeof row.id === 'string' && typeof row.thread_name === 'string') {
        names.set(row.id, row.thread_name)
      }
    } catch {
      // Ignore malformed index rows.
    }
  }

  return names
}

// Codex reuses a session id across rollout files when a session is resumed. Merge
// drafts sharing an id so the list has unique keys (avoids duplicate React keys).
function dedupeCodexById(drafts: CodexSessionDraft[]): CodexSessionDraft[] {
  const byId = new Map<string, CodexSessionDraft>()

  for (const draft of drafts) {
    const existing = byId.get(draft.id)
    if (!existing) {
      byId.set(draft.id, { ...draft, titleMessages: [...draft.titleMessages], sources: [...draft.sources] })
      continue
    }

    existing.titleMessages.push(...draft.titleMessages)
    existing.sources.push(...draft.sources)
    if (draft.updatedAtMs >= existing.updatedAtMs) {
      existing.updatedAtMs = draft.updatedAtMs
      existing.sourcePath = draft.sourcePath
      existing.cwd = draft.cwd ?? existing.cwd
      existing.branch = draft.branch ?? existing.branch
    } else {
      existing.cwd = existing.cwd ?? draft.cwd
      existing.branch = existing.branch ?? draft.branch
    }
  }

  return [...byId.values()]
}

async function readClaudeSession(path: string): Promise<ClaudeSessionDraft | null> {
  const stats = await stat(path)
  const draft: ClaudeSessionDraft = {
    id: basename(path, '.jsonl'),
    sourcePath: path,
    cwd: null,
    branch: null,
    rawTitle: null,
    titleMessages: [],
    updatedAtMs: stats.mtimeMs,
    tokenTotal: 0,
    entrypoint: null,
    sources: [{ path, size: stats.size, mtimeMs: stats.mtimeMs }]
  }

  const raw = await readFile(path, 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      const timestampMs = rowTimestampMs(row, draft.updatedAtMs)
      if (typeof row.sessionId === 'string') draft.id = row.sessionId
      if (typeof row.cwd === 'string') draft.cwd = row.cwd
      if (typeof row.gitBranch === 'string') draft.branch = row.gitBranch
      if (!draft.entrypoint && typeof row.entrypoint === 'string') draft.entrypoint = row.entrypoint
      if (row.type === 'user' && !isSyntheticUserRow(row)) {
        const text = titleCandidate(contentText(row.message?.content))
        if (text) {
          draft.titleMessages.push({ text, timestampMs })
          if (!draft.rawTitle) draft.rawTitle = text
        }
      }
      if (row.type === 'queue-operation') {
        const text = titleCandidate(typeof row.content === 'string' ? row.content : null)
        if (text) {
          draft.titleMessages.push({ text, timestampMs })
          if (!draft.rawTitle) draft.rawTitle = text
        }
      }
      if (typeof row.timestamp === 'string') {
        draft.updatedAtMs = Math.max(draft.updatedAtMs, timestampMs)
      }

      const usage = row.message?.usage
      if (usage) {
        draft.tokenTotal +=
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
      }
    } catch {
      // Ignore malformed JSONL rows. The usage parser owns detailed diagnostics.
    }
  }

  return draft
}

// Claude Code reuses one sessionId across multiple .jsonl files when a session
// is resumed/continued, so several drafts can share the same id. Merge them into
// a single entry — summing usage and keeping the freshest metadata — so the list
// has unique ids (avoids duplicate React keys and dropped/duplicated rows).
function dedupeById(drafts: ClaudeSessionDraft[]): ClaudeSessionDraft[] {
  const byId = new Map<string, ClaudeSessionDraft>()

  for (const draft of drafts) {
    const existing = byId.get(draft.id)
    if (!existing) {
      byId.set(draft.id, { ...draft, titleMessages: [...draft.titleMessages], sources: [...draft.sources] })
      continue
    }

    existing.tokenTotal += draft.tokenTotal
    existing.rawTitle = existing.rawTitle ?? draft.rawTitle
    existing.entrypoint = existing.entrypoint ?? draft.entrypoint
    existing.titleMessages.push(...draft.titleMessages)
    existing.sources.push(...draft.sources)
    if (draft.updatedAtMs >= existing.updatedAtMs) {
      existing.updatedAtMs = draft.updatedAtMs
      existing.sourcePath = draft.sourcePath
      existing.cwd = draft.cwd ?? existing.cwd
      existing.branch = draft.branch ?? existing.branch
    } else {
      existing.cwd = existing.cwd ?? draft.cwd
      existing.branch = existing.branch ?? draft.branch
    }
  }

  return [...byId.values()]
}

// Sessions whose originating entrypoint is the Claude Agent SDK (`sdk-py`,
// `sdk-ts`, …) are automated, programmatic runs — e.g. security-review tooling
// that injects prompts like "Review this change for security vulnerabilities".
// They are not the user's interactive Claude Code (CLI/IDE) sessions, so exclude
// them; otherwise they surface as phantom prompts the user never typed.
export function isAutomatedSession(entrypoint: string | null): boolean {
  return typeof entrypoint === 'string' && entrypoint.toLowerCase().startsWith('sdk')
}

// Rank transcript files by mtime (cheap stat, no content read) and keep the
// freshest `limit`. Reading and JSON-parsing every transcript just to discard all
// but the newest MAX_SESSIONS dominated startup for heavy users; a stat is far
// cheaper than a full read, especially over the WSL UNC share. Mirrors what
// rankRolloutFiles does for Codex (which ranks by the timestamp in its filenames).
async function rankClaudeFilesByMtime(paths: string[], limit: number): Promise<string[]> {
  const ranked = await Promise.all(
    paths.map(async (path) => {
      try {
        return { path, mtimeMs: (await stat(path)).mtimeMs }
      } catch {
        return null
      }
    })
  )

  return ranked
    .filter((ref): ref is { path: string; mtimeMs: number } => ref !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(0, limit))
    .map((ref) => ref.path)
}

async function visibleClaudeDraftsForOrigin(origin: SessionOriginRoot): Promise<ClaudeSessionDraft[]> {
  const root = origin.claudeProjectsDir
  const files = (await findJsonlFiles(root)).filter((path) => isClaudeTranscriptPath(root, path))
  const freshest = await rankClaudeFilesByMtime(files, CLAUDE_SCAN_READ_LIMIT)
  const sessions = await Promise.all(freshest.map(readClaudeSession))
  const drafts = sessions.filter((session): session is ClaudeSessionDraft => Boolean(session))

  // Per-origin cap: each environment surfaces its own freshest sessions, so a busy
  // Windows profile can never starve WSL projects out of the list (and vice versa).
  return dedupeById(drafts)
    .filter((session) => !isAutomatedSession(session.entrypoint))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, MAX_SESSIONS)
}

async function mapClaudeSession(session: ClaudeSessionDraft, origin: SessionOriginRoot): Promise<AssistantSession> {
  const fallbackTitle = claudeFallbackTitle(session.cwd)
  const project = projectLabel(session.cwd, session.sourcePath)
  const resolvedTitle = resolveSessionTitle({
    rawTitle: session.rawTitle,
    fallbackTitle,
    messages: session.titleMessages
  })
  const titleFields = await resolveGeneratedSessionTitle({
    platform: 'claude',
    sessionId: session.id,
    project,
    projectPath: session.cwd,
    branch: session.branch,
    fallbackTitle,
    resolvedTitle,
    titleMessages: session.titleMessages,
    transcriptUpdatedAtMs: session.updatedAtMs,
    sources: session.sources
  })

  return {
    id: session.id,
    platform: 'claude',
    projectId: projectId('claude', session.cwd, dirname(session.sourcePath), origin),
    title: titleFields.title,
    rawTitle: titleFields.rawTitle,
    inferredTitle: titleFields.inferredTitle,
    generatedTitle: titleFields.generatedTitle,
    titleSource: titleFields.titleSource,
    titleStatus: titleFields.titleStatus,
    titleUpdatedAt: titleFields.titleUpdatedAt,
    project,
    projectPath: session.cwd,
    branch: session.branch,
    origin: toSessionOrigin(origin),
    usageLabel: formatTokenLabel(session.tokenTotal),
    status: 'local',
    age: relativeAge(session.updatedAtMs),
    updatedAt: new Date(session.updatedAtMs).toISOString()
  }
}

export async function getClaudeSessionsForOrigins(origins: SessionOriginRoot[]): Promise<AssistantSession[]> {
  const groups = await Promise.all(
    origins.map(async (origin) => ({ origin, drafts: await visibleClaudeDraftsForOrigin(origin) }))
  )

  return Promise.all(groups.flatMap(({ origin, drafts }) => drafts.map((draft) => mapClaudeSession(draft, origin))))
}

export async function getClaudeSessions(): Promise<AssistantSession[]> {
  return getClaudeSessionsForOrigins(await getSessionOrigins())
}

async function visibleCodexDraftsForOrigin(origin: SessionOriginRoot): Promise<CodexSessionDraft[]> {
  const files = await findJsonlFiles(origin.codexSessionsDir)

  // Rank by the timestamp in each rollout filename (no reads), keep the freshest
  // slice, then read details only for those. Discovery comes from the rollout
  // files themselves — not session_index.jsonl — so current Codex sessions and
  // every project worked on actually surface.
  const ranked = rankRolloutFiles(files, MAX_SESSIONS)
  const drafts = await Promise.all(ranked.map((ref) => readCodexSession(ref.path, ref.startedAtMs)))

  const visibleDrafts = drafts
    .filter((draft): draft is CodexSessionDraft => Boolean(draft))
    .filter((draft) => !draft.isSubagent)
  return dedupeCodexById(visibleDrafts).sort((a, b) => b.updatedAtMs - a.updatedAtMs)
}

async function mapCodexSession(
  draft: CodexSessionDraft,
  origin: SessionOriginRoot,
  threadNames: Map<string, string>,
  branchByCwd: Map<string, Promise<string | null>>
): Promise<AssistantSession> {
  let branch = draft.branch
  if (draft.cwd && !branch && origin.kind === 'windows') {
    // Git branch resolution walks the filesystem; only do it for native Windows
    // cwds. WSL cwds are POSIX paths that won't resolve from the Windows side.
    if (!branchByCwd.has(draft.cwd)) branchByCwd.set(draft.cwd, currentGitBranch(draft.cwd))
    branch = (await branchByCwd.get(draft.cwd)) ?? null
  }

  const fallbackTitle = codexFallbackTitle(draft.id)
  const project = codexProjectLabel(draft.cwd)
  const resolvedTitle = resolveSessionTitle({
    rawTitle: draft.rawTitle ?? threadNames.get(draft.id) ?? null,
    fallbackTitle,
    messages: draft.titleMessages
  })
  const titleFields = await resolveGeneratedSessionTitle({
    platform: 'codex',
    sessionId: draft.id,
    project,
    projectPath: draft.cwd,
    branch,
    fallbackTitle,
    resolvedTitle,
    titleMessages: draft.titleMessages,
    transcriptUpdatedAtMs: draft.updatedAtMs,
    sources: draft.sources
  })

  return {
    id: draft.id,
    platform: 'codex',
    projectId: projectId('codex', draft.cwd, undefined, origin),
    title: titleFields.title,
    rawTitle: titleFields.rawTitle,
    inferredTitle: titleFields.inferredTitle,
    generatedTitle: titleFields.generatedTitle,
    titleSource: titleFields.titleSource,
    titleStatus: titleFields.titleStatus,
    titleUpdatedAt: titleFields.titleUpdatedAt,
    project,
    projectPath: draft.cwd,
    branch,
    origin: toSessionOrigin(origin),
    usageLabel: null,
    status: '',
    age: relativeAge(draft.updatedAtMs),
    updatedAt: new Date(draft.updatedAtMs).toISOString()
  }
}

export async function getCodexSessionsForOrigins(origins: SessionOriginRoot[]): Promise<AssistantSession[]> {
  const threadNames = new Map<string, string>()
  const branchByCwd = new Map<string, Promise<string | null>>()

  const groups = await Promise.all(
    origins.map(async (origin) => {
      const [names, drafts] = await Promise.all([
        readCodexThreadNames(origin.codexIndexFile),
        visibleCodexDraftsForOrigin(origin)
      ])
      for (const [id, name] of names) if (!threadNames.has(id)) threadNames.set(id, name)
      return { origin, drafts }
    })
  )

  return Promise.all(
    groups.flatMap(({ origin, drafts }) =>
      drafts.map((draft) => mapCodexSession(draft, origin, threadNames, branchByCwd))
    )
  )
}

export async function getCodexSessions(): Promise<AssistantSession[]> {
  return getCodexSessionsForOrigins(await getSessionOrigins())
}

async function getClaudeSessionFiles(
  sessionId: string
): Promise<Array<{ path: string; raw: string; source: SessionTranscriptSource }>> {
  const origins = await getSessionOrigins()

  for (const origin of origins) {
    const root = origin.claudeProjectsDir
    // Only real transcripts. This excludes subagent sidechains
    // (`<sessionId>/subagents/agent-*.jsonl`) and claude-flow telemetry
    // (`.claude-flow/data/*.jsonl`) — the latter also carries real sessionIds, so
    // it would otherwise be folded into a session's history as empty noise.
    const files = (await findJsonlFiles(root)).filter((path) => isClaudeTranscriptPath(root, path))
    const matches: Array<{ path: string; raw: string; source: SessionTranscriptSource }> = []

    for (const path of files) {
      let raw = ''
      try {
        raw = await readFile(path, 'utf-8')
      } catch {
        continue
      }

      if (basename(path, '.jsonl') === sessionId || raw.includes(`"sessionId":"${sessionId}"`)) {
        const source = await sourceFromPath(path)
        if (source) matches.push({ path, raw, source })
      }
    }

    // A session's transcripts all live in one origin; stop at the first that has it.
    if (matches.length > 0) return matches
  }

  return []
}

async function getCodexSessionFile(
  sessionId: string
): Promise<{ path: string; raw: string; source: SessionTranscriptSource } | null> {
  const origins = await getSessionOrigins()

  for (const origin of origins) {
    const files = await findJsonlFiles(origin.codexSessionsDir)
    const path = files.find((file) => file.includes(sessionId))
    if (!path) continue

    try {
      const source = await sourceFromPath(path)
      if (!source) continue
      return { path, raw: await readFile(path, 'utf-8'), source }
    } catch {
      continue
    }
  }

  return null
}

export async function getClaudeSessionHistory(sessionId: string): Promise<AssistantSessionHistory> {
  const matches = await getClaudeSessionFiles(sessionId)
  const drafts = await Promise.all(matches.map(({ path }) => readClaudeSession(path)))
  const session = dedupeById(drafts.filter((draft): draft is ClaudeSessionDraft => Boolean(draft)))[0]
  const fallbackTitle = claudeFallbackTitle(session?.cwd ?? null)
  const resolvedTitle = resolveSessionTitle({
    rawTitle: session?.rawTitle ?? null,
    fallbackTitle,
    messages: session?.titleMessages ?? []
  })
  const project = session ? projectLabel(session.cwd, session.sourcePath) : 'Claude session'
  const titleFields = await resolveGeneratedSessionTitle({
    platform: 'claude',
    sessionId,
    project,
    projectPath: session?.cwd ?? null,
    branch: session?.branch ?? null,
    fallbackTitle,
    resolvedTitle,
    titleMessages: session?.titleMessages ?? [],
    transcriptUpdatedAtMs: session?.updatedAtMs ?? Math.max(0, ...matches.map((match) => match.source.mtimeMs)),
    sources: session?.sources ?? matches.map((match) => match.source)
  })

  const entries: HistoryDraft[] = []
  let index = 0
  for (const { raw } of matches) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue
      try {
        const entry = claudeHistoryEntry(JSON.parse(line), index)
        if (entry) entries.push(entry)
      } catch {
        // Ignore malformed JSONL rows in read-only history.
      }
      index += 1
    }
  }

  return {
    sessionId,
    platform: 'claude',
    title: titleFields.title,
    project,
    entries: finalizeHistoryEntries(entries)
  }
}

export async function getCodexSessionHistory(sessionId: string): Promise<AssistantSessionHistory> {
  const match = await getCodexSessionFile(sessionId)
  if (!match) {
    return {
      sessionId,
      platform: 'codex',
      title: codexFallbackTitle(sessionId),
      project: 'Unindexed',
      entries: []
    }
  }

  const details = await readCodexSessionDetails(match.path)
  const fallbackTitle = codexFallbackTitle(sessionId)
  const resolvedTitle = resolveSessionTitle({
    rawTitle: null,
    fallbackTitle,
    messages: details.titleMessages
  })
  const project = codexProjectLabel(details.cwd)
  const titleFields = await resolveGeneratedSessionTitle({
    platform: 'codex',
    sessionId,
    project,
    projectPath: details.cwd,
    branch: details.branch,
    fallbackTitle,
    resolvedTitle,
    titleMessages: details.titleMessages,
    transcriptUpdatedAtMs: details.updatedAtMs,
    sources: [match.source]
  })

  const entries: HistoryDraft[] = []
  let index = 0
  for (const line of match.raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const entry = codexHistoryEntry(JSON.parse(line), index)
      if (entry) entries.push(entry)
    } catch {
      // Ignore malformed JSONL rows in read-only history.
    }
    index += 1
  }

  return {
    sessionId,
    platform: 'codex',
    title: titleFields.title,
    project,
    entries: finalizeHistoryEntries(entries)
  }
}

export async function getSessionHistory(platform: PlatformId, sessionId: string): Promise<AssistantSessionHistory> {
  return platform === 'claude' ? getClaudeSessionHistory(sessionId) : getCodexSessionHistory(sessionId)
}
