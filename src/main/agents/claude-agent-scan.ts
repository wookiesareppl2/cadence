import type { AgentRun } from '@shared/agent-activity'
import { resolveAgentStatus } from '@shared/agent-activity'

// Claude Code writes every subagent it spawns beside the session transcript:
//
//   ~/.claude/projects/<project-slug>/
//     <session-id>.jsonl            the session's own transcript
//     <session-id>/subagents/
//       agent-<hash>.jsonl          the subagent's full transcript
//       agent-<hash>.meta.json      {agentType, description, toolUseId, spawnDepth}
//
// The meta file names the run; the transcript dates it. Neither records that the run
// FINISHED — that lives back in the spawning transcript, and reading it correctly is
// the whole difficulty here.
//
// A tool result answering the meta file's `toolUseId` is NOT proof of completion. An
// agent launched in the background gets an immediate acknowledgement result — on real
// data, 2.3s after the call and 18ms after the agent's first transcript line — while
// the agent then runs for another nine minutes. Treating that as completion reports
// every background agent as finished the instant it starts, which is exactly what the
// first version of this file did.
//
// Two signals, in order:
//
//  1. A `<task-notification>` row in the spawner naming the `tool-use-id` and a
//     `status`. This is what a background agent's completion actually looks like, and
//     it carries the outcome. An agent can be resumed, so the LAST one wins.
//  2. Otherwise a tool result, but only if it does not PREDATE the agent's own last
//     transcript line. A run that kept writing after its result was recorded plainly
//     had not finished when that result was written. This rule is structural rather
//     than a match on the acknowledgement's wording, so a change to that wording
//     cannot silently resurrect the bug.

type UnknownRecord = Record<string, unknown>

const AGENT_FILE = /^agent-([0-9a-zA-Z]+)\.jsonl$/

// The Agent tool was called `Task` before it was renamed. Old transcripts are
// still on disk and still worth reading, so accept both spellings.
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])

export type ClaudeAgentMeta = {
  agentType: string | null
  description: string | null
  toolUseId: string | null
  spawnDepth: number
}

export type ClaudeAgentToolUse = {
  toolUseId: string
  description: string | null
  agentType: string | null
  timestampMs: number | null
  // Which transcript issued the call: null for the session itself, otherwise the
  // agent that spawned this one. This is what gives us nesting.
  ownerAgentId: string | null
}

export type ClaudeToolResult = {
  toolUseId: string
  timestampMs: number | null
  isError: boolean
}

export type ClaudeAgentTranscriptSummary = {
  startedAtMs: number | null
  lastActivityAtMs: number | null
  turnCount: number
  tokens: number | null
  cacheReadTokens: number | null
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
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

function contentBlocks(row: UnknownRecord): UnknownRecord[] {
  const message = asRecord(row.message)
  const content = message?.content
  if (!Array.isArray(content)) return []
  return content.map(asRecord).filter((block): block is UnknownRecord => block !== null)
}

export function agentIdFromFilename(filename: string): string | null {
  const match = filename.match(AGENT_FILE)
  return match ? `agent-${match[1]}` : null
}

export function parseClaudeAgentMeta(raw: string): ClaudeAgentMeta | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) return null

  const depth = record.spawnDepth
  return {
    agentType: asText(record.agentType),
    description: asText(record.description),
    toolUseId: asText(record.toolUseId),
    // A meta file with no depth still describes a real run; treat it as one the
    // session started rather than discarding the run entirely.
    spawnDepth: typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? depth : 1
  }
}

export type ClaudeAgentNotification = {
  toolUseId: string
  timestampMs: number | null
  status: string
}

const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/
const NOTIFICATION_TOOL_USE_ID = /<tool-use-id>\s*([^<\s]+)\s*<\/tool-use-id>/
const NOTIFICATION_STATUS = /<status>\s*([^<\s]+)\s*<\/status>/

// Text content arrives either as a plain string or as an array of blocks; a
// notification row uses the string form.
function rowText(row: UnknownRecord): string | null {
  const content = asRecord(row.message)?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null

  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    const text = record ? asText(record.text) : null
    if (text) parts.push(text)
  }
  return parts.length > 0 ? parts.join('\n') : null
}

// One incremental pass over a transcript, feeding everything we derive from it.
//
// Incremental rather than whole-file for the same reason as the Codex side: a live
// session transcript is appended to constantly and the largest on a real machine is
// 56 MB, so re-reading it every few seconds is work that grows with the session.
// The caller feeds only the bytes appended since last time.
//
// Every accumulator here must be IDEMPOTENT under a repeated line, because the
// reader re-offers an unterminated trailing row on the next read. Timestamps take a
// min/max, tokens dedupe on requestId (DNO-001), maps overwrite by key, and turns
// dedupe on the row's uuid — a plain counter would drift upward on every re-read.
export type ClaudeTranscriptCollector = {
  ingest: (line: string) => void
  snapshot: () => ClaudeAgentTranscriptSummary
  toolUses: Map<string, ClaudeAgentToolUse>
  toolResults: Map<string, ClaudeToolResult>
  notifications: Map<string, ClaudeAgentNotification>
}

export function createClaudeTranscriptCollector(): ClaudeTranscriptCollector {
  const toolUses = new Map<string, ClaudeAgentToolUse>()
  const toolResults = new Map<string, ClaudeToolResult>()
  const notifications = new Map<string, ClaudeAgentNotification>()

  let startedAtMs: number | null = null
  let lastActivityAtMs: number | null = null
  let sawUsage = false
  let tokens = 0
  let cacheReadTokens = 0
  const countedRequests = new Set<string>()
  const countedTurns = new Set<string>()

  const ingest = (line: string): void => {
    const row = parseLine(line)
    if (!row) return

    const timestampMs = parseTimestamp(row.timestamp)
    if (timestampMs !== null) {
      if (startedAtMs === null || timestampMs < startedAtMs) startedAtMs = timestampMs
      if (lastActivityAtMs === null || timestampMs > lastActivityAtMs) lastActivityAtMs = timestampMs
    }

    if (row.type === 'assistant') {
      // Real Claude rows always carry a uuid; falling back to the raw line keeps the
      // count exactly idempotent for anything that does not, rather than drifting
      // upward every time a row is re-offered.
      countedTurns.add(asText(row.uuid) ?? line)
    }

    const ownerAgentId = asText(row.agentId)
    for (const block of contentBlocks(row)) {
      if (block.type === 'tool_use') {
        const name = asText(block.name)
        const toolUseId = asText(block.id)
        if (!name || !toolUseId || !AGENT_TOOL_NAMES.has(name)) continue
        const input = asRecord(block.input)
        toolUses.set(toolUseId, {
          toolUseId,
          description: asText(input?.description),
          agentType: asText(input?.subagent_type),
          timestampMs,
          ownerAgentId
        })
        continue
      }
      if (block.type === 'tool_result') {
        const toolUseId = asText(block.tool_use_id)
        if (!toolUseId) continue
        toolResults.set(toolUseId, { toolUseId, timestampMs, isError: block.is_error === true })
      }
    }

    if (line.includes('<task-notification>')) {
      const text = rowText(row)
      const body = text?.match(TASK_NOTIFICATION)?.[1]
      const toolUseId = body?.match(NOTIFICATION_TOOL_USE_ID)?.[1]
      const status = body?.match(NOTIFICATION_STATUS)?.[1]
      if (toolUseId && status) notifications.set(toolUseId, { toolUseId, timestampMs, status })
    }

    const usage = asRecord(asRecord(row.message)?.usage)
    if (!usage) return

    const requestId = asText(row.requestId) ?? asText(row.request_id)
    if (requestId !== null) {
      if (countedRequests.has(requestId)) return
      countedRequests.add(requestId)
    }

    sawUsage = true
    tokens +=
      numberOr0(usage.input_tokens) + numberOr0(usage.output_tokens) + numberOr0(usage.cache_creation_input_tokens)
    cacheReadTokens += numberOr0(usage.cache_read_input_tokens)
  }

  const snapshot = (): ClaudeAgentTranscriptSummary => ({
    startedAtMs,
    lastActivityAtMs,
    turnCount: countedTurns.size,
    tokens: sawUsage ? tokens : null,
    cacheReadTokens: sawUsage ? cacheReadTokens : null
  })

  return { ingest, snapshot, toolUses, toolResults, notifications }
}

function collectAll(lines: Iterable<string>): ClaudeTranscriptCollector {
  const collector = createClaudeTranscriptCollector()
  for (const line of lines) collector.ingest(line)
  return collector
}

// Index every Agent/Task call a transcript made, keyed by the tool-use id that its
// meta file will point back at. Works on a session transcript and on an agent's
// own transcript alike, which is how nested runs find their parent.
export function collectAgentToolUses(lines: Iterable<string>): Map<string, ClaudeAgentToolUse> {
  return collectAll(lines).toolUses
}

// Index the tool results a transcript wrote. On its own this does NOT prove a run
// ended — see the note at the top of this file.
export function collectToolResults(lines: Iterable<string>): Map<string, ClaudeToolResult> {
  return collectAll(lines).toolResults
}

// Collect the completion notifications a transcript recorded for its background
// agents. A later notification for the same run supersedes an earlier one, because a
// stopped agent can be resumed and will notify again.
export function collectAgentNotifications(lines: Iterable<string>): Map<string, ClaudeAgentNotification> {
  return collectAll(lines).notifications
}

// Date the run and measure what it has spent.
//
// Two rules keep the figure honest, and both were found by running this against
// real transcripts rather than by reasoning about the format:
//
//  1. Deduplicate on requestId (DNO-001). Claude repeats the same request across
//     several transcript rows, and summing them raw multiplies the total.
//
//  2. Keep cache READS out of the headline number. Every turn re-reads the whole
//     cached context, so summing them across a long run counts the same tokens
//     once per turn: a real 288-turn run reported 33.5M that way, which is not a
//     quantity of anything the user would recognise. `tokens` is what the run
//     newly consumed (input + output + cache writes); the cache reads are
//     returned alongside rather than hidden, so nothing is lost.
export function summariseClaudeAgentTranscript(lines: Iterable<string>): ClaudeAgentTranscriptSummary {
  return collectAll(lines).snapshot()
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export type ClaudeAgentSource = {
  agentId: string
  transcriptPath: string
  meta: ClaudeAgentMeta | null
  summary: ClaudeAgentTranscriptSummary
}

export type BuildClaudeAgentRunsInput = {
  sessionId: string
  agents: ClaudeAgentSource[]
  // Agent calls and their results, merged from the session transcript and from
  // every agent transcript, so a nested run resolves against its real spawner.
  toolUses: Map<string, ClaudeAgentToolUse>
  toolResults: Map<string, ClaudeToolResult>
  notifications: Map<string, ClaudeAgentNotification>
  nowMs: number
  stallAfterMs?: number
}

// A tool result written before the agent's own last line cannot mean the agent had
// finished. Allowed slack for the two writes racing at the very end of a run; the
// background-launch acknowledgement this exists to reject predates the last line by
// minutes, not seconds.
const RESULT_ORDERING_SLACK_MS = 2_000

export function buildClaudeAgentRuns(input: BuildClaudeAgentRunsInput): AgentRun[] {
  const { sessionId, agents, toolUses, toolResults, notifications, nowMs, stallAfterMs } = input

  return agents.map((agent) => {
    const toolUseId = agent.meta?.toolUseId ?? null
    const call = toolUseId === null ? undefined : toolUses.get(toolUseId)
    const result = toolUseId === null ? undefined : toolResults.get(toolUseId)
    const notification = toolUseId === null ? undefined : notifications.get(toolUseId)

    // The spawning call is timestamped before the agent writes its first line, so
    // it dates the run more accurately than the transcript does.
    const startedAtMs = call?.timestampMs ?? agent.summary.startedAtMs
    const lastActivityAtMs = agent.summary.lastActivityAtMs

    const resultEndsTheRun =
      result !== undefined &&
      (lastActivityAtMs === null ||
        result.timestampMs === null ||
        result.timestampMs >= lastActivityAtMs - RESULT_ORDERING_SLACK_MS)

    const completedAtMs = notification
      ? (notification.timestampMs ?? lastActivityAtMs)
      : resultEndsTheRun
        ? (result?.timestampMs ?? lastActivityAtMs)
        : null

    const status = resolveAgentStatus({
      completedAtMs,
      failed: notification ? notification.status !== 'completed' : result?.isError === true,
      interruptedAtMs: null,
      lastActivityAtMs,
      nowMs,
      stallAfterMs
    })

    return {
      id: agent.agentId,
      platform: 'claude',
      sessionId,
      parentAgentId: call?.ownerAgentId ?? null,
      depth: agent.meta?.spawnDepth ?? 1,
      label: agent.meta?.description ?? call?.description ?? 'Agent',
      role: agent.meta?.agentType ?? call?.agentType ?? null,
      agentPath: null,
      // Every Claude subagent on disk is a delegated Agent/Task call; the CLI does
      // not spawn internal ones the way Codex does.
      isInternal: false,
      startedAtMs,
      lastActivityAtMs: agent.summary.lastActivityAtMs,
      status,
      errorMessage: null,
      tokens: agent.summary.tokens,
      cacheReadTokens: agent.summary.cacheReadTokens,
      turnCount: agent.summary.turnCount,
      transcriptPath: agent.transcriptPath
    } satisfies AgentRun
  })
}
