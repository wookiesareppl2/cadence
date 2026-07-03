import { describe, expect, it } from 'vitest'
import {
  decryptBundleWithDek,
  deriveKekFromRecoveryKey,
  encryptBundleWithDek,
  generateDek,
  generateRecoveryKey,
  makeDekCheck,
  normalizeRecoveryKey,
  unwrapDekForGithubAccount,
  unwrapDekWithRecoveryKey,
  verifyDekCheck,
  wrapDekForGithubAccount,
  wrapDekWithRecoveryKey,
  type EncryptedSnapshotV2,
  type GithubWrappedDek
} from '../src/main/context-vault/vault-crypto'

describe('generateDek', () => {
  it('produces a fresh 32-byte key each time', () => {
    const a = generateDek()
    const b = generateDek()
    expect(a).toHaveLength(32)
    expect(b).toHaveLength(32)
    expect(a.equals(b)).toBe(false)
  })
})

describe('snapshot encryption with the DEK', () => {
  const bundleJson = JSON.stringify({ files: [{ path: 'CLAUDE.md', body: 'hello' }], createdAt: 'x' })

  it('round-trips a payload', () => {
    const dek = generateDek()
    const snapshot = encryptBundleWithDek(bundleJson, dek)
    expect(snapshot.version).toBe(2)
    expect(snapshot.ciphertext).not.toContain('hello')
    expect(decryptBundleWithDek(snapshot, dek)).toBe(bundleJson)
  })

  it('uses a fresh nonce per encryption so identical input differs', () => {
    const dek = generateDek()
    const a = encryptBundleWithDek(bundleJson, dek)
    const b = encryptBundleWithDek(bundleJson, dek)
    expect(a.iv).not.toBe(b.iv)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('fails to decrypt with the wrong DEK', () => {
    const snapshot = encryptBundleWithDek(bundleJson, generateDek())
    expect(() => decryptBundleWithDek(snapshot, generateDek())).toThrow()
  })

  it('fails when the ciphertext is tampered with', () => {
    const dek = generateDek()
    const snapshot = encryptBundleWithDek(bundleJson, dek)
    const tampered: EncryptedSnapshotV2 = {
      ...snapshot,
      ciphertext: Buffer.from('not the real ciphertext').toString('base64')
    }
    expect(() => decryptBundleWithDek(tampered, dek)).toThrow()
  })

  it('rejects an unsupported snapshot version', () => {
    const dek = generateDek()
    const snapshot = { ...encryptBundleWithDek(bundleJson, dek), version: 1 } as unknown as EncryptedSnapshotV2
    expect(() => decryptBundleWithDek(snapshot, dek)).toThrow(/Unsupported/)
  })

  it('rejects a wrong-sized DEK', () => {
    expect(() => encryptBundleWithDek(bundleJson, Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})

describe('recovery key', () => {
  it('generates a formatted 160-bit key', () => {
    const key = generateRecoveryKey()
    expect(key).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/)
    // No ambiguous characters are ever emitted.
    expect(key).not.toMatch(/[ILOU]/)
  })

  it('generates distinct keys', () => {
    expect(generateRecoveryKey()).not.toBe(generateRecoveryKey())
  })

  it('normalises separators, case, and Crockford-ambiguous characters', () => {
    // A key of all valid symbols, lower-cased and re-spaced, still normalises back.
    const key = generateRecoveryKey()
    const messy = key.toLowerCase().replace(/-/g, ' ')
    expect(normalizeRecoveryKey(messy)).toBe(key.replace(/-/g, ''))
    // I/L → 1 and O → 0 folding ("ILO0" → "1100"), rest unchanged.
    expect(normalizeRecoveryKey('ILO0-2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX')).toBe(
      '110023456789ABCDEFGHJKMNPQRSTVWX'
    )
  })

  it('rejects wrong-length or invalid input', () => {
    expect(normalizeRecoveryKey('too-short')).toBeNull()
    // 'U' is not in the alphabet and is not folded.
    expect(normalizeRecoveryKey('UUUU-2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX')).toBeNull()
  })
})

describe('DEK wrapping with a recovery key', () => {
  it('round-trips the DEK through wrap/unwrap', () => {
    const dek = generateDek()
    const recoveryKey = generateRecoveryKey()
    const wrapped = wrapDekWithRecoveryKey(dek, recoveryKey)
    expect(wrapped.kdf).toBe('scrypt')
    const recovered = unwrapDekWithRecoveryKey(wrapped, recoveryKey)
    expect(recovered.equals(dek)).toBe(true)
  })

  it('unwraps with a differently-formatted but equivalent recovery key', () => {
    const dek = generateDek()
    const recoveryKey = generateRecoveryKey()
    const wrapped = wrapDekWithRecoveryKey(dek, recoveryKey)
    const messy = recoveryKey.toLowerCase().replace(/-/g, '')
    expect(unwrapDekWithRecoveryKey(wrapped, messy).equals(dek)).toBe(true)
  })

  it('fails to unwrap with the wrong recovery key', () => {
    const wrapped = wrapDekWithRecoveryKey(generateDek(), generateRecoveryKey())
    expect(() => unwrapDekWithRecoveryKey(wrapped, generateRecoveryKey())).toThrow()
  })

  it('derives a stable KEK for the same key + salt and a different one per salt', () => {
    const key = generateRecoveryKey()
    const salt = Buffer.alloc(16, 7)
    const otherSalt = Buffer.alloc(16, 9)
    expect(deriveKekFromRecoveryKey(key, salt).equals(deriveKekFromRecoveryKey(key, salt))).toBe(true)
    expect(deriveKekFromRecoveryKey(key, salt).equals(deriveKekFromRecoveryKey(key, otherSalt))).toBe(false)
  })
})

describe('DEK wrapping for GitHub-account recovery', () => {
  const accountId = '1234567'

  it('round-trips the DEK through wrap/unwrap for the same account', () => {
    const dek = generateDek()
    const wrapped = wrapDekForGithubAccount(dek, accountId)
    expect(wrapped.kdf).toBe('hkdf-sha256')
    expect(unwrapDekForGithubAccount(wrapped, accountId).equals(dek)).toBe(true)
  })

  it('fails to unwrap with a different account id', () => {
    const wrapped = wrapDekForGithubAccount(generateDek(), accountId)
    expect(() => unwrapDekForGithubAccount(wrapped, '7654321')).toThrow()
  })

  it('uses a fresh salt so two wraps of the same DEK differ', () => {
    const dek = generateDek()
    const a = wrapDekForGithubAccount(dek, accountId)
    const b = wrapDekForGithubAccount(dek, accountId)
    expect(a.salt).not.toBe(b.salt)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('rejects an unsupported wrap format', () => {
    const wrapped = { ...wrapDekForGithubAccount(generateDek(), accountId), kdf: 'scrypt' } as unknown as GithubWrappedDek
    expect(() => unwrapDekForGithubAccount(wrapped, accountId)).toThrow()
  })

  it('requires a non-empty account id to wrap', () => {
    expect(() => wrapDekForGithubAccount(generateDek(), '  ')).toThrow()
  })
})

describe('DEK integrity check', () => {
  it('verifies the matching DEK and rejects any other', () => {
    const dek = generateDek()
    const check = makeDekCheck(dek)
    expect(verifyDekCheck(check, dek)).toBe(true)
    expect(verifyDekCheck(check, generateDek())).toBe(false)
    expect(verifyDekCheck(check, Buffer.alloc(16))).toBe(false)
  })
})
