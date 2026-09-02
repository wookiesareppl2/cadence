import { makeProjectRoot, type ProjectRoot } from './project-roots'

export const APP_SETTINGS_VERSION = 1 as const

export type AppSettings = {
  version: typeof APP_SETTINGS_VERSION
  mergeReviewEnabled: boolean
  // The folders the user's projects live inside. Empty means "not configured",
  // which deliberately behaves as it always did: everything discovered is shown.
  // Only a non-empty list narrows the Projects list.
  projectRoots: ProjectRoot[]
}

export type AppSettingsUpdate = {
  mergeReviewEnabled?: boolean
  projectRoots?: ProjectRoot[]
}

// Merge review defaults ON. It is the one setting whose wrong value is silent: a
// user who never opens Settings gets no independent look at a merge, and nothing
// on screen tells them a gate they might have wanted is absent. Defaulting it on
// makes the absent case the deliberate one. An install that already stored a
// preference keeps it — normalizeAppSettings only falls back to this default when
// the stored value is missing or not a boolean.
export const DEFAULT_APP_SETTINGS: AppSettings = Object.freeze({
  version: APP_SETTINGS_VERSION,
  mergeReviewEnabled: true,
  projectRoots: []
})

// Rebuilt through makeProjectRoot rather than trusted as stored: the id and the
// path normalization are derived from the path, so a hand-edited settings file, or
// one written by an older build, still yields roots the matcher can use. Entries
// without a usable path are dropped, and duplicates collapse by id — two spellings
// of one folder must not become two roots that both claim the same projects.
function normalizeProjectRoots(value: unknown): ProjectRoot[] {
  if (!Array.isArray(value)) return []
  const byId = new Map<string, ProjectRoot>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.path !== 'string' || !candidate.path.trim()) continue
    const distro =
      typeof candidate.distro === 'string' && candidate.distro.trim() ? candidate.distro.trim() : null
    const label = typeof candidate.label === 'string' ? candidate.label : undefined
    const root = makeProjectRoot(candidate.path.trim(), distro, label)
    byId.set(root.id, root)
  }
  return [...byId.values()]
}

export function normalizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_APP_SETTINGS }

  const candidate = value as Record<string, unknown>
  return {
    version: APP_SETTINGS_VERSION,
    mergeReviewEnabled:
      typeof candidate.mergeReviewEnabled === 'boolean'
        ? candidate.mergeReviewEnabled
        : DEFAULT_APP_SETTINGS.mergeReviewEnabled,
    projectRoots: normalizeProjectRoots(candidate.projectRoots)
  }
}

export function normalizeAppSettingsUpdate(value: unknown): AppSettingsUpdate {
  if (!value || typeof value !== 'object') return {}
  const candidate = value as Record<string, unknown>
  const update: AppSettingsUpdate = {}
  if (typeof candidate.mergeReviewEnabled === 'boolean') {
    update.mergeReviewEnabled = candidate.mergeReviewEnabled
  }
  // An explicit empty array is a real instruction — "stop narrowing the list" — so
  // it must survive, which is why this checks for the key rather than truthiness.
  if (Array.isArray(candidate.projectRoots)) {
    update.projectRoots = normalizeProjectRoots(candidate.projectRoots)
  }
  return update
}
