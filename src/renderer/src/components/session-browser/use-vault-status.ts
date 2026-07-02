import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@shared/platform'
import type { GitHubContextVaultState } from '@shared/github-import'

export type VaultStatusView = {
  state: GitHubContextVaultState | null
  lastSyncedAt: string | null
  loading: boolean
  refresh: () => void
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

  return { state, lastSyncedAt, loading, refresh }
}
