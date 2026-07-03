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
  unwrapDekForGithubAccount,
  unwrapDekWithRecoveryKey,
  verifyDekCheck,
  wrapDekForGithubAccount,
  wrapDekWithRecoveryKey,
  type DekCheck,
  type GcmCiphertext,
  type GithubWrappedDek,
  type RecoveryWrappedDek
} from './vault-crypto'

export type VaultKeyring = {
  version: 1
  // The DEK wrapped by the Recovery Key's KEK — the "write it down" recovery path.
  recovery: RecoveryWrappedDek
  // Lets a device confirm a DEK it unlocked/recovered is the right one before trusting
  // it to decrypt snapshots.
  dekCheck: DekCheck
  // Optional GitHub-account recovery: a DEK copy recoverable by signing into GitHub, so
  // losing every device AND the Recovery Key is not a permanent lockout. Owner-approved
  // trade-off (repo access ⟹ context access); see docs/CONTEXT_VAULT.md.
  github?: GithubWrappedDek
  // Forward-compatibility: a newer client may add more wraps. Unknown fields are carried
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

/** True when this keyring carries a GitHub-account recovery wrap. */
export function hasGithubRecovery(keyring: VaultKeyring): boolean {
  return isGithubWrap(keyring.github)
}

/**
 * Add (or replace) the GitHub-account recovery wrap. Requires the live DEK, so only a
 * device that can already unlock the vault may enable it. `accountId` is the account's
 * immutable numeric id.
 */
export function addGithubRecovery(keyring: VaultKeyring, dek: Buffer, accountId: string): VaultKeyring {
  if (!dekMatchesKeyring(keyring, dek)) {
    throw new Error('Cannot enable GitHub recovery without the vault key.')
  }
  return { ...keyring, github: wrapDekForGithubAccount(dek, accountId) }
}

/** Remove the GitHub-account recovery wrap (return to Recovery-Key-only). */
export function removeGithubRecovery(keyring: VaultKeyring): VaultKeyring {
  const next: VaultKeyring = { ...keyring }
  delete next.github
  return next
}

/**
 * Recover the DEK by GitHub account. Throws if this vault has no GitHub recovery, or the
 * account id / wrap doesn't yield the vault's DEK (verified against the check value).
 */
export function unlockKeyringWithGithubAccount(keyring: VaultKeyring, accountId: string): Buffer {
  if (!isGithubWrap(keyring.github)) throw new Error('This vault has no GitHub-account recovery.')
  const dek = unwrapDekForGithubAccount(keyring.github, accountId)
  if (!verifyDekCheck(keyring.dekCheck, dek)) {
    throw new Error('GitHub-account recovery did not match this vault.')
  }
  return dek
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
  // A `github` wrap, if present, must be well-formed; a malformed one is dropped rather
  // than kept as a broken recovery path. Spread `record` first so any *other* unknown
  // wraps a newer client wrote are preserved; validated known fields then override.
  const github = isGithubWrap(record.github) ? record.github : undefined
  return { ...record, version: 1, recovery, dekCheck: record.dekCheck, github }
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

function isGithubWrap(value: unknown): value is GithubWrappedDek {
  if (!isGcm(value)) return false
  const record = value as unknown as Record<string, unknown>
  return record.kdf === 'hkdf-sha256' && typeof record.salt === 'string'
}
