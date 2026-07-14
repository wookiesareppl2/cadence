import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPENCODE_COMPANION_PREFERENCES,
  parseOpenCodeCompanionPreferences
} from '../src/shared/opencode'

describe('OpenCode Companion preferences', () => {
  it('falls back to a disabled companion for invalid data', () => {
    expect(parseOpenCodeCompanionPreferences(null)).toEqual(DEFAULT_OPENCODE_COMPANION_PREFERENCES)
    expect(parseOpenCodeCompanionPreferences('invalid')).toEqual(DEFAULT_OPENCODE_COMPANION_PREFERENCES)
  })

  it('restores the target and clamps saved window dimensions', () => {
    expect(
      parseOpenCodeCompanionPreferences({
        enabled: true,
        target: {
          sessionId: 'session-1',
          projectId: 'project-1',
          projectName: 'Cadence'
        },
        bounds: { x: 41.4, y: 52.7, width: 120, height: 900 }
      })
    ).toEqual({
      enabled: true,
      target: {
        sessionId: 'session-1',
        projectId: 'project-1',
        projectName: 'Cadence'
      },
      bounds: { x: 41, y: 53, width: 300, height: 720 }
    })
  })

  it('drops malformed target fields and incomplete bounds', () => {
    expect(
      parseOpenCodeCompanionPreferences({
        enabled: 'yes',
        target: { sessionId: 12, projectId: '', projectName: '  ' },
        bounds: { x: 1, y: 2, width: 400 }
      })
    ).toEqual(DEFAULT_OPENCODE_COMPANION_PREFERENCES)
  })
})
