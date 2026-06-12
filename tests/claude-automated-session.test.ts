import { describe, expect, it } from 'vitest'
import { isAutomatedSession, isSyntheticUserRow } from '../src/main/sessions/session-service'

describe('isAutomatedSession', () => {
  it('flags Claude Agent SDK entrypoints as automated', () => {
    // e.g. security-review tooling that injects "Review this change for security
    // vulnerabilities" prompts via the Python SDK.
    expect(isAutomatedSession('sdk-py')).toBe(true)
    expect(isAutomatedSession('sdk-ts')).toBe(true)
    expect(isAutomatedSession('SDK-Py')).toBe(true)
  })

  it('keeps interactive sessions (cli / ide)', () => {
    expect(isAutomatedSession('cli')).toBe(false)
    expect(isAutomatedSession('vscode')).toBe(false)
  })

  it('treats a missing entrypoint as interactive (kept)', () => {
    expect(isAutomatedSession(null)).toBe(false)
  })
})

describe('isSyntheticUserRow', () => {
  it('flags slash-command / skill expansions (isMeta)', () => {
    // e.g. the /start skill body "Base directory for this skill… Pass this prompt
    // to the agent…" arrives as a synthetic isMeta user row.
    expect(isSyntheticUserRow({ type: 'user', isMeta: true, message: { content: 'Base directory for this skill: ...' } })).toBe(true)
  })

  it('flags tool results that masquerade as user rows', () => {
    expect(isSyntheticUserRow({ type: 'user', toolUseResult: { ok: true }, message: { content: '...' } })).toBe(true)
    expect(isSyntheticUserRow({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } })).toBe(true)
  })

  it('keeps genuine typed user rows', () => {
    expect(isSyntheticUserRow({ type: 'user', message: { content: 'Please fix the usage bars' } })).toBe(false)
    expect(isSyntheticUserRow({ type: 'user', message: { content: [{ type: 'text', text: 'Fix the scrollbars' }] } })).toBe(false)
  })
})
