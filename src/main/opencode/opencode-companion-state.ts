import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_OPENCODE_COMPANION_PREFERENCES,
  parseOpenCodeCompanionPreferences,
  type OpenCodeCompanionPreferences
} from '@shared/opencode'

function preferencePath(): string {
  return join(app.getPath('userData'), 'opencode-companion.json')
}

export function readOpenCodeCompanionPreferences(): OpenCodeCompanionPreferences {
  try {
    return parseOpenCodeCompanionPreferences(JSON.parse(readFileSync(preferencePath(), 'utf-8')))
  } catch {
    return {
      ...DEFAULT_OPENCODE_COMPANION_PREFERENCES,
      target: { ...DEFAULT_OPENCODE_COMPANION_PREFERENCES.target }
    }
  }
}

export function writeOpenCodeCompanionPreferences(preferences: OpenCodeCompanionPreferences): void {
  try {
    const path = preferencePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(preferences, null, 2)}\n`)
  } catch {
    // The companion is optional; a read-only profile must not interrupt Cadence.
  }
}
