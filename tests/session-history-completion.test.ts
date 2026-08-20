import { describe, expect, it } from 'vitest'
import {
  isClaudeFinalAssistantMessage,
  isCodexFinalAssistantMessage
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
})
