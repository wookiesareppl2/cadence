import { describe, expect, it } from 'vitest'
import { CONTEXT_VAULT_BANKED_REASON, CONTEXT_VAULT_SYNC_ENABLED } from '../src/shared/context-vault-feature'

describe('context vault feature gate', () => {
  it('keeps cross-device context sync banked for the local-first prototype', () => {
    expect(CONTEXT_VAULT_SYNC_ENABLED).toBe(false)
    expect(CONTEXT_VAULT_BANKED_REASON).toContain('postponed')
  })
})
