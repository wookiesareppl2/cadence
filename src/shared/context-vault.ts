// Pure, Electron-free core for the cross-device Context Vault. Identity resolution and
// drift detection live here so they are unit-testable without any network, auth, or
// filesystem. See docs/CONTEXT_VAULT.md for the full design.

/** How a project's vault identity was resolved. */
export type VaultProjectIdSource = 'github' | 'linked' | 'unlinked'

export type VaultProjectResolution = {
  /** Stable, device-independent vault id, or null when the project isn't linkable yet. */
  id: string | null
  source: VaultProjectIdSource
}

/**
 * Device-independent vault key for a GitHub-backed project. Every device agrees on
 * this without any setup because it derives only from the remote's owner/repo, never
 * the local path. Mirrors the existing `GitHubRepositoryIdentity.key` scheme so vaults
 * written by the current code reconcile with the new identity model.
 */
export function gitHubVaultKey(owner: string, repo: string): string {
  const cleanOwner = owner.trim().toLowerCase()
  const cleanRepo = repo
    .trim()
    .replace(/\.git$/i, '')
    .toLowerCase()
  return `github.com__${cleanOwner}__${cleanRepo}`
}

/**
 * Resolve the vault id for a project. A GitHub remote is the natural cross-device key;
 * otherwise a previously-established local link id is used; otherwise the project is
 * "unlinked" and needs a one-time link on this device before it can sync.
 */
export function resolveVaultProjectId(input: {
  gitHubKey?: string | null
  linkedId?: string | null
}): VaultProjectResolution {
  if (input.gitHubKey && input.gitHubKey.trim()) return { id: input.gitHubKey.trim(), source: 'github' }
  if (input.linkedId && input.linkedId.trim()) return { id: input.linkedId.trim(), source: 'linked' }
  return { id: null, source: 'unlinked' }
}

/** A generated id for a non-GitHub project, persisted locally and recorded in the index. */
export function generateVaultProjectId(): string {
  // randomUUID is available in both Node (main) and the renderer (Chromium).
  const id = globalThis.crypto?.randomUUID?.()
  if (id) return `local__${id}`
  // Deterministic fallback (should never run in practice) keeps the module pure/total.
  return `local__${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A short, human-friendly label for a vault entry (folder basename, sanitised). */
export function vaultEntryLabel(projectName: string): string {
  const trimmed = projectName.trim().replace(/[\r\n\t]+/g, ' ')
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed || 'Untitled project'
}

export type VaultIndexEntry = {
  id: string
  label: string
  /** A hint of where this project last lived (display only; never used for identity). */
  sourcePathHint: string | null
  lastSyncedAt: string | null
}

export type VaultIndex = {
  version: 1
  entries: VaultIndexEntry[]
}

export function emptyVaultIndex(): VaultIndex {
  return { version: 1, entries: [] }
}

/** Immutably insert or update an index entry, keyed by id; newest-synced first. */
export function upsertVaultIndexEntry(index: VaultIndex, entry: VaultIndexEntry): VaultIndex {
  const others = index.entries.filter((existing) => existing.id !== entry.id)
  const merged = [entry, ...others]
  merged.sort((a, b) => (b.lastSyncedAt ?? '').localeCompare(a.lastSyncedAt ?? ''))
  return { version: 1, entries: merged }
}

/** Suggest an existing vault entry to link a local folder to, by matching id then label. */
export function suggestVaultLink(
  index: VaultIndex,
  candidate: { id?: string | null; projectName: string }
): VaultIndexEntry | null {
  if (candidate.id) {
    const byId = index.entries.find((entry) => entry.id === candidate.id)
    if (byId) return byId
  }
  const label = vaultEntryLabel(candidate.projectName).toLowerCase()
  return index.entries.find((entry) => entry.label.toLowerCase() === label) ?? null
}

/**
 * Sync state of a project relative to the vault. `base` is the snapshot this device
 * last restored/synced from; `remoteLatest` is the vault's current latest snapshot.
 * This is the heart of drift safety: a `conflict` must never be resolved by a blind
 * overwrite — the caller has to ask the user.
 */
export type VaultDivergence = 'uninitialized' | 'in-sync' | 'local-ahead' | 'remote-ahead' | 'conflict'

/**
 * Has the local context changed since the snapshot this device last synced/restored?
 * With no recorded base (never synced on this device), any local content counts as an
 * unsynced change so the user is prompted rather than silently overwritten.
 */
export function localContextChanged(baseFingerprint: string | null, localFingerprint: string): boolean {
  if (baseFingerprint == null) return localFingerprint.length > 0
  return localFingerprint !== baseFingerprint
}

/**
 * The project's sync state, from fingerprints + the vault's latest snapshot id. Thin
 * wrapper over detectDivergence that derives `localChanged` from content fingerprints
 * so callers don't reimplement it. `not-connected` (no link / signed out) is a caller
 * concern layered on top.
 */
export function computeVaultStatus(input: {
  base: string | null
  baseFingerprint: string | null
  localFingerprint: string
  remoteLatest: string | null
}): VaultDivergence {
  return detectDivergence({
    base: input.base,
    remoteLatest: input.remoteLatest,
    localChanged: localContextChanged(input.baseFingerprint, input.localFingerprint)
  })
}

export function detectDivergence(input: {
  base: string | null
  remoteLatest: string | null
  localChanged: boolean
}): VaultDivergence {
  const { base, remoteLatest, localChanged } = input

  // Nothing anywhere yet.
  if (!base && !remoteLatest) return 'uninitialized'

  // This device has never synced but a remote snapshot exists.
  if (!base && remoteLatest) return localChanged ? 'conflict' : 'remote-ahead'

  // We have a base but the remote is (somehow) empty — treat local as the source.
  if (base && !remoteLatest) return 'local-ahead'

  // Both present: has the remote advanced past our base?
  if (base === remoteLatest) return localChanged ? 'local-ahead' : 'in-sync'
  return localChanged ? 'conflict' : 'remote-ahead'
}
