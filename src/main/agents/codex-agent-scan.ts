import type { AgentRun } from '@shared/agent-activity'
import { resolveAgentStatus } from '@shared/agent-activity'

// Codex records subagents in two places, and both are worth reading.
//
// The spawning thread's rollout carries the lifecycle as it happens:
//   {type: 'sub_agent_activity', agent_thread_id, agent_path, kind, occurred_at_ms}
//   kind is 'started' | 'interacted' | 'interrupted'
// and a richer spawn event naming the agent:
//   {type: 'collab_agent_spawn_end', new_thread_id, new_agent_nickname, new_agent_role}
//
// The spawned agent then gets its OWN rollout file, whose `session_meta` repeats
// the parentage in a single self-contained record:
//   source.subagent.thread_spawn = {parent_thread_id, depth, agent_path,
//                                   agent_nickname, agent_role}
//
// The agent's own file is the better source — it survives without the parent and
// names the run in one read — so it leads, and the parent's events fill in the
// lifecycle the agent's file cannot know about (notably interruption, which the
// parent issues).
//
// Unlike Claude, Codex writes an explicit end: `task_complete` (with an `error`
// when the turn failed) or `turn_aborted`.

type UnknownRecord = Record<string, unknown>

// Codex spawns more than one KIND of subagent, and they are not equally
// interesting. A `thread_spawn` is delegated work — the thing the user means by a
// subagent. A `source.subagent.other` names an internal mechanism instead: on a
// real machine 12 of one session's 16 spawns were `other: "guardian"`, the
// approval checker that fires per tool call. Both are real runs and neither is
// dropped, but they must be distinguishable or the guardians bury the work.
export const CODEX_DELEGATED_SPAWN = 'thread_spawn'

export type CodexAgentSpawn = {
  threadId: string
  parentThreadId: string | null
  depth: number
  agentPath: string | null
  nickname: string | null
  role: string | null
  // CODEX_DELEGATED_SPAWN for delegated work, otherwise the internal kind Codex
  // named ('guardian', ...).
  spawnKind: string
  startedAtMs: number | null
  cwd: string | null
}

export type CodexAgentActivity = {
  threadId: string
  agentPath: string | null
  nickname: string | null
  role: string | null
  startedAtMs: number | null
  interruptedAtMs: number | null
  lastEventAtMs: number | null
}

export type CodexAgentTranscriptSummary = {
  startedAtMs: number | null
  lastActivityAtMs: number | null
  completedAtMs: number | null
  interruptedAtMs: number | null
  failed: boolean
  errorMessage: string | null
  turnCount: number
  tokens: number | null
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseTimestamp(value: unknown): number | null {
  const text = asText(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function parseLine(line: string): UnknownRecord | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  try {
    return asRecord(JSON.parse(trimmed))
  } catch {
    return null
  }
}

// Pull the parentage out of a spawned agent's own `session_meta` payload. Returns
// null for an ordinary session, which is what makes this safe to call on every
// rollout file we scan.
export function parseCodexAgentSpawn(payload: unknown): CodexAgentSpawn | null {
  const record = asRecord(payload)
  if (!record) return null

  const threadId = asText(record.id)
  if (!threadId) return null

  const subagent = asRecord(asRecord(record.source)?.subagent)
  const spawn = asRecord(subagent?.thread_spawn)
  // A thread with no subagent record at all is a top-level session. An `other`
  // spawn, and an older rollout carrying only a top-level `parent_thread_id`, are
  // both still subagents.
  const parentThreadId = asText(spawn?.parent_thread_id) ?? asText(record.parent_thread_id)
  if (!spawn && parentThreadId === null && !subagent) return null

  const depth = asPositiveNumber(spawn?.depth)
  const otherKind = asText(subagent?.other)

  return {
    threadId,
    parentThreadId,
    depth: depth !== null && depth > 0 ? depth : 1,
    agentPath: asText(spawn?.agent_path),
    nickname: asText(spawn?.agent_nickname) ?? asText(record.agent_nickname),
    role: asText(spawn?.agent_role) ?? asText(record.agent_role) ?? otherKind,
    spawnKind: spawn ? CODEX_DELEGATED_SPAWN : (otherKind ?? CODEX_DELEGATED_SPAWN),
    startedAtMs: parseTimestamp(record.timestamp),
    cwd: asText(record.cwd)
  }
}

// Read the spawning thread's own rollout for what it knows about its children.
// This is where interruption is recorded, and where a run that never managed to
// write its own file still leaves a trace.
//
// Exposed as an incremental collector rather than a whole-file function because the
// spawning rollout is the one file that is BOTH large and still growing: the largest
// on a real machine is 1.74 GB, and re-reading it every poll is an out-of-memory
// crash, not a slowdown. The caller feeds it only the bytes appended since last time.
export type CodexActivityCollector = {
  ingest: (line: string) => void
  activity: Map<string, CodexAgentActivity>
}

export function collectCodexSubAgentActivity(lines: Iterable<string>): Map<string, CodexAgentActivity> {
  const collector = createCodexActivityCollector()
  for (const line of lines) collector.ingest(line)
  return collector.activity
}

export function createCodexActivityCollector(): CodexActivityCollector {
  const activity = new Map<string, CodexAgentActivity>()

  const ensure = (threadId: string): CodexAgentActivity => {
    const existing = activity.get(threadId)
    if (existing) return existing
    const created: CodexAgentActivity = {
      threadId,
      agentPath: null,
      nickname: null,
      role: null,
      startedAtMs: null,
      interruptedAtMs: null,
      lastEventAtMs: null
    }
    activity.set(threadId, created)
    return created
  }

  const ingest = (line: string): void => {
    const row = parseLine(line)
    if (!row) return
    const payload = asRecord(row.payload)
    if (!payload) return

    const rowAtMs = parseTimestamp(row.timestamp)

    if (payload.type === 'sub_agent_activity') {
      const threadId = asText(payload.agent_thread_id)
      if (!threadId) return
      const entry = ensure(threadId)
      const atMs = asPositiveNumber(payload.occurred_at_ms) ?? rowAtMs

      entry.agentPath = asText(payload.agent_path) ?? entry.agentPath
      if (atMs !== null && (entry.lastEventAtMs === null || atMs > entry.lastEventAtMs)) {
        entry.lastEventAtMs = atMs
      }
      if (payload.kind === 'started' && entry.startedAtMs === null) entry.startedAtMs = atMs
      if (payload.kind === 'interrupted') entry.interruptedAtMs = atMs
      return
    }

    if (payload.type === 'collab_agent_spawn_end') {
      const threadId = asText(payload.new_thread_id)
      if (!threadId) return
      const entry = ensure(threadId)
      entry.nickname = asText(payload.new_agent_nickname) ?? entry.nickname
      entry.role = asText(payload.new_agent_role) ?? entry.role
      if (entry.startedAtMs === null) entry.startedAtMs = rowAtMs
      if (rowAtMs !== null && (entry.lastEventAtMs === null || rowAtMs > entry.lastEventAtMs)) {
        entry.lastEventAtMs = rowAtMs
      }
    }
  }

  return { ingest, activity }
}

// Date the run, count its turns, and take its token total.
//
// `token_count` reports a CUMULATIVE `total_token_usage`, so the last one is the
// answer and summing them would inflate the figure enormously — the same trap as
// Claude's repeated request rows, in Codex's own shape.
export type CodexSummaryCollector = {
  ingest: (line: string) => void
  snapshot: () => CodexAgentTranscriptSummary
}

export function summariseCodexAgentTranscript(lines: Iterable<string>): CodexAgentTranscriptSummary {
  const collector = createCodexSummaryCollector()
  for (const line of lines) collector.ingest(line)
  return collector.snapshot()
}

// Streaming form, so a large child rollout is never held in memory as an array of
// lines. Unlike the activity collector this one is rebuilt from scratch whenever the
// file changes, so it does not need to be idempotent under a repeated line.
export function createCodexSummaryCollector(): CodexSummaryCollector {
  let startedAtMs: number | null = null
  let lastActivityAtMs: number | null = null
  let completedAtMs: number | null = null
  let interruptedAtMs: number | null = null
  let failed = false
  let errorMessage: string | null = null
  let turnCount = 0
  let tokens: number | null = null

  const ingest = (line: string): void => {
    const row = parseLine(line)
    if (!row) return

    const atMs = parseTimestamp(row.timestamp)
    if (atMs !== null) {
      if (startedAtMs === null || atMs < startedAtMs) startedAtMs = atMs
      if (lastActivityAtMs === null || atMs > lastActivityAtMs) lastActivityAtMs = atMs
    }

    const payload = asRecord(row.payload)
    if (!payload) return

    if (payload.type === 'agent_message') {
      turnCount += 1
      return
    }

    if (payload.type === 'token_count') {
      const total = asPositiveNumber(asRecord(asRecord(payload.info)?.total_token_usage)?.total_tokens)
      if (total !== null) tokens = total
      return
    }

    if (payload.type === 'task_complete') {
      completedAtMs = atMs
      const error = asRecord(payload.error)
      if (error) {
        failed = true
        errorMessage = asText(error.message)
      } else {
        // A later clean turn supersedes an earlier failed one.
        failed = false
        errorMessage = null
      }
      return
    }

    if (payload.type === 'turn_aborted') {
      interruptedAtMs = atMs
    }
  }

  const snapshot = (): CodexAgentTranscriptSummary => ({
    startedAtMs,
    lastActivityAtMs,
    completedAtMs,
    interruptedAtMs,
    failed,
    errorMessage,
    turnCount,
    tokens
  })

  return { ingest, snapshot }
}

export type CodexAgentSource = {
  spawn: CodexAgentSpawn
  transcriptPath: string
  summary: CodexAgentTranscriptSummary
}

export type BuildCodexAgentRunsInput = {
  sessionId: string
  agents: CodexAgentSource[]
  // Keyed by spawned thread id, from the spawning thread's rollout.
  activity: Map<string, CodexAgentActivity>
  nowMs: number
  stallAfterMs?: number
}

export function buildCodexAgentRuns(input: BuildCodexAgentRunsInput): AgentRun[] {
  const { sessionId, agents, activity, nowMs, stallAfterMs } = input

  return agents.map((agent) => {
    const { spawn, summary } = agent
    const events = activity.get(spawn.threadId)

    // The parent notices the spawn before the child writes anything, so its event
    // dates the run first; the child's own metadata is the fallback.
    const startedAtMs = events?.startedAtMs ?? spawn.startedAtMs ?? summary.startedAtMs
    // Interruption is issued by the parent, so either side may be the one that saw
    // it. Take whichever is present, preferring the child's own abort record.
    const interruptedAtMs = summary.interruptedAtMs ?? events?.interruptedAtMs ?? null

    const lastActivityAtMs = maxOrNull(summary.lastActivityAtMs, events?.lastEventAtMs ?? null)

    const status = resolveAgentStatus({
      completedAtMs: summary.completedAtMs,
      failed: summary.failed,
      interruptedAtMs,
      lastActivityAtMs,
      nowMs,
      stallAfterMs
    })

    const isInternal = spawn.spawnKind !== CODEX_DELEGATED_SPAWN

    // A parent id equal to the session is the session itself, not another agent.
    const parentAgentId =
      spawn.parentThreadId !== null && spawn.parentThreadId !== sessionId ? spawn.parentThreadId : null

    return {
      id: spawn.threadId,
      platform: 'codex',
      sessionId,
      parentAgentId,
      depth: spawn.depth,
      label:
        spawn.nickname ??
        events?.nickname ??
        lastPathSegment(spawn.agentPath ?? events?.agentPath ?? null) ??
        titleCase(isInternal ? spawn.spawnKind : null) ??
        'Agent',
      role: spawn.role ?? events?.role ?? null,
      agentPath: spawn.agentPath ?? events?.agentPath ?? null,
      isInternal,
      startedAtMs,
      lastActivityAtMs,
      status,
      errorMessage: summary.errorMessage,
      tokens: summary.tokens,
      // Codex folds its cached input into the total it reports, so there is no
      // separate cache-read figure to surface.
      cacheReadTokens: null,
      turnCount: summary.turnCount,
      transcriptPath: agent.transcriptPath
    } satisfies AgentRun
  })
}

function maxOrNull(left: number | null, right: number | null): number | null {
  if (left === null) return right
  if (right === null) return left
  return Math.max(left, right)
}

// '/root/fresh_start/collector' reads better as 'collector' on a narrow row, and
// it is the only name a Codex run has when no nickname was assigned.
function lastPathSegment(path: string | null): string | null {
  if (path === null) return null
  const segments = path.split('/').filter((segment) => segment.length > 0)
  return segments.length > 0 ? segments[segments.length - 1] : null
}

// 'guardian' -> 'Guardian'. Only ever applied to an internal spawn kind, so a run
// with no name of its own still says what it is instead of reading 'Agent'.
function titleCase(value: string | null): string | null {
  if (value === null || value.length === 0) return null
  return value.charAt(0).toUpperCase() + value.slice(1)
}
