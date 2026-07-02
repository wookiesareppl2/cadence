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
  projectId
}: {
  platform: PlatformId
  projectId: string | null
}): JSX.Element | null {
  const { state } = useVaultStatus(platform, projectId)
  if (!state || state === 'not-connected') return null
  const meta = STATE_META[state]
  if (!meta) return null

  return (
    <span className={`status-pill vault-status ${meta.cls}`} title={meta.title}>
      <span className="vault-status-dot" aria-hidden="true" />
      {meta.label}
    </span>
  )
}
