import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isClaudeTranscriptPath } from '../src/main/sessions/session-service'

const ROOT = join('C:', 'Users', 'me', '.claude', 'projects')

describe('isClaudeTranscriptPath', () => {
  it('accepts a real transcript directly inside a project directory', () => {
    expect(isClaudeTranscriptPath(ROOT, join(ROOT, 'C--Projects-app', 'd329db04.jsonl'))).toBe(true)
  })

  it('rejects claude-flow telemetry that would surface as a phantom "data" project', () => {
    expect(isClaudeTranscriptPath(ROOT, join(ROOT, '.claude-flow', 'data', 'pending-insights.jsonl'))).toBe(false)
  })

  it('rejects subagent sidechain transcripts nested under a session', () => {
    expect(
      isClaudeTranscriptPath(ROOT, join(ROOT, 'C--Projects-app', 'd329db04', 'subagents', 'agent-a1b2.jsonl'))
    ).toBe(false)
  })

  it('rejects a transcript inside a hidden top-level directory', () => {
    expect(isClaudeTranscriptPath(ROOT, join(ROOT, '.hidden', 'session.jsonl'))).toBe(false)
  })

  it('rejects a stray jsonl sitting in the projects root', () => {
    expect(isClaudeTranscriptPath(ROOT, join(ROOT, 'loose.jsonl'))).toBe(false)
  })
})
