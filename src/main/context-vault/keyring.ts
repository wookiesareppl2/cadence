// Pure assembly and validation of the on-vault keyring — the small JSON record stored
// at the vault repo root that lets any device recover the Data Encryption Key (DEK).
// Electron-free (uses only the vault-crypto primitives, which use node:crypto), so the
// whole create → recover → rotate lifecycle is unit-testable without OS keychains or
// the network. Where the keyring is *read from / written to* the GitHub vault is the
// key manager's / sync service's job (Phase 4c), not this module's.
//
// The DEK itself is never present in the keyring — only wraps of it and a check value.

import {
  generateDek,
  generateRecoveryKey,
  makeDekCheck,
  unwrapDekWithRecoveryKey,
  verifyDekCheck,
  wrapDekWithRecoveryKey,
  type DekCheck,
  type GcmCiphertext,
  type RecoveryWrappedDek
} from './vault-crypto'

export type VaultKeyring = {
  version: 1
  // The DEK wrapped by the Recovery Key's KEK — the "write it down" recovery path.
  recovery: RecoveryWrappedDek
  // Lets a device confirm a DEK it unlocked/recovered is the right one before trusting
  // it to decrypt snapshots.
  dekCheck: DekCheck
  // Forward-compatibility: a newer client may add more wraps (e.g. the deferred
  // GitHub-account recovery wrap, decided in Phase 4e). Unknown fields are carried
  // through parse → rotate → serialize verbatim so an older client can never clobber a
  // newer client's recovery path when it rewrites the keyring. The index signature
  // makes that contract explicit rather than relying on runtime spread alone.
  [extraWrap: string]: unknown
}

export type NewVaultKeyMaterial = {
  // The live DEK for this session. The caller stores it on the device (via the key
  // manager) and uses it to encrypt/decrypt snapshots; it is never written to the vault.
  dek: Buffer
  // Shown to the user exactly once, then discarded. Never persisted anywhere.
  recoveryKey: string
  // The record to publish to the vault repo root.
  keyring: VaultKeyring
}

/** Mint a brand-new vault's key material: a random DEK plus its first Recovery Key. */
export function createVaultKeyMaterial(): NewVaultKeyMaterial {
  const dek = generateDek()
  const recoveryKey = generateRecoveryKey()
  return {
    dek,
    recoveryKey,
    keyring: {
      version: 1,
      recovery: wrapDekWithRecoveryKey(dek, recoveryKey),
      dekCheck: makeDekCheck(dek)
    }
  }
}

/**
 * Recover the DEK from the keyring using a user-entered Recovery Key. Throws if the key
 * is wrong (either the wrap fails to unseal or the recovered DEK fails the check value),
 * so a valid-format but incorrect key is rejected rather than returning a bad DEK.
 */
export function unlockKeyringWithRecoveryKey(keyring: VaultKeyring, recoveryKey: string): Buffer {
  const dek = unwrapDekWithRecoveryKey(keyring.recovery, recoveryKey)
  if (!verifyDekCheck(keyring.dekCheck, dek)) {
    throw new Error('That recovery key does not match this vault.')
  }
  return dek
}

/** True when `dek` is the key this vault's snapshots are encrypted with. */
export function dekMatchesKeyring(keyring: VaultKeyring, dek: Buffer): boolean {
  return verifyDekCheck(keyring.dekCheck, dek)
}

/**
 * Issue a new Recovery Key for an existing vault, re-wrapping the same DEK. The old key
 * stops working once the returned keyring is published. Requires the live DEK (only a
 * device that can already unlock the vault may rotate it).
 */
export function rotateRecoveryKey(keyring: VaultKeyring, dek: Buffer): { recoveryKey: string; keyring: VaultKeyring } {
  if (!dekMatchesKeyring(keyring, dek)) {
    throw new Error('Cannot rotate the recovery key without the vault key.')
  }
  const recoveryKey = generateRecoveryKey()
  return { recoveryKey, keyring: { ...keyring, recovery: wrapDekWithRecoveryKey(dek, recoveryKey) } }
}

/** Serialise a keyring for storage in the vault repo. */
export function serializeKeyring(keyring: VaultKeyring): string {
  return JSON.stringify(keyring, null, 2)
}

/** Validate and parse a keyring read from the vault; returns null on anything malformed. */
export function parseKeyring(raw: unknown): VaultKeyring | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  if (record.version !== 1) return null
  const recovery = record.recovery
  if (!isRecoveryWrap(recovery) || !isGcm(record.dekCheck)) return null
  // Spread `record` first so any unknown wraps a newer client wrote are preserved; the
  // validated known fields then override to their narrowed types.
  return { ...record, version: 1, recovery, dekCheck: record.dekCheck }
}

function isGcm(value: unknown): value is GcmCiphertext {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.iv === 'string' && typeof record.tag === 'string' && typeof record.ciphertext === 'string'
  )
}

function isRecoveryWrap(value: unknown): value is RecoveryWrappedDek {
  if (!isGcm(value)) return false
  const record = value as unknown as Record<string, unknown>
  return record.kdf === 'scrypt' && typeof record.salt === 'string'
}
