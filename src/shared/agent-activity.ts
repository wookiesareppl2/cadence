import type { PlatformId } from './platform'

// A single spawned agent run — one subagent Claude or Codex started on behalf of
// a session. Both providers record enough on disk to reconstruct this, but they
// record different things, so the provider-specific scanners normalise into this
// shape and nothing downstream needs to know which CLI produced it.
//
// Deliberately NOT blended across providers (DNO-002): a run always carries the
// platform that produced it and the UI keeps the two lists apart. This type is
// the common vocabulary, not a shared pool.
export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'stalled'

export type AgentRun = {
  // Claude: the `agent-<hash>` file stem. Codex: the spawned thread id.
  id: string
  platform: PlatformId
  // The top-level session this run belongs to, however deeply nested it is.
  sessionId: string
  // The agent that spawned this one, or null when the session itself did.
  parentAgentId: string | null
  // 1 for an agent spawned by the session, 2 for one spawned by an agent, ...
  depth: number
  // What to call it in the UI. Claude: the task description. Codex: the nickname.
  label: string
  // Claude: the agent type ('general-purpose'). Codex: the role ('worker').
  role: string | null
  // Codex only: the '/root/parent/child' hierarchy path, when it recorded one.
  agentPath: string | null
  // True for a run the CLI spawned for its own machinery rather than to do
  // delegated work — Codex's per-tool-call 'guardian' approval checker is the case
  // this exists for. These are real runs and are not hidden, but they are far more
  // numerous than the work agents and the UI needs to be able to tell them apart.
  isInternal: boolean
  startedAtMs: number | null
  lastActivityAtMs: number | null
  status: AgentRunStatus
  // Why a failed run failed, when the provider recorded a reason.
  errorMessage: string | null
  // What the run newly consumed. The two providers count slightly differently and
  // this is deliberately NOT reconciled into a fake common unit:
  //   Claude — input + output + cache writes, with cache reads excluded and
  //            reported separately, because a long run re-reads the same cached
  //            context every turn and summing that is not a real quantity.
  //   Codex  — its own cumulative `total_token_usage.total_tokens`, whose input
  //            figure already includes its cached input. `cacheReadTokens` is null.
  tokens: number | null
  cacheReadTokens: number | null
  // Assistant turns written so far — a cheap "is it doing anything" signal.
  turnCount: number
  transcriptPath: string
}

export type AgentRunNode = AgentRun & { children: AgentRunNode[] }

// How long a run may go without writing a single transcript line before we stop
// calling it 'running'. Neither provider writes a reliable "this agent died"
// record, so a session that crashes mid-run would otherwise leave an agent
// spinning forever in the UI. Five minutes is long enough to survive a slow model
// call or a long-running tool and short enough to notice within one coffee.
export const AGENT_STALL_AFTER_MS = 5 * 60_000

export type AgentStatusInput = {
  // When the provider recorded the run finishing, and whether it errored.
  completedAtMs: number | null
  failed?: boolean
  // When the provider recorded the run being interrupted or aborted.
  interruptedAtMs: number | null
  lastActivityAtMs: number | null
  nowMs: number
  stallAfterMs?: number
}

// Terminal states are decided by which one the provider recorded LAST, not by a
// fixed precedence: an agent can be interrupted and then resume to completion, and
// a run that reports both should be read in the order it actually happened. Only
// when nothing terminal was recorded do we fall back to liveness.
export function resolveAgentStatus(input: AgentStatusInput): AgentRunStatus {
  const { completedAtMs, interruptedAtMs, lastActivityAtMs, nowMs } = input
  const stallAfterMs = input.stallAfterMs ?? AGENT_STALL_AFTER_MS

  if (completedAtMs !== null && interruptedAtMs !== null) {
    return completedAtMs >= interruptedAtMs ? (input.failed ? 'failed' : 'completed') : 'interrupted'
  }
  if (completedAtMs !== null) return input.failed ? 'failed' : 'completed'
  if (interruptedAtMs !== null) return 'interrupted'

  // No terminal record. If it has not written anything in a long while we cannot
  // honestly call it running — say so rather than showing a spinner forever.
  if (lastActivityAtMs === null) return 'stalled'
  return nowMs - lastActivityAtMs > stallAfterMs ? 'stalled' : 'running'
}

export function isAgentRunActive(status: AgentRunStatus): boolean {
  return status === 'running'
}

// Nest runs under the agent that spawned them. A run whose parent is missing from
// the set (the parent's files were pruned, or we only scanned part of a session)
// is surfaced at the root rather than silently dropped — an orphan is still a real
// run the user may care about.
//
// Guards against a parent chain that loops back on itself: the ids come from files
// on disk that nothing validates, and a cycle would otherwise hang the walk.
export function buildAgentTree(runs: AgentRun[]): AgentRunNode[] {
  const nodes = new Map<string, AgentRunNode>()
  for (const run of runs) nodes.set(run.id, { ...run, children: [] })

  const roots: AgentRunNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentAgentId === null ? undefined : nodes.get(node.parentAgentId)
    if (!parent || parent.id === node.id || createsCycle(node.id, parent, nodes)) {
      roots.push(node)
      continue
    }
    parent.children.push(node)
  }

  sortNodes(roots)
  return roots
}

function createsCycle(childId: string, parent: AgentRunNode, nodes: Map<string, AgentRunNode>): boolean {
  const seen = new Set<string>([childId])
  let cursor: AgentRunNode | undefined = parent
  while (cursor) {
    if (seen.has(cursor.id)) return true
    seen.add(cursor.id)
    cursor = cursor.parentAgentId === null ? undefined : nodes.get(cursor.parentAgentId)
  }
  return false
}

// Oldest first, so a run list reads in the order the work was actually started.
// Runs with no start time sort last but keep a stable order among themselves.
function sortNodes(nodes: AgentRunNode[]): void {
  nodes.sort((a, b) => {
    const left = a.startedAtMs ?? Number.POSITIVE_INFINITY
    const right = b.startedAtMs ?? Number.POSITIVE_INFINITY
    if (left !== right) return left - right
    return a.id.localeCompare(b.id)
  })
  for (const node of nodes) sortNodes(node.children)
}

export type AgentActivitySummary = {
  running: number
  stalled: number
  completed: number
  failed: number
  interrupted: number
  total: number
}

// One scan of a session's spawned agents, as the renderer receives it.
export type AgentActivityResult = {
  platform: PlatformId
  sessionId: string
  runs: AgentRun[]
  summary: AgentActivitySummary
  scannedAtMs: number
}

// Feeds the titlebar badge. `running` is the number the badge shows, so it counts
// only genuinely live runs — a stalled run is reported separately rather than
// inflating the count with work that may already be dead.
export function summariseAgentRuns(runs: AgentRun[]): AgentActivitySummary {
  const summary: AgentActivitySummary = {
    running: 0,
    stalled: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    total: runs.length
  }
  for (const run of runs) summary[run.status] += 1
  return summary
}
