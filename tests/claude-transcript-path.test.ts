import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { isClaudeTranscriptPath, projectId } from '../src/main/sessions/session-service'

const ROOT = join('C:', 'Users', 'me', '.claude', 'projects')
const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadence-session-service-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

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

describe('projectId', () => {
  it('folds legacy ai-dashboard session paths into the current Cadence project id', () => {
    const root = tempRoot()
    const legacy = join(root, 'ai-dashboard')
    const cadence = join(root, 'cadence')
    mkdirSync(cadence)
    writeFileSync(join(cadence, 'package.json'), JSON.stringify({ name: 'cadence' }), 'utf-8')

    expect(projectId('claude', legacy)).toBe(`claude:${cadence.toLowerCase()}`)
    expect(projectId('codex', legacy)).toBe(`codex:${cadence.toLowerCase()}`)
  })
})
