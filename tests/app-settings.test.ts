import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_VERSION,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  normalizeAppSettingsUpdate
} from '../src/shared/app-settings'

describe('Cadence application settings', () => {
  it('ships merge review on, and falls back to that default for missing or malformed settings', () => {
    expect(DEFAULT_APP_SETTINGS.mergeReviewEnabled).toBe(true)
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS)
    expect(normalizeAppSettings({ mergeReviewEnabled: 'yes' })).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('keeps an install that deliberately turned merge review off', () => {
    expect(normalizeAppSettings({ mergeReviewEnabled: false }).mergeReviewEnabled).toBe(false)
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
