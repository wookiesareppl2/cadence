import { describe, expect, it } from 'vitest'
import {
  addGithubRecovery,
  createVaultKeyMaterial,
  dekMatchesKeyring,
  hasGithubRecovery,
  parseKeyring,
  removeGithubRecovery,
  rotateRecoveryKey,
  serializeKeyring,
  unlockKeyringWithGithubAccount,
  unlockKeyringWithRecoveryKey,
  type VaultKeyring
} from '../src/main/context-vault/keyring'
import { generateDek } from '../src/main/context-vault/vault-crypto'

describe('createVaultKeyMaterial', () => {
  it('mints a DEK, recovery key, and a keyring that ties them together', () => {
    const material = createVaultKeyMaterial()
    expect(material.dek).toHaveLength(32)
    expect(material.recoveryKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/)
    expect(material.keyring.version).toBe(1)
    // The recovery key recovers exactly the DEK that was minted.
    expect(unlockKeyringWithRecoveryKey(material.keyring, material.recoveryKey).equals(material.dek)).toBe(true)
    expect(dekMatchesKeyring(material.keyring, material.dek)).toBe(true)
  })

  it('never embeds the DEK in the keyring', () => {
    const material = createVaultKeyMaterial()
    const serialized = serializeKeyring(material.keyring)
    expect(serialized).not.toContain(material.dek.toString('base64'))
    expect(serialized).not.toContain(material.recoveryKey)
    expect(serialized).not.toContain(material.recoveryKey.replace(/-/g, ''))
  })
})

describe('unlockKeyringWithRecoveryKey', () => {
  it('rejects a valid-format but wrong recovery key', () => {
    const { keyring } = createVaultKeyMaterial()
    const { recoveryKey: otherKey } = createVaultKeyMaterial()
    expect(() => unlockKeyringWithRecoveryKey(keyring, otherKey)).toThrow()
  })

  it('rejects an unusably malformed recovery key', () => {
    const { keyring } = createVaultKeyMaterial()
    expect(() => unlockKeyringWithRecoveryKey(keyring, 'not-a-key')).toThrow()
  })
})

describe('rotateRecoveryKey', () => {
  it('issues a new key for the same DEK and invalidates the old one', () => {
    const { dek, recoveryKey: oldKey, keyring } = createVaultKeyMaterial()
    const { recoveryKey: newKey, keyring: rotated } = rotateRecoveryKey(keyring, dek)

    expect(newKey).not.toBe(oldKey)
    // The new key unlocks the same DEK.
    expect(unlockKeyringWithRecoveryKey(rotated, newKey).equals(dek)).toBe(true)
    // The old key no longer works against the rotated keyring.
    expect(() => unlockKeyringWithRecoveryKey(rotated, oldKey)).toThrow()
  })

  it('refuses to rotate without the correct DEK', () => {
    const { keyring } = createVaultKeyMaterial()
    expect(() => rotateRecoveryKey(keyring, generateDek())).toThrow()
  })
})

describe('GitHub-account recovery', () => {
  const accountId = '42424242'

  it('adds a recovery wrap the account can later unlock', () => {
    const { dek, keyring } = createVaultKeyMaterial()
    expect(hasGithubRecovery(keyring)).toBe(false)
    const withGithub = addGithubRecovery(keyring, dek, accountId)
    expect(hasGithubRecovery(withGithub)).toBe(true)
    expect(unlockKeyringWithGithubAccount(withGithub, accountId).equals(dek)).toBe(true)
  })

  it('refuses to add without the correct DEK', () => {
    const { keyring } = createVaultKeyMaterial()
    expect(() => addGithubRecovery(keyring, generateDek(), accountId)).toThrow()
  })

  it('fails to recover with the wrong account id', () => {
    const { dek, keyring } = createVaultKeyMaterial()
    const withGithub = addGithubRecovery(keyring, dek, accountId)
    expect(() => unlockKeyringWithGithubAccount(withGithub, '99999999')).toThrow()
  })

  it('throws when the vault has no GitHub recovery', () => {
    const { keyring } = createVaultKeyMaterial()
    expect(() => unlockKeyringWithGithubAccount(keyring, accountId)).toThrow(/no GitHub-account recovery/)
  })

  it('can be removed, returning to recovery-key-only', () => {
    const { dek, keyring } = createVaultKeyMaterial()
    const withGithub = addGithubRecovery(keyring, dek, accountId)
    const without = removeGithubRecovery(withGithub)
    expect(hasGithubRecovery(without)).toBe(false)
    expect(JSON.parse(serializeKeyring(without)).github).toBeUndefined()
  })

  it('survives serialize round-trip and a recovery-key rotation', () => {
    const { dek, keyring } = createVaultKeyMaterial()
    const withGithub = addGithubRecovery(keyring, dek, accountId)
    const reparsed = parseKeyring(JSON.parse(serializeKeyring(withGithub)))
    expect(hasGithubRecovery(reparsed!)).toBe(true)
    const { keyring: rotated } = rotateRecoveryKey(reparsed!, dek)
    expect(unlockKeyringWithGithubAccount(rotated, accountId).equals(dek)).toBe(true)
  })

  it('drops a malformed github wrap on parse', () => {
    const { dek, keyring } = createVaultKeyMaterial()
    const withGithub = addGithubRecovery(keyring, dek, accountId)
    const broken = { ...JSON.parse(serializeKeyring(withGithub)), github: { kdf: 'hkdf-sha256', salt: 5 } }
    const parsed = parseKeyring(broken)
    expect(parsed).not.toBeNull()
    expect(hasGithubRecovery(parsed!)).toBe(false)
  })
})

describe('parseKeyring', () => {
  it('round-trips a serialised keyring', () => {
    const { keyring } = createVaultKeyMaterial()
    const parsed = parseKeyring(JSON.parse(serializeKeyring(keyring)))
    expect(parsed).toEqual(keyring)
  })

  it('preserves unknown extra wraps so a newer client is never clobbered', () => {
    // A hypothetical future recovery wrap this client doesn't know about.
    const { dek, keyring } = createVaultKeyMaterial()
    const futureWrap = { kind: 'future-recovery', blob: 'abc' }
    const withExtra = { ...JSON.parse(serializeKeyring(keyring)), futureRecovery: futureWrap }

    const parsed = parseKeyring(withExtra) as (VaultKeyring & { futureRecovery?: unknown }) | null
    expect(parsed).not.toBeNull()
    expect(parsed?.futureRecovery).toEqual(futureWrap)
    // Survives a serialize round-trip...
    expect(JSON.parse(serializeKeyring(parsed!)).futureRecovery).toEqual(futureWrap)
    // ...and, critically, survives a recovery-key rotation done by this (older) client.
    const { keyring: rotated } = rotateRecoveryKey(parsed!, dek)
    expect(JSON.parse(serializeKeyring(rotated)).futureRecovery).toEqual(futureWrap)
  })

  it('rejects malformed or wrong-version records', () => {
    const { keyring } = createVaultKeyMaterial()
    expect(parseKeyring(null)).toBeNull()
    expect(parseKeyring({})).toBeNull()
    expect(parseKeyring({ ...keyring, version: 2 })).toBeNull()
    expect(parseKeyring({ version: 1, recovery: { iv: 'x' }, dekCheck: keyring.dekCheck })).toBeNull()
    const noSalt = { version: 1, recovery: { ...keyring.recovery, salt: undefined }, dekCheck: keyring.dekCheck }
    expect(parseKeyring(noSalt as unknown as VaultKeyring)).toBeNull()
  })
})
