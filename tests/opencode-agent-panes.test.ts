import { describe, expect, it } from 'vitest'
import { openCodeAgentAttachCommand, openCodeAgentTerminalId } from '../src/shared/opencode'

describe('OpenCode agent pane terminals', () => {
  it('creates a stable worker-safe terminal id for a parent and child session', () => {
    const id = openCodeAgentTerminalId('ses_parent', 'ses_child')

    expect(id).toBe('opencode-agent-ses_parent-ses_child')
    expect(id.length).toBeLessThanOrEqual(128)
  })

  it('bounds and sanitizes unexpected session id characters', () => {
    const id = openCodeAgentTerminalId(`parent:${'x'.repeat(100)}`, `child/${'y'.repeat(100)}`)

    expect(id.length).toBeLessThanOrEqual(128)
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it('shell-quotes the child session id in the attach command', () => {
    expect(openCodeAgentAttachCommand('ses_child')).toBe("opencode --session 'ses_child'")
    expect(openCodeAgentAttachCommand("ses_'$(danger)")).toBe(
      "opencode --session 'ses_'\"'\"'$(danger)'"
    )
  })
})
