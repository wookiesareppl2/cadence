import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionOriginRoot } from '../src/main/sessions/session-origins'
import {
  clearAgentActivityCache,
  scanClaudeAgents,
  scanCodexAgents
} from '../src/main/agents/agent-activity-service'

// These exercise the disk-facing half: finding a session's agents among real
// directories, streaming their transcripts, and reporting a run that is still going
// as running. The parsers are covered separately in agent-activity.test.ts.

const SESSION = '04bd91fb-cf27-4f17-9e08-648af69f609b'
const NOW = Date.parse('2026-09-07T12:00:00.000Z')

function isoBefore(msAgo: number): string {
  return new Date(NOW - msAgo).toISOString()
}

function originFor(home: string): SessionOriginRoot {
  return {
    id: 'windows',
    kind: 'windows',
    label: 'Windows',
    distro: null,
    home,
    claudeProjectsDir: join(home, '.claude', 'projects'),
    codexSessionsDir: join(home, '.codex', 'sessions'),
    codexIndexFile: join(home, '.codex', 'session_index.jsonl')
  }
}

describe('scanClaudeAgents', () => {
  let home: string
  let projectDir: string
  let subagentsDir: string

  beforeEach(async () => {
    clearAgentActivityCache()
    home = await mkdtemp(join(tmpdir(), 'cadence-agents-'))
    projectDir = join(home, '.claude', 'projects', 'C--Projects-cadence')
    subagentsDir = join(projectDir, SESSION, 'subagents')
    await mkdir(subagentsDir, { recursive: true })
    // A decoy project directory that must not be mistaken for the session's own.
    await mkdir(join(home, '.claude', 'projects', 'C--Projects-other'), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeSessionTranscript(rows: unknown[]): Promise<void> {
    await writeFile(join(projectDir, `${SESSION}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8')
  }

  async function writeAgent(id: string, meta: unknown, rows: unknown[]): Promise<void> {
    await writeFile(join(subagentsDir, `${id}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8')
    await writeFile(join(subagentsDir, `${id}.meta.json`), JSON.stringify(meta), 'utf8')
  }

  it('finds a live run and reports it as running', async () => {
    await writeSessionTranscript([
      {
        type: 'assistant',
        timestamp: isoBefore(120_000),
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_live',
              name: 'Agent',
              input: { description: 'Independent merge review', subagent_type: 'general-purpose' }
            }
          ]
        }
      }
      // Deliberately NO tool_result: this is what "still running" looks like on disk.
    ])
    await writeAgent('agent-live', { agentType: 'general-purpose', description: 'Independent merge review', toolUseId: 'toolu_live', spawnDepth: 1 }, [
      { type: 'user', timestamp: isoBefore(115_000) },
      { type: 'assistant', timestamp: isoBefore(10_000), requestId: 'r1', message: { usage: { input_tokens: 40, output_tokens: 12 } } }
    ])

    const runs = await scanClaudeAgents([originFor(home)], SESSION, NOW)

    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('running')
    expect(runs[0].label).toBe('Independent merge review')
    expect(runs[0].tokens).toBe(52)
    expect(runs[0].turnCount).toBe(1)
  })

  it('reports the same run as completed once the session records its result', async () => {
    await writeSessionTranscript([
      {
        type: 'assistant',
        timestamp: isoBefore(120_000),
        message: { content: [{ type: 'tool_use', id: 'toolu_live', name: 'Agent', input: { description: 'Review' } }] }
      },
      {
        type: 'user',
        timestamp: isoBefore(5_000),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_live', content: 'done' }] }
      }
    ])
    await writeAgent('agent-live', { description: 'Review', toolUseId: 'toolu_live', spawnDepth: 1 }, [
      { type: 'user', timestamp: isoBefore(115_000) },
      { type: 'assistant', timestamp: isoBefore(10_000) }
    ])

    const runs = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(runs[0].status).toBe('completed')
  })

  it('nests a run spawned by another agent under it', async () => {
    await writeSessionTranscript([
      {
        type: 'assistant',
        timestamp: isoBefore(200_000),
        message: { content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Agent', input: { description: 'Parent' } }] }
      }
    ])
    await writeAgent('agent-parent', { description: 'Parent', toolUseId: 'toolu_parent', spawnDepth: 1 }, [
      { type: 'user', timestamp: isoBefore(190_000) },
      {
        type: 'assistant',
        timestamp: isoBefore(180_000),
        agentId: 'agent-parent',
        message: { content: [{ type: 'tool_use', id: 'toolu_child', name: 'Agent', input: { description: 'Child' } }] }
      }
    ])
    await writeAgent('agent-child', { description: 'Child', toolUseId: 'toolu_child', spawnDepth: 2 }, [
      { type: 'user', timestamp: isoBefore(175_000) }
    ])

    const runs = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    const child = runs.find((run) => run.id === 'agent-child')
    expect(child?.parentAgentId).toBe('agent-parent')
    expect(runs.find((run) => run.id === 'agent-parent')?.parentAgentId).toBeNull()
  })

  it('keeps a run whose meta file is missing, naming it from the spawning call', async () => {
    await writeSessionTranscript([
      {
        type: 'assistant',
        timestamp: isoBefore(60_000),
        message: {
          content: [{ type: 'tool_use', id: 'toolu_x', name: 'Agent', input: { description: 'Named by the call' } }]
        }
      }
    ])
    await writeFile(join(subagentsDir, 'agent-nometa.jsonl'), JSON.stringify({ type: 'user', timestamp: isoBefore(30_000) }), 'utf8')

    const runs = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(runs).toHaveLength(1)
    // With no meta there is no toolUseId to match, so it falls back to a plain name
    // rather than being dropped.
    expect(runs[0].label).toBe('Agent')
  })

  it('does not re-parse a transcript whose size and mtime are unchanged', async () => {
    await writeSessionTranscript([
      {
        type: 'assistant',
        timestamp: isoBefore(120_000),
        message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Agent', input: { description: 'Cached' } }] }
      }
    ])
    const path = join(subagentsDir, 'agent-cached.jsonl')
    await writeAgent('agent-cached', { description: 'Cached', toolUseId: 'toolu_c', spawnDepth: 1 }, [
      { type: 'assistant', timestamp: isoBefore(60_000) },
      { type: 'assistant', timestamp: isoBefore(30_000) }
    ])

    // Pin the timestamps to a whole second first. A filesystem records sub-millisecond
    // mtimes that `utimes` cannot restore, so without this the restore below lands a
    // fraction away and the cache legitimately misses — the test would then prove
    // nothing about the cache.
    const { readFile, utimes } = await import('node:fs/promises')
    const pinned = new Date(Date.parse('2026-09-07T10:00:00.000Z'))
    await utimes(path, pinned, pinned)

    const first = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(first[0].turnCount).toBe(2)

    // Replace the contents with the same number of bytes and restore the timestamps.
    // Nothing the cache keys on has moved, so a re-parse would be pure waste — and
    // the stale answer coming back is the proof it did not happen.
    const original = await readFile(path, 'utf8')
    await writeFile(path, 'x'.repeat(original.length), 'utf8')
    await utimes(path, pinned, pinned)

    const second = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(second[0].turnCount).toBe(2)

    // And once the cache is dropped, the same file parses to nothing.
    clearAgentActivityCache()
    const third = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(third[0].turnCount).toBe(0)
  })

  it('returns nothing for a session with no subagents directory', async () => {
    await writeSessionTranscript([{ type: 'user', timestamp: isoBefore(1_000) }])
    await rm(join(projectDir, SESSION), { recursive: true, force: true })
    expect(await scanClaudeAgents([originFor(home)], SESSION, NOW)).toEqual([])
  })

  it('re-reads a transcript that grew rather than serving the cached summary', async () => {
    await writeSessionTranscript([
      {
        type: 'assistant',
        timestamp: isoBefore(120_000),
        message: { content: [{ type: 'tool_use', id: 'toolu_g', name: 'Agent', input: { description: 'Growing' } }] }
      }
    ])
    await writeAgent('agent-grow', { description: 'Growing', toolUseId: 'toolu_g', spawnDepth: 1 }, [
      { type: 'assistant', timestamp: isoBefore(90_000), requestId: 'r1', message: { usage: { input_tokens: 10, output_tokens: 0 } } }
    ])

    const first = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(first[0].turnCount).toBe(1)

    await writeAgent('agent-grow', { description: 'Growing', toolUseId: 'toolu_g', spawnDepth: 1 }, [
      { type: 'assistant', timestamp: isoBefore(90_000), requestId: 'r1', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'assistant', timestamp: isoBefore(5_000), requestId: 'r2', message: { usage: { input_tokens: 7, output_tokens: 0 } } }
    ])

    const second = await scanClaudeAgents([originFor(home)], SESSION, NOW)
    expect(second[0].turnCount).toBe(2)
    expect(second[0].tokens).toBe(17)
  })
})

describe('scanCodexAgents', () => {
  let home: string
  let dayDir: string

  const PARENT = '019fb13f-8e61-7331-b259-86422f13e06d'
  const CHILD = '019dae00-5ee3-72b0-862a-b944ad4b90d6'

  beforeEach(async () => {
    clearAgentActivityCache()
    home = await mkdtemp(join(tmpdir(), 'cadence-codex-agents-'))
    dayDir = join(home, '.codex', 'sessions', '2026', '09', '07')
    await mkdir(dayDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeRollout(stamp: string, id: string, rows: unknown[]): Promise<void> {
    await writeFile(
      join(dayDir, `rollout-${stamp}-${id}.jsonl`),
      rows.map((row) => JSON.stringify(row)).join('\n'),
      'utf8'
    )
  }

  it('finds a spawned thread and reports a live one as running', async () => {
    await writeRollout('2026-09-07T11-00-00', PARENT, [
      { type: 'session_meta', timestamp: isoBefore(3_600_000), payload: { id: PARENT, timestamp: isoBefore(3_600_000) } },
      {
        timestamp: isoBefore(300_000),
        type: 'event_msg',
        payload: {
          type: 'sub_agent_activity',
          agent_thread_id: CHILD,
          occurred_at_ms: NOW - 300_000,
          agent_path: '/root/worker',
          kind: 'started'
        }
      }
    ])
    await writeRollout('2026-09-07T11-55-00', CHILD, [
      {
        type: 'session_meta',
        timestamp: isoBefore(299_000),
        payload: {
          id: CHILD,
          timestamp: isoBefore(299_000),
          source: {
            subagent: {
              thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_nickname: 'Fermat', agent_role: 'worker' }
            }
          }
        }
      },
      { timestamp: isoBefore(20_000), type: 'event_msg', payload: { type: 'agent_message' } },
      {
        timestamp: isoBefore(15_000),
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 4_200 } } }
      }
      // No task_complete: still running.
    ])

    const runs = await scanCodexAgents([originFor(home)], PARENT, NOW)

    expect(runs).toHaveLength(1)
    expect(runs[0].label).toBe('Fermat')
    expect(runs[0].status).toBe('running')
    expect(runs[0].tokens).toBe(4_200)
    expect(runs[0].isInternal).toBe(false)
  })

  it('ignores a rollout that started before the session, which cannot be its child', async () => {
    await writeRollout('2026-09-07T11-00-00', PARENT, [
      { type: 'session_meta', timestamp: isoBefore(3_600_000), payload: { id: PARENT } }
    ])
    // Same claimed parent, but filed earlier than the parent's own start.
    await writeRollout('2026-09-07T09-00-00', CHILD, [
      {
        type: 'session_meta',
        timestamp: isoBefore(7_200_000),
        payload: { id: CHILD, source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } } }
      }
    ])

    expect(await scanCodexAgents([originFor(home)], PARENT, NOW)).toEqual([])
  })

  it('flags an internal guardian spawn without dropping it', async () => {
    await writeRollout('2026-09-07T11-00-00', PARENT, [
      { type: 'session_meta', timestamp: isoBefore(3_600_000), payload: { id: PARENT } }
    ])
    await writeRollout('2026-09-07T11-30-00', CHILD, [
      {
        type: 'session_meta',
        timestamp: isoBefore(1_800_000),
        payload: { id: CHILD, parent_thread_id: PARENT, source: { subagent: { other: 'guardian' } } }
      },
      { timestamp: isoBefore(1_700_000), type: 'event_msg', payload: { type: 'task_complete' } }
    ])

    const runs = await scanCodexAgents([originFor(home)], PARENT, NOW)
    expect(runs).toHaveLength(1)
    expect(runs[0].isInternal).toBe(true)
    expect(runs[0].label).toBe('Guardian')
    expect(runs[0].status).toBe('completed')
  })

  it('returns nothing when the session is not a Codex rollout here', async () => {
    expect(await scanCodexAgents([originFor(home)], 'not-a-session', NOW)).toEqual([])
  })
})
