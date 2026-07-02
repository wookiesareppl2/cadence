// Per-device custody of the vault Data Encryption Key (DEK). Day-to-day, each device
// unlocks the DEK automatically from this store so the user types nothing; the Recovery
// Key / GitHub-account paths only come into play on a new device or after a reset.
//
// The DEK is at-rest protected by Electron `safeStorage` (OS keychain / DPAPI). If the
// OS has no encryption available we keep the DEK in memory for the session ONLY and
// never write it to disk in plaintext (DNO-011 / guardrail: no DEK in plaintext at
// rest). This mirrors github-auth-service's token handling. There is one DEK per vault
// repo, and effectively one vault per user, so a single device-key file suffices.

import { app, safeStorage } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dekMatchesKeyring, type VaultKeyring } from './keyring'

type StoredDeviceKey = {
  version: 1
  encryptedDek: string // base64 of safeStorage.encryptString(dek-as-base64)
  savedAtMs: number
}

const DEVICE_KEY_VERSION = 1

/** How the DEK is being held this session — surfaced so the UI can warn about memory-only. */
export type DeviceKeyStorage = 'encrypted' | 'memory' | 'none'

// Session cache of the live DEK. Held as a Buffer only in the main process; it is never
// sent to the renderer.
let memoryDek: Buffer | null = null

function deviceKeyPath(): string {
  return join(app.getPath('userData'), 'context-vault-device.json')
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

async function readStore(): Promise<StoredDeviceKey | null> {
  try {
    const parsed = JSON.parse(await readFile(deviceKeyPath(), 'utf-8')) as Partial<StoredDeviceKey>
    if (parsed.version === DEVICE_KEY_VERSION && typeof parsed.encryptedDek === 'string') {
      return parsed as StoredDeviceKey
    }
  } catch {
    // Missing/unreadable device key means this device hasn't unlocked the vault yet.
  }
  return null
}

/**
 * Persist the DEK for automatic unlock on this device. When OS encryption is
 * unavailable the DEK is kept in memory for the session only (returns `memory`); it is
 * never written to disk unencrypted.
 */
export async function storeDeviceDek(dek: Buffer): Promise<DeviceKeyStorage> {
  memoryDek = Buffer.from(dek)
  if (!encryptionAvailable()) return 'memory'

  const encryptedDek = safeStorage.encryptString(dek.toString('base64')).toString('base64')
  const path = deviceKeyPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ version: DEVICE_KEY_VERSION, encryptedDek, savedAtMs: Date.now() }), 'utf-8')
  return 'encrypted'
}

/** Load this device's stored DEK, or null if none is stored / it can't be decrypted. */
export async function loadDeviceDek(): Promise<Buffer | null> {
  if (memoryDek) return Buffer.from(memoryDek)
  const store = await readStore()
  if (!store || !encryptionAvailable()) return null
  try {
    const dekBase64 = safeStorage.decryptString(Buffer.from(store.encryptedDek, 'base64'))
    const dek = Buffer.from(dekBase64, 'base64')
    memoryDek = Buffer.from(dek)
    return dek
  } catch {
    // A key from a different OS user / machine can't be decrypted here — treat as absent.
    return null
  }
}

/** Forget the DEK on this device (sign-out / reset). Does not touch the vault keyring. */
export async function clearDeviceDek(): Promise<void> {
  memoryDek = null
  await rm(deviceKeyPath(), { force: true }).catch(() => undefined)
}

/**
 * Try to unlock the vault automatically from this device's stored DEK, confirming it
 * against the keyring. Returns null when this device has no usable stored key (the
 * caller then falls back to a recovery path). A stored key that doesn't match the
 * keyring (e.g. the vault was reset elsewhere) is discarded rather than trusted.
 */
export async function unlockVaultDek(keyring: VaultKeyring): Promise<Buffer | null> {
  const dek = await loadDeviceDek()
  if (!dek) return null
  if (dekMatchesKeyring(keyring, dek)) return dek
  await clearDeviceDek()
  return null
}

/**
 * Adopt a DEK recovered via the Recovery Key / GitHub-account path onto this device so
 * future unlocks are automatic. Verifies it against the keyring first so a mistaken DEK
 * is never cached. Returns how it ended up stored.
 */
export async function adoptRecoveredDek(keyring: VaultKeyring, dek: Buffer): Promise<DeviceKeyStorage> {
  if (!dekMatchesKeyring(keyring, dek)) {
    throw new Error('Refusing to store a key that does not match this vault.')
  }
  return storeDeviceDek(dek)
}
