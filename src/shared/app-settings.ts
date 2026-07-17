export const APP_SETTINGS_VERSION = 1 as const

export type AppSettings = {
  version: typeof APP_SETTINGS_VERSION
  mergeReviewEnabled: boolean
}

export type AppSettingsUpdate = {
  mergeReviewEnabled?: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  version: APP_SETTINGS_VERSION,
  mergeReviewEnabled: false
})

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_APP_SETTINGS }

  const candidate = value as Record<string, unknown>
  return {
    version: APP_SETTINGS_VERSION,
    mergeReviewEnabled:
      typeof candidate.mergeReviewEnabled === 'boolean'
        ? candidate.mergeReviewEnabled
        : DEFAULT_APP_SETTINGS.mergeReviewEnabled
  }
}

export function normalizeAppSettingsUpdate(value: unknown): AppSettingsUpdate {
  if (!value || typeof value !== 'object') return {}
  const candidate = value as Record<string, unknown>
  return typeof candidate.mergeReviewEnabled === 'boolean'
    ? { mergeReviewEnabled: candidate.mergeReviewEnabled }
    : {}
}
