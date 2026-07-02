// Pure crypto primitives for the Context Vault's recoverable-key model. Lives in the
// main process because key material must never reach the renderer (DNO-011); it uses
// only `node:crypto` (no Electron), so it is unit-testable in the node test env.
//
// Model (see docs/CONTEXT_VAULT.md):
//   - A random 32-byte Data Encryption Key (DEK) encrypts every snapshot (AES-256-GCM).
//   - The DEK is never stored in plaintext by this module. It is *wrapped* by a Key
//     Encryption Key (KEK). One KEK comes from a high-entropy Recovery Key (scrypt).
//     Per-device auto-unlock (Electron safeStorage) and the GitHub-account recovery
//     path are policy layered on top by the key manager — not decided here.
//   - An integrity check value lets a recovered DEK be verified before it is trusted.
//
// This module holds *primitives* only: it takes/returns Buffers and plain records and
// makes no decision about where wrapped keys are stored. That keeps the crypto neutral
// on the one storage-policy decision deferred to the Phase 4e security review.

import { createCipheriv, createDecipheriv, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto'

const DEK_BYTES = 32 // AES-256 key size
const KEK_BYTES = 32
const IV_BYTES = 12 // 96-bit nonce, the standard for AES-GCM
const RECOVERY_SALT_BYTES = 16

// scrypt cost. The Recovery Key is high-entropy (160 bits) so it does not need
// password-grade hardening, but recovery is rare, so a firm cost is cheap insurance.
const SCRYPT_N = 1 << 15 // 32768
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_MAXMEM = 64 * 1024 * 1024

// Crockford base32 without the ambiguous I, L, O, U. 32 symbols → 5 bits each.
const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const RECOVERY_GROUPS = 8
const RECOVERY_GROUP_LEN = 4 // 8 × 4 = 32 symbols × 5 bits = 160 bits of entropy

// A fixed marker encrypted under the DEK; decrypting it back to this proves a candidate
// DEK is the right one before any snapshot is trusted/restored.
const DEK_CHECK_MARKER = 'cadence-context-vault/dek-check/v1'

/** AES-256-GCM ciphertext with its nonce and auth tag, all base64. */
export type GcmCiphertext = {
  iv: string
  tag: string
  ciphertext: string
}

/** A snapshot payload encrypted directly with the DEK (no per-snapshot KDF). */
export type EncryptedSnapshotV2 = {
  version: 2
  algorithm: 'aes-256-gcm'
} & GcmCiphertext

/** The DEK wrapped by a Recovery-Key-derived KEK, carrying the scrypt salt to redo it. */
export type RecoveryWrappedDek = {
  kdf: 'scrypt'
  salt: string
} & GcmCiphertext

/** Verifies a candidate DEK without needing a real snapshot. */
export type DekCheck = GcmCiphertext

function encryptGcm(plaintext: Buffer, key: Buffer): GcmCiphertext {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

// Throws if the key is wrong or the ciphertext/tag was tampered with (GCM auth failure).
function decryptGcm(payload: GcmCiphertext, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()])
}

/** A fresh, cryptographically random Data Encryption Key. */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES)
}

/** Encrypt a snapshot payload (already-serialised bundle JSON) with the DEK. */
export function encryptBundleWithDek(bundleJson: string, dek: Buffer): EncryptedSnapshotV2 {
  assertKeyLength(dek, DEK_BYTES, 'DEK')
  return { version: 2, algorithm: 'aes-256-gcm', ...encryptGcm(Buffer.from(bundleJson, 'utf-8'), dek) }
}

/** Decrypt a snapshot back to its bundle JSON. Throws on a wrong DEK or tampering. */
export function decryptBundleWithDek(snapshot: EncryptedSnapshotV2, dek: Buffer): string {
  if (snapshot.version !== 2 || snapshot.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported context snapshot format.')
  }
  assertKeyLength(dek, DEK_BYTES, 'DEK')
  return decryptGcm(snapshot, dek).toString('utf-8')
}

/**
 * A new high-entropy Recovery Key, formatted `XXXX-XXXX-…` for the user to write down.
 * Uniform selection over the 32-symbol alphabet via rejection-free `randomInt`.
 */
export function generateRecoveryKey(): string {
  const groups: string[] = []
  for (let g = 0; g < RECOVERY_GROUPS; g += 1) {
    let group = ''
    for (let c = 0; c < RECOVERY_GROUP_LEN; c += 1) {
      group += RECOVERY_ALPHABET[randomInt(0, RECOVERY_ALPHABET.length)]
    }
    groups.push(group)
  }
  return groups.join('-')
}

/**
 * Canonicalise a user-entered Recovery Key: drop separators/whitespace, uppercase, and
 * fold the Crockford-ambiguous characters (I/L→1, O→0) so honest transcription slips
 * still unlock. Returns null when it isn't a valid 32-symbol key.
 */
export function normalizeRecoveryKey(input: string): string | null {
  const folded = input
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
  if (folded.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LEN) return null
  for (const ch of folded) {
    if (!RECOVERY_ALPHABET.includes(ch)) return null
  }
  return folded
}

/** Derive the 32-byte KEK from a (raw or formatted) Recovery Key and its salt. */
export function deriveKekFromRecoveryKey(recoveryKey: string, salt: Buffer): Buffer {
  const normalized = normalizeRecoveryKey(recoveryKey)
  if (!normalized) throw new Error('Invalid recovery key.')
  return scryptSync(normalized, salt, KEK_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  })
}

/** Wrap the DEK for storage in the vault keyring, protected by a Recovery Key. */
export function wrapDekWithRecoveryKey(dek: Buffer, recoveryKey: string): RecoveryWrappedDek {
  assertKeyLength(dek, DEK_BYTES, 'DEK')
  const salt = randomBytes(RECOVERY_SALT_BYTES)
  const kek = deriveKekFromRecoveryKey(recoveryKey, salt)
  return { kdf: 'scrypt', salt: salt.toString('base64'), ...encryptGcm(dek, kek) }
}

/** Recover the DEK from a Recovery-Key wrap. Throws on a wrong key or tampering. */
export function unwrapDekWithRecoveryKey(wrapped: RecoveryWrappedDek, recoveryKey: string): Buffer {
  if (wrapped.kdf !== 'scrypt') throw new Error('Unsupported recovery wrap format.')
  const kek = deriveKekFromRecoveryKey(recoveryKey, Buffer.from(wrapped.salt, 'base64'))
  const dek = decryptGcm(wrapped, kek)
  assertKeyLength(dek, DEK_BYTES, 'unwrapped DEK')
  return dek
}

/** An integrity check value bound to this DEK. */
export function makeDekCheck(dek: Buffer): DekCheck {
  assertKeyLength(dek, DEK_BYTES, 'DEK')
  return encryptGcm(Buffer.from(DEK_CHECK_MARKER, 'utf-8'), dek)
}

/** True when the candidate DEK matches the one that produced this check value. */
export function verifyDekCheck(check: DekCheck, dek: Buffer): boolean {
  if (dek.length !== DEK_BYTES) return false
  try {
    const decrypted = decryptGcm(check, dek)
    const expected = Buffer.from(DEK_CHECK_MARKER, 'utf-8')
    return decrypted.length === expected.length && timingSafeEqual(decrypted, expected)
  } catch {
    // A wrong DEK fails the GCM auth tag; treat any failure as "does not match".
    return false
  }
}

function assertKeyLength(key: Buffer, bytes: number, label: string): void {
  if (key.length !== bytes) throw new Error(`${label} must be ${bytes} bytes, got ${key.length}.`)
}
