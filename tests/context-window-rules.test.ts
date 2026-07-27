import { describe, expect, it } from 'vitest'
import { contextWindowForModel } from '../src/main/sessions/session-service'

// The context gauge divides the latest turn's prompt size by this window. A model
// that matches no rule falls back to the 200K floor, which reported a healthy
// 321K Opus 5 session as "321K / 200K · 100%" — the gauge claiming the context
// window had been exceeded. Matching on family + version floor keeps the next
// release from repeating it.

describe('context window per model', () => {
  it('gives the current Claude 5 family its 1M window', () => {
    expect(contextWindowForModel('claude-opus-5')).toBe(1_000_000)
    expect(contextWindowForModel('claude-sonnet-5')).toBe(1_000_000)
    expect(contextWindowForModel('claude-fable-5')).toBe(1_000_000)
  })

  it('still covers the Claude 4 family', () => {
    expect(contextWindowForModel('claude-opus-4-8')).toBe(1_000_000)
    expect(contextWindowForModel('claude-opus-4-1-20250805')).toBe(1_000_000)
    expect(contextWindowForModel('claude-sonnet-4-6')).toBe(1_000_000)
  })

  it('keeps the smaller tiers at their real windows', () => {
    // Haiku 4.5 is 200K even though its version is 4 — the haiku rule wins.
    expect(contextWindowForModel('claude-haiku-4-5-20251001')).toBe(200_000)
    expect(contextWindowForModel('claude-3-opus-20240229')).toBe(200_000)
    expect(contextWindowForModel('gpt-5-codex')).toBe(272_000)
  })

  it('does not promote pre-4 Opus/Sonnet to 1M', () => {
    expect(contextWindowForModel('claude-3-5-sonnet-20241022')).toBe(200_000)
    expect(contextWindowForModel('claude-opus-3')).toBe(200_000)
  })

  it('reports nothing when the model is unknown', () => {
    expect(contextWindowForModel(null)).toBeNull()
  })
})
