import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_VERSION,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  normalizeAppSettingsUpdate
} from '../src/shared/app-settings'

describe('Cadence application settings', () => {
  it('defaults merge review off for missing or malformed settings', () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS)
    expect(normalizeAppSettings({ mergeReviewEnabled: 'yes' })).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('preserves a valid merge-review preference while normalizing the schema version', () => {
    expect(normalizeAppSettings({ version: 99, mergeReviewEnabled: true })).toEqual({
      version: APP_SETTINGS_VERSION,
      mergeReviewEnabled: true
    })
  })

  it('accepts only boolean setting updates', () => {
    expect(normalizeAppSettingsUpdate({ mergeReviewEnabled: true })).toEqual({ mergeReviewEnabled: true })
    expect(normalizeAppSettingsUpdate({ mergeReviewEnabled: 'true' })).toEqual({})
    expect(normalizeAppSettingsUpdate(null)).toEqual({})
  })
})
