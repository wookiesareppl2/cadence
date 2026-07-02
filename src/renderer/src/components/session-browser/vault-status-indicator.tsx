import type { JSX } from 'react'
import type { PlatformId } from '@shared/platform'
import type { GitHubContextVaultState } from '@shared/github-import'
import { useVaultStatus } from './use-vault-status'

// Quiet mono state readout for the selected project's context vault, per DESIGN.md
// ("Vault state" fact row). `not-connected` renders nothing so projects without a
// vault stay uncluttered; other states show a small coloured dot + label.
const STATE_META: Partial<Record<GitHubContextVaultState, { label: string; cls: string; title: string }>> = {
  'in-sync': { label: 'In sync', cls: 'is-insync', title: 'Context vault is in sync' },
  'local-ahead': {
    label: 'Local changes',
    cls: 'is-local',
    title: 'This device has context changes not yet synced to the vault'
  },
  'remote-ahead': {
    label: 'Update available',
    cls: 'is-remote',
    title: 'A newer context snapshot is available in the vault to restore'
  },
  conflict: {
    label: 'Conflict',
    cls: 'is-conflict',
    title: 'Both this device and the vault changed — resolve before syncing'
  },
  uninitialized: { label: 'Not synced', cls: 'is-none', title: 'No context snapshot in the vault yet' }
}

export function VaultStatusIndicator({
  platform,
  projectId,
  onOpen
}: {
  platform: PlatformId
  projectId: string | null
  // Opens the vault manager. When provided, the pill is a button (set up / unlock /
  // manage); a connected readout still shows its state, and other cases show a quiet
  // "Vault" affordance so setup is always reachable.
  onOpen?: () => void
}): JSX.Element | null {
  const { state } = useVaultStatus(platform, projectId)
  if (!projectId) return null
  const meta = state && state !== 'not-connected' ? STATE_META[state] : undefined

  // Read-only mode (no onOpen): preserve the Phase 2 behaviour of hiding when there is
  // nothing to report.
  if (!onOpen) {
    if (!meta) return null
    return (
      <span className={`status-pill vault-status ${meta.cls}`} title={meta.title}>
        <span className="vault-status-dot" aria-hidden="true" />
        {meta.label}
      </span>
    )
  }

  const cls = meta?.cls ?? 'is-setup'
  const label = meta?.label ?? 'Vault'
  const title = meta?.title ?? 'Set up or manage the context vault'
  return (
    <button type="button" className={`status-pill vault-status vault-status-trigger ${cls}`} title={title} onClick={onOpen}>
      <span className="vault-status-dot" aria-hidden="true" />
      {label}
    </button>
  )
}
