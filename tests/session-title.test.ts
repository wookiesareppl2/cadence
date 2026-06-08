import { describe, expect, it } from 'vitest'
import { resolveSessionTitle } from '../src/main/sessions/session-title'

describe('session title resolver', () => {
  it('uses a focused theme when one session area dominates', () => {
    const result = resolveSessionTitle({
      rawTitle: '$start',
      fallbackTitle: 'ai-dashboard',
      messages: [
        { text: '$start', timestampMs: 1 },
        {
          text: 'I realized that when I start a new session, all the session titles will be similar. Do you have any suggestions to improve the session titles?',
          timestampMs: 2
        },
        {
          text: 'The issue with this approach is that I can work on various different things within a session, so session titles need to depict the session overall.',
          timestampMs: 3
        },
        {
          text: 'Will this add significant token usage to the overall use of the program?',
          timestampMs: 4
        },
        { text: 'Proceed as suggested', timestampMs: 3 }
      ]
    })

    expect(result.title).toBe('Session Display Improvements')
    expect(result.inferredTitle).toBe('Session Display Improvements')
  })

  it('uses a general title when the session spans unrelated work areas', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'ai-dashboard',
      messages: [
        { text: 'Please improve the session titles so they explain the overall work better.', timestampMs: 1 },
        { text: 'Can you also theme the scrollbars and clean up the visual elements?', timestampMs: 2 },
        { text: 'The Claude usage notifications keep popping up every few minutes near the usage limit.', timestampMs: 3 },
        { text: 'Now the test run is failing with a TypeScript error that we need to fix.', timestampMs: 4 }
      ]
    })

    expect(result.title).toBe('General Improvements')
    expect(result.inferredTitle).toBe('General Improvements')
  })

  it('keeps a focused title when one area dominates over a minor workflow note', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'ai-dashboard',
      messages: [
        { text: 'Please improve the session titles so they explain the overall work better.', timestampMs: 1 },
        { text: 'The session title display still needs to avoid weak sentence fragments.', timestampMs: 2 },
        { text: 'Once I am done implementing various fixes, I will ask you to package the app update.', timestampMs: 3 }
      ]
    })

    expect(result.title).toBe('Session Display Improvements')
    expect(result.inferredTitle).toBe('Session Display Improvements')
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

    expect(result.title).toBe('Fix Image Hover Animation')
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

    expect(result.title).toBe('Security Review')
  })

  it('ignores subagent notifications when inferring a title', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ea57d',
      messages: [
        {
          text: 'Can you please investigate the duplicate Codex sessions in the ai-dashboard project?',
          timestampMs: 1
        },
        {
          text:
            '<subagent_notification>\n' +
            '{"agent_path":"019e8c08-a9c8-78e1-8b6e-6f276ef0665f","status":{"completed":"Done"}}\n' +
            '</subagent_notification>',
          timestampMs: 2
        }
      ]
    })

    expect(result.title).toBe('Codex Session Filtering')
    expect(result.inferredTitle).toBe('Codex Session Filtering')
  })

  it('falls back when only subagent notifications are available', () => {
    const result = resolveSessionTitle({
      rawTitle: null,
      fallbackTitle: 'Codex 019ea57d',
      messages: [
        {
          text:
            '<subagent_notification>\n' +
            '{"agent_path":"019e8c08-a9c8-78e1-8b6e-6f276ef0665f","status":{"completed":"Done"}}\n' +
            '</subagent_notification>',
          timestampMs: 1
        }
      ]
    })

    expect(result.title).toBe('Codex 019ea57d')
    expect(result.inferredTitle).toBeNull()
  })

  it('ignores weak raw provider titles when no inferred title exists', () => {
    const result = resolveSessionTitle({
      rawTitle: 'Once I am done implementing various fixes,',
      fallbackTitle: 'Claude session',
      messages: [{ text: '/start', timestampMs: 1 }]
    })

    expect(result.title).toBe('Claude session')
    expect(result.rawTitle).toBeNull()
    expect(result.inferredTitle).toBeNull()
  })

  it('ignores negative raw provider fragments when no inferred title exists', () => {
    const result = resolveSessionTitle({
      rawTitle: "I don't want to address any",
      fallbackTitle: 'Claude session',
      messages: [{ text: '/start', timestampMs: 1 }]
    })

    expect(result.title).toBe('Claude session')
    expect(result.rawTitle).toBeNull()
    expect(result.inferredTitle).toBeNull()
  })
})
