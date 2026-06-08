import { describe, expect, it } from 'vitest'
import { isAutomatedSession } from '../src/main/sessions/session-service'

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
