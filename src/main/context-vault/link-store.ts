// Local, per-device store mapping a project (by Cadence projectId) to its vault
// identity. GitHub-backed projects derive their id from the remote and need no stored
// link to *match* across devices, but we still record one so the vault index has a
// label. Non-GitHub projects get a generated `local__<uuid>` id persisted here, which
// is what makes the same folder reconcile to the same vault entry on this device over
// time. Electron-free (node fs/path only) so it is unit-testable with a temp file.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { generateVaultProjectId, vaultEntryLabel } from '@shared/context-vault'

export type VaultLinkSource = 'github' | 'local'

export type VaultLink = {
  vaultId: string
  label: string
  source: VaultLinkSource
  createdAt: string
  // Sync state: the snapshot this device last synced/restored from (its "base"),
  // a content fingerprint at that point (to detect local changes since), and when.
  baseSnapshot?: string | null
  baseFingerprint?: string | null
  lastSyncedAt?: string | null
}

/**
 * Deterministic content fingerprint of the bundled context files. Order-independent
 * (sorted by path) and includes path + byte length + text so any edit changes it.
 * Used to tell whether local context drifted from the last synced snapshot.
 */
export function fingerprintFiles(files: Array<{ path: string; text: string }>): string {
  const hash = createHash('sha256')
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(String(Buffer.byteLength(file.text, 'utf-8')))
    hash.update('\0')
    hash.update(file.text)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export type VaultLinkStore = {
  version: 1
  links: Record<string, VaultLink>
}

function emptyStore(): VaultLinkStore {
  return { version: 1, links: {} }
}

export async function readLinkStore(storePath: string): Promise<VaultLinkStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath, 'utf-8')) as Partial<VaultLinkStore>
    if (parsed && parsed.version === 1 && parsed.links && typeof parsed.links === 'object') {
      return { version: 1, links: parsed.links as Record<string, VaultLink> }
    }
  } catch {
    // Missing or corrupt store reads as empty (signed-out / first run).
  }
  return emptyStore()
}

export async function writeLinkStore(storePath: string, store: VaultLinkStore): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true })
  await writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8')
}

export async function getVaultLink(storePath: string, projectId: string): Promise<VaultLink | null> {
  const store = await readLinkStore(storePath)
  return store.links[projectId] ?? null
}

export async function setVaultLink(storePath: string, projectId: string, link: VaultLink): Promise<void> {
  const store = await readLinkStore(storePath)
  store.links[projectId] = link
  await writeLinkStore(storePath, store)
}

/**
 * Record the snapshot this device just synced to / restored from, so later status
 * checks can tell whether the vault has moved on and whether local context changed.
 * No-op if the project has no link yet (resolveProjectVaultId creates one first).
 */
export async function recordVaultSync(
  storePath: string,
  projectId: string,
  update: { snapshot: string; fingerprint: string; at: string }
): Promise<void> {
  const store = await readLinkStore(storePath)
  const existing = store.links[projectId]
  if (!existing) return
  store.links[projectId] = {
    ...existing,
    baseSnapshot: update.snapshot,
    baseFingerprint: update.fingerprint,
    lastSyncedAt: update.at
  }
  await writeLinkStore(storePath, store)
}

/**
 * Resolve the vault id for a project, persisting a generated id on first use for
 * non-GitHub projects. A GitHub remote key is authoritative and stable across devices;
 * otherwise a previously-linked id is reused; otherwise a new `local__<uuid>` is minted
 * and stored so subsequent syncs on this device reconcile to the same vault entry.
 */
export async function resolveProjectVaultId(
  storePath: string,
  input: { projectId: string; projectName: string; gitHubKey?: string | null }
): Promise<{ id: string; source: VaultLinkSource; created: boolean; label: string }> {
  const label = vaultEntryLabel(input.projectName)
  const now = new Date().toISOString()

  const gitHubKey = input.gitHubKey?.trim()
  if (gitHubKey) {
    // GitHub key is the source of truth; keep the recorded label fresh.
    await setVaultLink(storePath, input.projectId, { vaultId: gitHubKey, label, source: 'github', createdAt: now })
    return { id: gitHubKey, source: 'github', created: false, label }
  }

  const existing = await getVaultLink(storePath, input.projectId)
  if (existing) return { id: existing.vaultId, source: existing.source, created: false, label: existing.label }

  const id = generateVaultProjectId()
  await setVaultLink(storePath, input.projectId, { vaultId: id, label, source: 'local', createdAt: now })
  return { id, source: 'local', created: true, label }
}
