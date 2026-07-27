import { describe, expect, it } from 'vitest'
import { isOpenCodeSessionId } from '../src/shared/opencode'

// The activity panel polls on a timer with whatever session is selected. A session
// selected under Claude or Codex is a UUID, and OpenCode's server rejects any id
// that is not `ses…` with a 500 (`Expected a string starting with "ses"`), so a
// carried-over selection turned every poll into an identical handler error.

describe('OpenCode session id detection', () => {
  it('accepts real OpenCode session ids', () => {
    expect(isOpenCodeSessionId('ses_06cf94579ffetKvMLAgwXbVwZq')).toBe(true)
    expect(isOpenCodeSessionId('ses_05e24f1e7ffeHT4eLj6i8miAsC')).toBe(true)
  })

  it('rejects a Codex/Claude session UUID (the id that caused the 500s)', () => {
    expect(isOpenCodeSessionId('019f6ece-d837-7a12-9ed8-d222cda5293b')).toBe(false)
  })

  it('rejects empty and absent ids without throwing', () => {
    expect(isOpenCodeSessionId(null)).toBe(false)
    expect(isOpenCodeSessionId(undefined)).toBe(false)
    expect(isOpenCodeSessionId('')).toBe(false)
  })
})
