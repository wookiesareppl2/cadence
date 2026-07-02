import { describe, expect, it } from 'vitest'
import {
  createVaultKeyMaterial,
  dekMatchesKeyring,
  parseKeyring,
  rotateRecoveryKey,
  serializeKeyring,
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

describe('parseKeyring', () => {
  it('round-trips a serialised keyring', () => {
    const { keyring } = createVaultKeyMaterial()
    const parsed = parseKeyring(JSON.parse(serializeKeyring(keyring)))
    expect(parsed).toEqual(keyring)
  })

  it('tolerates unknown extra fields (forward-compat for the github wrap)', () => {
    const { keyring } = createVaultKeyMaterial()
    const withExtra = { ...JSON.parse(serializeKeyring(keyring)), github: { some: 'future-wrap' } }
    const parsed = parseKeyring(withExtra)
    expect(parsed).toEqual(keyring)
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
