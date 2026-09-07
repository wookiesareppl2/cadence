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
// The meta file names the run; the transcript dates it. Neither records that the
// run FINISHED — that lives back in the spawning transcript, as the tool result
// answering the meta file's `toolUseId`. So a run is complete exactly when its
// spawner has written a result for it, and still running when it has not.

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

// Index every Agent/Task call a transcript made, keyed by the tool-use id that its
// meta file will point back at. Works on a session transcript and on an agent's
// own transcript alike, which is how nested runs find their parent.
export function collectAgentToolUses(lines: Iterable<string>): Map<string, ClaudeAgentToolUse> {
  const uses = new Map<string, ClaudeAgentToolUse>()

  for (const line of lines) {
    const row = parseLine(line)
    if (!row) continue

    const timestampMs = parseTimestamp(row.timestamp)
    const ownerAgentId = asText(row.agentId)

    for (const block of contentBlocks(row)) {
      if (block.type !== 'tool_use') continue
      const name = asText(block.name)
      if (!name || !AGENT_TOOL_NAMES.has(name)) continue
      const toolUseId = asText(block.id)
      if (!toolUseId) continue

      const input = asRecord(block.input)
      uses.set(toolUseId, {
        toolUseId,
        description: asText(input?.description),
        agentType: asText(input?.subagent_type),
        timestampMs,
        ownerAgentId
      })
    }
  }

  return uses
}

// Index the tool results a transcript wrote. A result answering an Agent call is
// the only on-disk proof that the run ended.
export function collectToolResults(lines: Iterable<string>): Map<string, ClaudeToolResult> {
  const results = new Map<string, ClaudeToolResult>()

  for (const line of lines) {
    const row = parseLine(line)
    if (!row) continue
    const timestampMs = parseTimestamp(row.timestamp)

    for (const block of contentBlocks(row)) {
      if (block.type !== 'tool_result') continue
      const toolUseId = asText(block.tool_use_id)
      if (!toolUseId) continue
      results.set(toolUseId, { toolUseId, timestampMs, isError: block.is_error === true })
    }
  }

  return results
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
  let startedAtMs: number | null = null
  let lastActivityAtMs: number | null = null
  let turnCount = 0
  let sawUsage = false
  let tokens = 0
  let cacheReadTokens = 0
  const countedRequests = new Set<string>()

  for (const line of lines) {
    const row = parseLine(line)
    if (!row) continue

    const timestampMs = parseTimestamp(row.timestamp)
    if (timestampMs !== null) {
      if (startedAtMs === null || timestampMs < startedAtMs) startedAtMs = timestampMs
      if (lastActivityAtMs === null || timestampMs > lastActivityAtMs) lastActivityAtMs = timestampMs
    }

    if (row.type === 'assistant') turnCount += 1

    const usage = asRecord(asRecord(row.message)?.usage)
    if (!usage) continue

    const requestId = asText(row.requestId) ?? asText(row.request_id)
    if (requestId !== null) {
      if (countedRequests.has(requestId)) continue
      countedRequests.add(requestId)
    }

    sawUsage = true
    tokens +=
      numberOr0(usage.input_tokens) +
      numberOr0(usage.output_tokens) +
      numberOr0(usage.cache_creation_input_tokens)
    cacheReadTokens += numberOr0(usage.cache_read_input_tokens)
  }

  return {
    startedAtMs,
    lastActivityAtMs,
    turnCount,
    tokens: sawUsage ? tokens : null,
    cacheReadTokens: sawUsage ? cacheReadTokens : null
  }
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
  nowMs: number
  stallAfterMs?: number
}

export function buildClaudeAgentRuns(input: BuildClaudeAgentRunsInput): AgentRun[] {
  const { sessionId, agents, toolUses, toolResults, nowMs, stallAfterMs } = input

  return agents.map((agent) => {
    const toolUseId = agent.meta?.toolUseId ?? null
    const call = toolUseId === null ? undefined : toolUses.get(toolUseId)
    const result = toolUseId === null ? undefined : toolResults.get(toolUseId)

    // The spawning call is timestamped before the agent writes its first line, so
    // it dates the run more accurately than the transcript does.
    const startedAtMs = call?.timestampMs ?? agent.summary.startedAtMs
    const completedAtMs = result ? (result.timestampMs ?? agent.summary.lastActivityAtMs) : null

    const status = resolveAgentStatus({
      completedAtMs,
      failed: result?.isError === true,
      interruptedAtMs: null,
      lastActivityAtMs: agent.summary.lastActivityAtMs,
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
