import { describe, expect, it } from 'vitest'
import { resolveSessionTitle } from '../src/main/sessions/session-title'

describe('session title resolver', () => {
  it('skips start/proceed boilerplate and uses the latest substantive request', () => {
    const result = resolveSessionTitle({
      rawTitle: '$start',
      fallbackTitle: 'ai-dashboard',
      messages: [
        { text: '$start', timestampMs: 1 },
        {
          text: 'I realized that when I start a new session, all the session titles will be similar. Do you have any suggestions to improve the session titles?',
          timestampMs: 2
        },
        { text: 'Proceed as suggested', timestampMs: 3 }
      ]
    })

    expect(result.title).toBe('Improve session titles')
    expect(result.inferredTitle).toBe('Improve session titles')
  })

  it('extracts Codex IDE request blocks before inferring the title', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019979e6',
      messages: [
        {
          text: '# Context from my IDE setup:\n\n## Active file: Portfolio.tsx\n\n## My request for Codex:\nI need help fixing the image hover animation in my React/TypeScript portfolio component.',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Fix image hover animation')
  })

  it('falls back to the raw title when no better inferred title exists', () => {
    const result = resolveSessionTitle({
      rawTitle: 'Existing provider title',
      fallbackTitle: 'Claude session',
      messages: [{ text: '/start', timestampMs: 1 }]
    })

    expect(result.title).toBe('Existing provider title')
    expect(result.rawTitle).toBe('Existing provider title')
    expect(result.inferredTitle).toBeNull()
  })

  it('keeps code review titles terse without including pasted diffs', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Claude session',
      messages: [
        {
          text: 'Review this change for security vulnerabilities.\n\nChanged files:\n- src/main/index.ts\n\nUnified diff\n@@ -1 +1 @@',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Review security vulnerabilities')
  })
})
