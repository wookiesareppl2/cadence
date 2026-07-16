/**
 * Context-vault sync is intentionally banked while Cadence stabilises its
 * local-first release prototype. Keep the implementation intact behind this
 * single gate so dedicated cross-device work can resume it deliberately.
 */
export const CONTEXT_VAULT_SYNC_ENABLED = false

export const CONTEXT_VAULT_BANKED_REASON =
  'Context vault sync is postponed while Cadence focuses on local-first prototype stability.'
