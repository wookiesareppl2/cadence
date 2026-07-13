import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@shared/platform'
import type { GitHubContextVaultState } from '@shared/github-import'

export type VaultStatusView = {
  state: GitHubContextVaultState | null
  lastSyncedAt: string | null
  loading: boolean
  refresh: () => void
}

// A sync/restore mutates vault state that any number of mounted indicators display (the
// sidebar pill and the manager modal each run their own useVaultStatus). Broadcasting a
// single window event after a successful sync lets every one of them re-fetch, so the
// sidebar can't keep showing a pre-sync state ("Conflict") after the modal synced.
const VAULT_STATUS_CHANGED_EVENT = 'cadence:vault-status-changed'

/** Signal every mounted vault-status indicator to re-fetch (call after a successful sync). */
export function notifyVaultStatusChanged(): void {
  window.dispatchEvent(new Event(VAULT_STATUS_CHANGED_EVENT))
}

/**
 * Read-only vault sync state for the selected project. Re-fetches when the project
 * changes; stale responses (from a previous project) are dropped via a request token.
 * Never mutates anything — the status check is side-effect-free in the main process.
 */
export function useVaultStatus(platform: PlatformId, projectId: string | null): VaultStatusView {
  const [state, setState] = useState<GitHubContextVaultState | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  const refresh = useCallback(() => {
    const api = window.dashboard?.github?.projectContextStatus
    if (!api || !projectId) {
      setState(null)
      setLastSyncedAt(null)
      return
    }
    const token = ++requestRef.current
    setLoading(true)
    api({ platform, projectId })
      .then((result) => {
        if (token !== requestRef.current) return
        setState(result.ok ? result.state ?? null : null)
        setLastSyncedAt(result.lastSyncedAt ?? null)
      })
      .catch(() => {
        if (token !== requestRef.current) return
        setState(null)
        setLastSyncedAt(null)
      })
      .finally(() => {
        if (token === requestRef.current) setLoading(false)
      })
  }, [platform, projectId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Re-fetch when any sync elsewhere broadcasts a change, so this indicator never shows a
  // stale pre-sync state after a sync happened in another component.
  useEffect(() => {
    const onChanged = (): void => refresh()
    window.addEventListener(VAULT_STATUS_CHANGED_EVENT, onChanged)
    return () => window.removeEventListener(VAULT_STATUS_CHANGED_EVENT, onChanged)
  }, [refresh])

  return { state, lastSyncedAt, loading, refresh }
}
