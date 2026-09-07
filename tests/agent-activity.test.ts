import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../src/shared/agent-activity'
import {
  AGENT_STALL_AFTER_MS,
  buildAgentTree,
  resolveAgentStatus,
  summariseAgentRuns
} from '../src/shared/agent-activity'
import {
  agentIdFromFilename,
  buildClaudeAgentRuns,
  collectAgentNotifications,
  collectAgentToolUses,
  collectToolResults,
  parseClaudeAgentMeta,
  summariseClaudeAgentTranscript
} from '../src/main/agents/claude-agent-scan'
import {
  buildCodexAgentRuns,
  CODEX_DELEGATED_SPAWN,
  collectCodexSubAgentActivity,
  parseCodexAgentSpawn,
  summariseCodexAgentTranscript
} from '../src/main/agents/codex-agent-scan'

const NOW = Date.parse('2026-09-07T12:00:00.000Z')

function run(overrides: Partial<AgentRun> & Pick<AgentRun, 'id'>): AgentRun {
  return {
    platform: 'claude',
    sessionId: 'session-1',
    parentAgentId: null,
    depth: 1,
    label: 'Agent',
    role: null,
    agentPath: null,
    isInternal: false,
    startedAtMs: null,
    lastActivityAtMs: null,
    status: 'running',
    errorMessage: null,
    tokens: null,
    cacheReadTokens: null,
    turnCount: 0,
    transcriptPath: '/tmp/a.jsonl',
    ...overrides
  }
}

describe('resolveAgentStatus', () => {
  it('reports a run with recent activity and no ending as running', () => {
    const status = resolveAgentStatus({
      completedAtMs: null,
      interruptedAtMs: null,
      lastActivityAtMs: NOW - 30_000,
      nowMs: NOW
    })
    expect(status).toBe('running')
  })

  it('reports a completed run as completed', () => {
    expect(
      resolveAgentStatus({
        completedAtMs: NOW - 60_000,
        interruptedAtMs: null,
        lastActivityAtMs: NOW - 61_000,
        nowMs: NOW
      })
    ).toBe('completed')
  })

  it('separates a failed ending from a clean one', () => {
    expect(
      resolveAgentStatus({
        completedAtMs: NOW - 60_000,
        failed: true,
        interruptedAtMs: null,
        lastActivityAtMs: NOW - 61_000,
        nowMs: NOW
      })
    ).toBe('failed')
  })

  it('takes the LAST terminal record, so an interrupted run that resumed reads as completed', () => {
    expect(
      resolveAgentStatus({
        completedAtMs: NOW - 10_000,
        interruptedAtMs: NOW - 60_000,
        lastActivityAtMs: NOW - 10_000,
        nowMs: NOW
      })
    ).toBe('completed')
  })

  it('takes the LAST terminal record the other way round too', () => {
    expect(
      resolveAgentStatus({
        completedAtMs: NOW - 60_000,
        interruptedAtMs: NOW - 10_000,
        lastActivityAtMs: NOW - 10_000,
        nowMs: NOW
      })
    ).toBe('interrupted')
  })

  it('stops calling a silent run "running" once it passes the stall window', () => {
    const justInside = resolveAgentStatus({
      completedAtMs: null,
      interruptedAtMs: null,
      lastActivityAtMs: NOW - (AGENT_STALL_AFTER_MS - 1_000),
      nowMs: NOW
    })
    const justOutside = resolveAgentStatus({
      completedAtMs: null,
      interruptedAtMs: null,
      lastActivityAtMs: NOW - (AGENT_STALL_AFTER_MS + 1_000),
      nowMs: NOW
    })
    expect(justInside).toBe('running')
    expect(justOutside).toBe('stalled')
  })

  it('treats a run that never wrote anything as stalled, not running', () => {
    expect(
      resolveAgentStatus({ completedAtMs: null, interruptedAtMs: null, lastActivityAtMs: null, nowMs: NOW })
    ).toBe('stalled')
  })
})

describe('buildAgentTree', () => {
  it('nests a run under the agent that spawned it', () => {
    const tree = buildAgentTree([
      run({ id: 'child', parentAgentId: 'parent', depth: 2, startedAtMs: 2 }),
      run({ id: 'parent', startedAtMs: 1 })
    ])

    expect(tree).toHaveLength(1)
    expect(tree[0].id).toBe('parent')
    expect(tree[0].children.map((node) => node.id)).toEqual(['child'])
  })

  it('surfaces an orphan at the root rather than dropping it', () => {
    const tree = buildAgentTree([run({ id: 'child', parentAgentId: 'missing', startedAtMs: 1 })])
    expect(tree.map((node) => node.id)).toEqual(['child'])
  })

  it('does not hang on a parent chain that loops', () => {
    const tree = buildAgentTree([
      run({ id: 'a', parentAgentId: 'b', startedAtMs: 1 }),
      run({ id: 'b', parentAgentId: 'a', startedAtMs: 2 })
    ])
    // Both survive; the loop is broken rather than followed.
    expect(tree.map((node) => node.id).sort()).toEqual(['a', 'b'])
  })

  it('does not nest a run under itself', () => {
    const tree = buildAgentTree([run({ id: 'self', parentAgentId: 'self' })])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(0)
  })

  it('orders siblings oldest first and puts undated runs last', () => {
    const tree = buildAgentTree([
      run({ id: 'undated' }),
      run({ id: 'newer', startedAtMs: 200 }),
      run({ id: 'older', startedAtMs: 100 })
    ])
    expect(tree.map((node) => node.id)).toEqual(['older', 'newer', 'undated'])
  })
})

describe('summariseAgentRuns', () => {
  it('counts only genuinely live runs as running', () => {
    const summary = summariseAgentRuns([
      run({ id: 'a', status: 'running' }),
      run({ id: 'b', status: 'running' }),
      run({ id: 'c', status: 'stalled' }),
      run({ id: 'd', status: 'completed' }),
      run({ id: 'e', status: 'failed' })
    ])
    expect(summary).toEqual({ running: 2, stalled: 1, completed: 1, failed: 1, interrupted: 0, total: 5 })
  })
})

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

describe('parseClaudeAgentMeta', () => {
  it('reads the meta file Claude Code writes beside a subagent transcript', () => {
    const meta = parseClaudeAgentMeta(
      '{"agentType":"general-purpose","description":"Independent merge review","toolUseId":"toolu_01Web","spawnDepth":1}'
    )
    expect(meta).toEqual({
      agentType: 'general-purpose',
      description: 'Independent merge review',
      toolUseId: 'toolu_01Web',
      spawnDepth: 1
    })
  })

  it('keeps a run whose meta omits the depth instead of discarding it', () => {
    expect(parseClaudeAgentMeta('{"description":"x"}')?.spawnDepth).toBe(1)
  })

  it('returns null for a truncated or non-object meta file', () => {
    expect(parseClaudeAgentMeta('{"agentType":')).toBeNull()
    expect(parseClaudeAgentMeta('[]')).toBeNull()
  })
})

describe('agentIdFromFilename', () => {
  it('recognises a subagent transcript', () => {
    expect(agentIdFromFilename('agent-a5f5a9aeeb0436d04.jsonl')).toBe('agent-a5f5a9aeeb0436d04')
  })

  it('ignores the meta file and unrelated transcripts', () => {
    expect(agentIdFromFilename('agent-a5f5a9aeeb0436d04.meta.json')).toBeNull()
    expect(agentIdFromFilename('04bd91fb-cf27-4f17-9e08-648af69f609b.jsonl')).toBeNull()
  })
})

const AGENT_CALL_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-02T01:52:50.000Z',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01Web',
        name: 'Agent',
        input: { description: 'Independent merge review', subagent_type: 'general-purpose' }
      }
    ]
  }
})

const AGENT_RESULT_LINE = JSON.stringify({
  type: 'user',
  timestamp: '2026-09-02T02:02:45.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01Web', content: 'done' }] }
})

describe('collectAgentToolUses', () => {
  it('indexes an Agent call by the tool-use id its meta file points back at', () => {
    const uses = collectAgentToolUses([AGENT_CALL_LINE])
    expect(uses.get('toolu_01Web')).toMatchObject({
      description: 'Independent merge review',
      agentType: 'general-purpose',
      ownerAgentId: null
    })
  })

  it('still reads transcripts from before the tool was renamed from Task', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-02T01:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'toolu_old', name: 'Task', input: { description: 'old' } }] }
    })
    expect(collectAgentToolUses([line]).get('toolu_old')?.description).toBe('old')
  })

  it('attributes a nested call to the agent that made it', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-02T01:55:00.000Z',
      agentId: 'agent-parent',
      message: { content: [{ type: 'tool_use', id: 'toolu_nested', name: 'Agent', input: {} }] }
    })
    expect(collectAgentToolUses([line]).get('toolu_nested')?.ownerAgentId).toBe('agent-parent')
  })

  it('ignores other tools and unparseable lines', () => {
    const bash = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} }] }
    })
    expect(collectAgentToolUses([bash, '{not json', '']).size).toBe(0)
  })
})

describe('collectToolResults', () => {
  it('records the result that proves a run ended', () => {
    const results = collectToolResults([AGENT_RESULT_LINE])
    expect(results.get('toolu_01Web')?.timestampMs).toBe(Date.parse('2026-09-02T02:02:45.000Z'))
    expect(results.get('toolu_01Web')?.isError).toBe(false)
  })

  it('flags an errored result', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-02T02:02:45.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bad', is_error: true, content: 'boom' }] }
    })
    expect(collectToolResults([line]).get('toolu_bad')?.isError).toBe(true)
  })
})

describe('summariseClaudeAgentTranscript', () => {
  it('dates the run from its first and last lines and counts assistant turns', () => {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-09-02T01:52:51.679Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-02T01:55:00.000Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-02T02:02:41.347Z' })
    ]
    const summary = summariseClaudeAgentTranscript(lines)
    expect(summary.startedAtMs).toBe(Date.parse('2026-09-02T01:52:51.679Z'))
    expect(summary.lastActivityAtMs).toBe(Date.parse('2026-09-02T02:02:41.347Z'))
    expect(summary.turnCount).toBe(2)
  })

  it('deduplicates tokens on requestId (DNO-001) instead of inflating the total', () => {
    const usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 }
    const repeated = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-09-02T01:55:00.000Z',
      requestId: 'req_1',
      message: { usage }
    })
    // Claude writes the same request across several rows; summing raw would treble it.
    const summary = summariseClaudeAgentTranscript([repeated, repeated, repeated])
    expect(summary.tokens).toBe(17)
    expect(summary.cacheReadTokens).toBe(3)
  })

  it('keeps cache reads out of the headline total but still reports them', () => {
    // Every turn re-reads the whole cached context. Summing that across a long run
    // is what produced a 33.5M "token" figure for a real 288-turn agent.
    const turn = (requestId: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-02T01:55:00.000Z',
        requestId,
        message: { usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 100_000 } }
      })
    const summary = summariseClaudeAgentTranscript([turn('r1'), turn('r2'), turn('r3')])
    expect(summary.tokens).toBe(18)
    expect(summary.cacheReadTokens).toBe(300_000)
  })

  it('counts distinct requests separately', () => {
    const row = (requestId: string): string =>
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-02T01:55:00.000Z',
        requestId,
        message: { usage: { input_tokens: 10, output_tokens: 0 } }
      })
    expect(summariseClaudeAgentTranscript([row('req_1'), row('req_2')]).tokens).toBe(20)
  })

  it('reports null tokens when the transcript carries no usage at all', () => {
    const summary = summariseClaudeAgentTranscript([JSON.stringify({ type: 'user', timestamp: '2026-09-02T01:00:00Z' })])
    expect(summary.tokens).toBeNull()
  })
})

// The acknowledgement Claude Code writes the moment a background agent is launched.
// Shape taken from a real transcript: it answers the same toolUseId as a genuine
// result and arrives 2.3s after the call, while the agent then ran for nine minutes.
const ASYNC_LAUNCH_ACK_LINE = JSON.stringify({
  type: 'user',
  timestamp: '2026-09-02T01:52:53.000Z',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_01Web',
        content: [{ type: 'text', text: 'Async agent launched successfully. The agent is working in the background.' }]
      }
    ]
  }
})

// How a background agent's completion is actually recorded: a user row carrying a
// task-notification naming the tool-use id.
function notificationLine(toolUseId: string, status: string, timestamp: string): string {
  const body = [
    '<task-notification>',
    '<task-id>aacfd5a</task-id>',
    `<tool-use-id>${toolUseId}</tool-use-id>`,
    `<status>${status}</status>`,
    '<summary>Agent finished</summary>',
    '</task-notification>'
  ].join('\n')
  return JSON.stringify({ type: 'user', timestamp, message: { content: body } })
}

describe('collectAgentNotifications', () => {
  it('reads the tool-use id and status out of a task notification', () => {
    const found = collectAgentNotifications([notificationLine('toolu_01Web', 'completed', '2026-09-02T02:02:45.000Z')])
    expect(found.get('toolu_01Web')).toMatchObject({ status: 'completed' })
    expect(found.get('toolu_01Web')?.timestampMs).toBe(Date.parse('2026-09-02T02:02:45.000Z'))
  })

  it('lets a later notification supersede an earlier one, because an agent can be resumed', () => {
    const found = collectAgentNotifications([
      notificationLine('toolu_01Web', 'failed', '2026-09-02T02:00:00.000Z'),
      notificationLine('toolu_01Web', 'completed', '2026-09-02T02:30:00.000Z')
    ])
    expect(found.get('toolu_01Web')?.status).toBe('completed')
  })

  it('ignores ordinary rows and malformed notifications', () => {
    expect(collectAgentNotifications([AGENT_CALL_LINE, AGENT_RESULT_LINE, '{bad']).size).toBe(0)
    const noStatus = JSON.stringify({
      type: 'user',
      timestamp: '2026-09-02T02:00:00.000Z',
      message: { content: '<task-notification><tool-use-id>toolu_x</tool-use-id></task-notification>' }
    })
    expect(collectAgentNotifications([noStatus]).size).toBe(0)
  })
})

describe('buildClaudeAgentRuns', () => {
  const agent = {
    agentId: 'agent-a5f5',
    transcriptPath: '/p/subagents/agent-a5f5.jsonl',
    meta: parseClaudeAgentMeta(
      '{"agentType":"general-purpose","description":"Independent merge review","toolUseId":"toolu_01Web","spawnDepth":1}'
    ),
    summary: summariseClaudeAgentTranscript([
      JSON.stringify({ type: 'user', timestamp: '2026-09-02T01:52:51.679Z' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-09-02T02:02:41.347Z' })
    ])
  }
  const lastLineAt = Date.parse('2026-09-02T02:02:41.347Z')

  it('reports a run whose spawner has not answered it as still running', () => {
    const [built] = buildClaudeAgentRuns({
      sessionId: 'session-1',
      agents: [agent],
      toolUses: collectAgentToolUses([AGENT_CALL_LINE]),
      toolResults: new Map(),
      notifications: new Map(),
      nowMs: lastLineAt + 30_000
    })

    expect(built.status).toBe('running')
    expect(built.label).toBe('Independent merge review')
    expect(built.role).toBe('general-purpose')
    // The spawning call predates the agent's first line, so it dates the run.
    expect(built.startedAtMs).toBe(Date.parse('2026-09-02T01:52:50.000Z'))
  })

  it('does NOT treat the background-launch acknowledgement as completion', () => {
    // The defect this exists for: the ack answers the same toolUseId within seconds
    // of the call, so any-result-means-done reported every background agent as
    // finished the instant it started, and the running count was permanently zero.
    const [built] = buildClaudeAgentRuns({
      sessionId: 'session-1',
      agents: [agent],
      toolUses: collectAgentToolUses([AGENT_CALL_LINE]),
      toolResults: collectToolResults([ASYNC_LAUNCH_ACK_LINE]),
      notifications: new Map(),
      nowMs: lastLineAt + 30_000
    })
    expect(built.status).toBe('running')
  })

  it('reports completion when the task notification arrives', () => {
    const [built] = buildClaudeAgentRuns({
      sessionId: 'session-1',
      agents: [agent],
      toolUses: collectAgentToolUses([AGENT_CALL_LINE]),
      toolResults: collectToolResults([ASYNC_LAUNCH_ACK_LINE]),
      notifications: collectAgentNotifications([
        notificationLine('toolu_01Web', 'completed', '2026-09-02T02:02:45.000Z')
      ]),
      nowMs: lastLineAt + 30_000
    })
    expect(built.status).toBe('completed')
  })

  it('carries a failed notification through as failed, not completed', () => {
    const [built] = buildClaudeAgentRuns({
      sessionId: 'session-1',
      agents: [agent],
      toolUses: collectAgentToolUses([AGENT_CALL_LINE]),
      toolResults: new Map(),
      notifications: collectAgentNotifications([
        notificationLine('toolu_01Web', 'failed', '2026-09-02T02:02:45.000Z')
      ]),
      nowMs: lastLineAt + 30_000
    })
    expect(built.status).toBe('failed')
  })

  it('still accepts a synchronous result written after the agent stopped writing', () => {
    // A foreground agent's result IS its output and lands after its last line.
    const [built] = buildClaudeAgentRuns({
      sessionId: 'session-1',
      agents: [agent],
      toolUses: collectAgentToolUses([AGENT_CALL_LINE]),
      toolResults: collectToolResults([AGENT_RESULT_LINE]),
      notifications: new Map(),
      nowMs: NOW
    })
    expect(built.status).toBe('completed')
  })

  it('does not leave a long-finished run spinning when nothing was ever recorded', () => {
    const [built] = buildClaudeAgentRuns({
      sessionId: 'session-1',
      agents: [agent],
      toolUses: collectAgentToolUses([AGENT_CALL_LINE]),
      toolResults: new Map(),
      notifications: new Map(),
      nowMs: NOW // days after the transcript's last line
    })
    expect(built.status).toBe('stalled')
  })
})

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

const CODEX_SPAWN_META = {
  id: '019dae00-5ee3-72b0-862a-b944ad4b90d6',
  timestamp: '2026-04-21T03:05:53.173Z',
  cwd: 'c:\\Projects\\Badisa',
  source: {
    subagent: {
      thread_spawn: {
        parent_thread_id: '019dadff-6882-7432-9be9-ba3886e41b42',
        depth: 1,
        agent_path: null,
        agent_nickname: 'Fermat',
        agent_role: 'worker'
      }
    }
  },
  agent_nickname: 'Fermat',
  agent_role: 'worker'
}

describe('parseCodexAgentSpawn', () => {
  it('reads the parentage a spawned Codex thread records about itself', () => {
    const spawn = parseCodexAgentSpawn(CODEX_SPAWN_META)
    expect(spawn).toMatchObject({
      threadId: '019dae00-5ee3-72b0-862a-b944ad4b90d6',
      parentThreadId: '019dadff-6882-7432-9be9-ba3886e41b42',
      depth: 1,
      nickname: 'Fermat',
      role: 'worker'
    })
    expect(spawn?.startedAtMs).toBe(Date.parse('2026-04-21T03:05:53.173Z'))
  })

  it('returns null for an ordinary session, so it is safe to run over every rollout', () => {
    expect(parseCodexAgentSpawn({ id: 'abc', timestamp: '2026-04-21T03:00:00Z', source: 'cli' })).toBeNull()
  })

  it('still recognises an older rollout that only carries parent_thread_id', () => {
    const spawn = parseCodexAgentSpawn({ id: 'abc', parent_thread_id: 'parent-1' })
    expect(spawn?.parentThreadId).toBe('parent-1')
    expect(spawn?.depth).toBe(1)
  })

  it('marks delegated work as a thread spawn', () => {
    expect(parseCodexAgentSpawn(CODEX_SPAWN_META)?.spawnKind).toBe(CODEX_DELEGATED_SPAWN)
  })

  it("keeps Codex's internal guardian spawns and names the kind", () => {
    // 12 of one real session's 16 spawns were this shape — the per-tool-call
    // approval checker. Dropping them would hide real runs; treating them as
    // delegated work would bury the 4 that mattered.
    const spawn = parseCodexAgentSpawn({
      id: 'thread-g',
      timestamp: '2026-07-30T17:25:06.000Z',
      parent_thread_id: 'parent-1',
      source: { subagent: { other: 'guardian' } }
    })
    expect(spawn?.spawnKind).toBe('guardian')
    expect(spawn?.role).toBe('guardian')
  })
})

describe('collectCodexSubAgentActivity', () => {
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-13T04:31:48.840Z',
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        event_id: 'call_1',
        occurred_at_ms: 1783917108840,
        agent_thread_id: 'thread-1',
        agent_path: '/root/start_resume',
        kind: 'started'
      }
    }),
    JSON.stringify({
      timestamp: '2026-07-13T04:35:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'collab_agent_spawn_end',
        new_thread_id: 'thread-1',
        new_agent_nickname: 'Fermat',
        new_agent_role: 'worker'
      }
    }),
    JSON.stringify({
      timestamp: '2026-07-13T04:40:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        occurred_at_ms: 1783918800000,
        agent_thread_id: 'thread-1',
        kind: 'interrupted'
      }
    })
  ]

  it('collects the lifecycle the spawning thread recorded', () => {
    const activity = collectCodexSubAgentActivity(lines)
    const entry = activity.get('thread-1')
    expect(entry?.startedAtMs).toBe(1783917108840)
    expect(entry?.interruptedAtMs).toBe(1783918800000)
    expect(entry?.agentPath).toBe('/root/start_resume')
    expect(entry?.nickname).toBe('Fermat')
    expect(entry?.role).toBe('worker')
  })

  it('keeps the newest event time, not the last one it happened to read', () => {
    const reversed = collectCodexSubAgentActivity([...lines].reverse())
    expect(reversed.get('thread-1')?.lastEventAtMs).toBe(1783918800000)
  })

  it('ignores unrelated rows', () => {
    expect(collectCodexSubAgentActivity(['{bad', JSON.stringify({ type: 'response_item' })]).size).toBe(0)
  })
})

describe('summariseCodexAgentTranscript', () => {
  it('takes the LAST cumulative token total rather than summing the running totals', () => {
    const tokenLine = (total: number): string =>
      JSON.stringify({
        timestamp: '2026-09-01T02:03:12.812Z',
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } } }
      })
    // Codex reports a running total on every turn; summing 100+200+300 would claim
    // 600 tokens for a run that used 300.
    expect(summariseCodexAgentTranscript([tokenLine(100), tokenLine(200), tokenLine(300)]).tokens).toBe(300)
  })

  it('reads an explicit clean ending', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-01T02:35:33.041Z',
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 't1' }
    })
    const summary = summariseCodexAgentTranscript([line])
    expect(summary.completedAtMs).toBe(Date.parse('2026-09-01T02:35:33.041Z'))
    expect(summary.failed).toBe(false)
  })

  it('surfaces the reason a run failed', () => {
    const line = JSON.stringify({
      timestamp: '2026-09-01T02:35:33.041Z',
      type: 'event_msg',
      payload: { type: 'task_complete', error: { message: "You've hit your usage limit." } }
    })
    const summary = summariseCodexAgentTranscript([line])
    expect(summary.failed).toBe(true)
    expect(summary.errorMessage).toBe("You've hit your usage limit.")
  })

  it('lets a later clean turn clear an earlier failure', () => {
    const failed = JSON.stringify({
      timestamp: '2026-09-01T02:30:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete', error: { message: 'transient' } }
    })
    const ok = JSON.stringify({
      timestamp: '2026-09-01T02:40:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_complete' }
    })
    expect(summariseCodexAgentTranscript([failed, ok]).failed).toBe(false)
  })

  it('reads an aborted turn as an interruption', () => {
    const line = JSON.stringify({
      timestamp: '2026-07-14T05:57:36.155Z',
      type: 'event_msg',
      payload: { type: 'turn_aborted', reason: 'interrupted' }
    })
    expect(summariseCodexAgentTranscript([line]).interruptedAtMs).toBe(Date.parse('2026-07-14T05:57:36.155Z'))
  })

  it('counts agent messages as turns', () => {
    const message = JSON.stringify({ timestamp: '2026-09-01T02:03:00Z', payload: { type: 'agent_message' } })
    expect(summariseCodexAgentTranscript([message, message]).turnCount).toBe(2)
  })
})

describe('buildCodexAgentRuns', () => {
  const spawn = parseCodexAgentSpawn(CODEX_SPAWN_META)!

  it('names the run and treats the session itself as no parent agent', () => {
    const [built] = buildCodexAgentRuns({
      sessionId: '019dadff-6882-7432-9be9-ba3886e41b42',
      agents: [
        {
          spawn,
          transcriptPath: '/c/.codex/sessions/rollout-x.jsonl',
          summary: summariseCodexAgentTranscript([
            JSON.stringify({ timestamp: '2026-04-21T03:06:03.035Z', payload: { type: 'agent_message' } })
          ])
        }
      ],
      activity: new Map(),
      nowMs: Date.parse('2026-04-21T03:07:00.000Z')
    })

    expect(built.label).toBe('Fermat')
    expect(built.role).toBe('worker')
    expect(built.platform).toBe('codex')
    expect(built.parentAgentId).toBeNull()
    expect(built.status).toBe('running')
  })

  it('keeps a genuine agent parent for a nested run', () => {
    const [built] = buildCodexAgentRuns({
      sessionId: 'a-different-session',
      agents: [{ spawn, transcriptPath: '/x.jsonl', summary: summariseCodexAgentTranscript([]) }],
      activity: new Map(),
      nowMs: NOW
    })
    expect(built.parentAgentId).toBe('019dadff-6882-7432-9be9-ba3886e41b42')
  })

  it('uses the interruption the parent recorded when the agent never noted it', () => {
    const activity = collectCodexSubAgentActivity([
      JSON.stringify({
        timestamp: '2026-04-21T03:10:00.000Z',
        payload: {
          type: 'sub_agent_activity',
          agent_thread_id: spawn.threadId,
          occurred_at_ms: Date.parse('2026-04-21T03:10:00.000Z'),
          kind: 'interrupted'
        }
      })
    ])

    const [built] = buildCodexAgentRuns({
      sessionId: 'session-1',
      agents: [{ spawn, transcriptPath: '/x.jsonl', summary: summariseCodexAgentTranscript([]) }],
      activity,
      nowMs: NOW
    })
    expect(built.status).toBe('interrupted')
  })

  it('falls back to the agent path when a run has no nickname', () => {
    const pathOnly = parseCodexAgentSpawn({
      id: 'thread-9',
      timestamp: '2026-07-13T04:31:48.840Z',
      source: { subagent: { thread_spawn: { parent_thread_id: 'p', depth: 2, agent_path: '/root/start/collector' } } }
    })!

    const [built] = buildCodexAgentRuns({
      sessionId: 'p',
      agents: [{ spawn: pathOnly, transcriptPath: '/x.jsonl', summary: summariseCodexAgentTranscript([]) }],
      activity: new Map(),
      nowMs: NOW
    })
    expect(built.label).toBe('collector')
    expect(built.depth).toBe(2)
  })

  it('names an internal guardian run rather than calling it "Agent", and flags it', () => {
    const guardian = parseCodexAgentSpawn({
      id: 'thread-g',
      timestamp: '2026-07-30T17:25:06.000Z',
      parent_thread_id: 'session-1',
      source: { subagent: { other: 'guardian' } }
    })!

    const [built] = buildCodexAgentRuns({
      sessionId: 'session-1',
      agents: [{ spawn: guardian, transcriptPath: '/x.jsonl', summary: summariseCodexAgentTranscript([]) }],
      activity: new Map(),
      nowMs: NOW
    })
    expect(built.label).toBe('Guardian')
    expect(built.isInternal).toBe(true)
  })

  it('does not flag delegated work as internal', () => {
    const [built] = buildCodexAgentRuns({
      sessionId: 'session-1',
      agents: [{ spawn, transcriptPath: '/x.jsonl', summary: summariseCodexAgentTranscript([]) }],
      activity: new Map(),
      nowMs: NOW
    })
    expect(built.isInternal).toBe(false)
  })
})
