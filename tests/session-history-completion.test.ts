import { describe, expect, it } from 'vitest'
import {
  completedOpenCodeAssistantText,
  isClaudeFinalAssistantMessage,
  isCodexFinalAssistantMessage,
  isOpenCodeSessionActive
} from '../src/main/sessions/session-history-completion'

describe('session History completion gates', () => {
  it('keeps only completed Claude responses while preserving legacy rows', () => {
    expect(isClaudeFinalAssistantMessage({ stop_reason: 'tool_use' })).toBe(false)
    expect(isClaudeFinalAssistantMessage({ stop_reason: 'pause_turn' })).toBe(false)
    expect(isClaudeFinalAssistantMessage({ stop_reason: null })).toBe(false)
    expect(isClaudeFinalAssistantMessage({ stop_reason: 'end_turn' })).toBe(true)
    expect(isClaudeFinalAssistantMessage({ stop_reason: 'max_tokens' })).toBe(true)
    expect(isClaudeFinalAssistantMessage({})).toBe(true)
  })

  it('keeps Codex final answers and hides commentary', () => {
    expect(isCodexFinalAssistantMessage({ phase: 'commentary' })).toBe(false)
    expect(isCodexFinalAssistantMessage({ phase: 'final_answer' })).toBe(true)
    expect(isCodexFinalAssistantMessage({})).toBe(true)
  })

  it('recognizes OpenCode states that are still changing', () => {
    expect(isOpenCodeSessionActive({ type: 'busy' })).toBe(true)
    expect(isOpenCodeSessionActive({ type: 'retry', attempt: 2 })).toBe(true)
    expect(isOpenCodeSessionActive({ type: 'idle' })).toBe(false)
    expect(isOpenCodeSessionActive(undefined)).toBe(false)
  })

  it('waits for OpenCode completion and returns only text after final task activity', () => {
    const parts = [
      { type: 'text', text: 'I am checking that now.' },
      { type: 'tool', tool: 'shell' },
      { type: 'patch', files: ['src/example.ts'] },
      { type: 'text', text: 'Fixed the issue.' },
      { type: 'text', text: 'All focused tests pass.' }
    ]

    expect(completedOpenCodeAssistantText({ time: { created: 1 } }, parts)).toBeNull()
    expect(completedOpenCodeAssistantText({ time: { created: 1, completed: 2 } }, parts)).toBe(
      'Fixed the issue.\n\nAll focused tests pass.'
    )
  })

  it('does not turn completed OpenCode task-only parts into an assistant reply', () => {
    expect(
      completedOpenCodeAssistantText(
        { time: { created: 1, completed: 2 } },
        [
          { type: 'text', text: 'Running the command.' },
          { type: 'tool', tool: 'shell' },
          { type: 'text', text: 'hidden', ignored: true }
        ]
      )
    ).toBeNull()
  })
})
