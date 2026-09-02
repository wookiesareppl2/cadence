export const APP_SETTINGS_VERSION = 1 as const

export type AppSettings = {
  version: typeof APP_SETTINGS_VERSION
  mergeReviewEnabled: boolean
}

export type AppSettingsUpdate = {
  mergeReviewEnabled?: boolean
}

// Merge review defaults ON. It is the one setting whose wrong value is silent: a
// user who never opens Settings gets no independent look at a merge, and nothing
// on screen tells them a gate they might have wanted is absent. Defaulting it on
// makes the absent case the deliberate one. An install that already stored a
// preference keeps it — normalizeAppSettings only falls back to this default when
// the stored value is missing or not a boolean.
export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  version: APP_SETTINGS_VERSION,
  mergeReviewEnabled: true
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
