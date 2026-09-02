import { describe, expect, it } from 'vitest'
import { PLATFORM_IDS } from '../src/shared/platform'
import {
  launchCommand,
  launchLabel,
  launchSkipLabel,
  resumeCommand,
  resumeSkipLabel,
  skipModeName
} from '../src/shared/ai-launch'

// These strings are typed straight into a live shell, so they are pinned exactly
// rather than pattern-matched. A wrong flag does not fail loudly — the CLI either
// rejects it or, worse, silently starts in a different mode than the button said.
// Both were verified against `claude --help` and `codex resume --help`.
describe('launch commands', () => {
  it('starts each CLI plainly', () => {
    expect(launchCommand('claude')).toBe('claude')
    expect(launchCommand('codex')).toBe('codex')
  })

  it('starts each CLI in its own bypass mode', () => {
    expect(launchCommand('claude', true)).toBe('claude --dangerously-skip-permissions')
    expect(launchCommand('codex', true)).toBe('codex --dangerously-bypass-approvals-and-sandbox')
  })
})

describe('resume commands', () => {
  // Claude takes the id on a flag, Codex on a subcommand. Getting this wrong files
  // new work under the wrong session, which is the failure the resume flow exists
  // to prevent.
  it('rejoins a recorded session the way each CLI expects', () => {
    expect(resumeCommand('claude', 'abc-123')).toBe('claude --resume abc-123')
    expect(resumeCommand('codex', 'abc-123')).toBe('codex resume abc-123')
  })

  it('appends the bypass flag after the resume form, not instead of it', () => {
    expect(resumeCommand('claude', 'abc-123', true)).toBe(
      'claude --resume abc-123 --dangerously-skip-permissions'
    )
    expect(resumeCommand('codex', 'abc-123', true)).toBe(
      'codex resume abc-123 --dangerously-bypass-approvals-and-sandbox'
    )
  })

  it('defaults to the safe mode when no mode is asked for', () => {
    for (const platform of PLATFORM_IDS) {
      expect(resumeCommand(platform, 'id')).toBe(resumeCommand(platform, 'id', false))
      expect(resumeCommand(platform, 'id')).not.toContain('dangerously')
    }
  })
})

describe('labels', () => {
  // Each CLI's own word for the mode, never a house term — it is what the user will
  // search that CLI's own documentation for.
  it('names the bypass mode the way its CLI does', () => {
    expect(skipModeName('claude')).toBe('skip perms')
    expect(skipModeName('codex')).toBe('yolo')
  })

  it('derives the deck and resume labels from that one name', () => {
    expect(launchLabel('claude')).toBe('Launch Claude')
    expect(launchSkipLabel('claude')).toBe('Claude (skip perms)')
    expect(resumeSkipLabel('claude')).toBe('Resume (skip perms)')

    expect(launchLabel('codex')).toBe('Launch Codex')
    expect(launchSkipLabel('codex')).toBe('Codex (yolo)')
    expect(resumeSkipLabel('codex')).toBe('Resume (yolo)')
  })

  it('covers every platform, so a new one cannot ship unlabelled', () => {
    for (const platform of PLATFORM_IDS) {
      expect(skipModeName(platform)).toBeTruthy()
      expect(launchCommand(platform, true)).toContain('dangerous')
    }
  })
})
