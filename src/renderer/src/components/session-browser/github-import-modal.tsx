import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import {
  defaultGitHubDirectoryName,
  GITHUB_CONTEXT_VAULT_REPO_NAME,
  parseGitHubRepository,
  type GitHubAuthStatus,
  type GitHubDeviceFlowStartResult,
  type GitHubRepositorySummary
} from '@shared/github-import'
import type { ProjectSessionBrowserState } from './use-session-browser'

const CLIENT_ID_KEY = 'cadence.github.oauthClientId'
const VAULT_URL_KEY = 'cadence.github.contextVaultUrl'

type BusyAction = 'auth' | 'repos' | 'import' | 'sync' | null
type Mode = 'oauth' | 'manual'

export function GitHubImportModal({
  browser,
  onClose
}: {
  browser: ProjectSessionBrowserState
  onClose: () => void
}): JSX.Element {
  const [mode, setMode] = useState<Mode>('oauth')
  const [auth, setAuth] = useState<GitHubAuthStatus | null>(null)
  const [oauthClientId, setOauthClientId] = useState(() => localStorage.getItem(CLIENT_ID_KEY) ?? '')
  const [deviceFlow, setDeviceFlow] = useState<GitHubDeviceFlowStartResult | null>(null)
  const [repos, setRepos] = useState<GitHubRepositorySummary[]>([])
  const [repoFilter, setRepoFilter] = useState('')
  const [selectedRepoFullName, setSelectedRepoFullName] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [destinationParentPath, setDestinationParentPath] = useState('')
  const [targetDirectoryName, setTargetDirectoryName] = useState('')
  const [restoreContext, setRestoreContext] = useState(true)
  const [vaultRepositoryUrl, setVaultRepositoryUrl] = useState(() => localStorage.getItem(VAULT_URL_KEY) ?? '')
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState<BusyAction>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.fullName === selectedRepoFullName) ?? null,
    [repos, selectedRepoFullName]
  )
  const manualRepo = useMemo(() => parseGitHubRepository(repositoryUrl), [repositoryUrl])
  const repoForImport = mode === 'oauth' ? selectedRepo?.fullName ?? '' : repositoryUrl.trim()
  const defaultDirectoryName = useMemo(
    () => (mode === 'oauth' ? selectedRepo?.name ?? '' : defaultGitHubDirectoryName(repositoryUrl)),
    [mode, repositoryUrl, selectedRepo]
  )
  const canSyncSelected = Boolean(browser.selectedProject?.id && browser.selectedProject.path)

  const refreshAuth = useCallback(async (): Promise<void> => {
    const next = await browser.getGitHubAuthStatus()
    setAuth(next)
  }, [browser])

  const refreshRepos = useCallback(async (): Promise<void> => {
    setBusy('repos')
    setError(null)
    const result = await browser.listGitHubRepositories()
    setBusy(null)
    if (!result.ok) {
      setRepos([])
      setError(result.error ?? 'Could not load GitHub repositories.')
      return
    }
    const nextRepos = result.repos ?? []
    setRepos(nextRepos)
    setSelectedRepoFullName((current) =>
      current && nextRepos.some((repo) => repo.fullName === current) ? current : nextRepos[0]?.fullName ?? ''
    )
  }, [browser])

  useEffect(() => {
    void refreshAuth()
  }, [refreshAuth])

  useEffect(() => {
    if (auth?.authenticated) void refreshRepos()
  }, [auth?.authenticated, refreshRepos])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  useEffect(() => {
    if (!deviceFlow?.ok || !deviceFlow.intervalMs || auth?.authenticated) return
    let cancelled = false
    let timeoutId: number | null = null

    const poll = async (): Promise<void> => {
      const result = await browser.pollGitHubDeviceFlow()
      if (cancelled) return
      if (result.status === 'authorized') {
        setDeviceFlow(null)
        setAuth(result.auth ?? (await browser.getGitHubAuthStatus()))
        setStatus('Signed in to GitHub.')
        setError(null)
        return
      }
      if (result.status === 'expired' || result.status === 'error') {
        setDeviceFlow(null)
        setError(result.error ?? 'GitHub sign-in failed.')
        return
      }
      timeoutId = window.setTimeout(poll, result.intervalMs ?? deviceFlow.intervalMs)
    }

    timeoutId = window.setTimeout(poll, deviceFlow.intervalMs)
    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [auth?.authenticated, browser, deviceFlow])

  const chooseDestination = async (): Promise<void> => {
    const path = await browser.chooseGithubImportDirectory()
    if (path) setDestinationParentPath(path)
  }

  const startSignIn = async (): Promise<void> => {
    setBusy('auth')
    setError(null)
    setStatus(null)
    const clientId = oauthClientId.trim()
    if (clientId) localStorage.setItem(CLIENT_ID_KEY, clientId)
    const result = await browser.startGitHubDeviceFlow(clientId || null)
    setBusy(null)
    if (!result.ok) {
      setError(result.error ?? 'Could not start GitHub sign-in.')
      return
    }
    setDeviceFlow(result)
    void browser.openGitHubDevicePage()
  }

  const signOut = async (): Promise<void> => {
    const next = await browser.signOutGitHub()
    setAuth(next)
    setRepos([])
    setSelectedRepoFullName('')
    setDeviceFlow(null)
  }

  const rememberVaultUrl = (): void => {
    const trimmed = vaultRepositoryUrl.trim()
    if (trimmed) localStorage.setItem(VAULT_URL_KEY, trimmed)
  }

  const validateImport = (): boolean => {
    if (mode === 'oauth' && !auth?.authenticated) {
      setError('Sign in to GitHub first.')
      return false
    }
    if (mode === 'oauth' && !selectedRepo) {
      setError('Select a GitHub repository.')
      return false
    }
    if (mode === 'manual' && !manualRepo) {
      setError('Enter a valid GitHub repository URL.')
      return false
    }
    if (!destinationParentPath.trim()) {
      setError('Choose a destination folder.')
      return false
    }
    if (restoreContext && !passphrase) {
      setError('Enter the context vault passphrase, or turn off restore.')
      return false
    }
    if (mode === 'manual' && restoreContext && !vaultRepositoryUrl.trim()) {
      setError('Enter the vault repository URL, or turn off restore.')
      return false
    }
    return true
  }

  const runImport = async (): Promise<void> => {
    setError(null)
    setStatus(null)
    if (!validateImport()) return

    setBusy('import')
    rememberVaultUrl()
    const result = await browser.importGithubProject({
      repositoryUrl: repoForImport,
      authMode: mode === 'oauth' ? 'oauth' : 'git',
      destinationParentPath: destinationParentPath.trim(),
      targetDirectoryName: targetDirectoryName.trim() || null,
      restoreContext: restoreContext
        ? {
            mode: mode === 'oauth' ? 'oauth' : 'git',
            vaultRepositoryUrl: mode === 'manual' ? vaultRepositoryUrl.trim() : null,
            passphrase
          }
        : null
    })
    setBusy(null)

    if (!result.ok) {
      setError(result.error ?? 'Import failed.')
      return
    }

    const context = result.context
    if (!context?.attempted) {
      setStatus(`Imported ${result.repo?.owner}/${result.repo?.repo}.`)
    } else if (context.restored) {
      setStatus(
        `Imported ${result.repo?.owner}/${result.repo?.repo}; restored ${context.filesRestored} context file${
          context.filesRestored === 1 ? '' : 's'
        }.`
      )
    } else {
      setStatus(`Imported ${result.repo?.owner}/${result.repo?.repo}; context restore skipped: ${context.error}`)
    }
  }

  const runSync = async (): Promise<void> => {
    setError(null)
    setStatus(null)
    if (!canSyncSelected || !browser.selectedProject) {
      setError('Select a project with a folder.')
      return
    }
    if (mode === 'oauth' && !auth?.authenticated) {
      setError('Sign in to GitHub first.')
      return
    }
    if (!passphrase) {
      setError('Enter the context vault passphrase.')
      return
    }
    if (mode === 'manual' && !vaultRepositoryUrl.trim()) {
      setError('Enter the vault repository URL.')
      return
    }

    setBusy('sync')
    rememberVaultUrl()
    const result = await browser.syncProjectContext({
      projectId: browser.selectedProject.id,
      repositoryUrl: (mode === 'oauth' ? selectedRepo?.fullName : repositoryUrl.trim()) || null,
      mode: mode === 'oauth' ? 'oauth' : 'git',
      vaultRepositoryUrl: mode === 'manual' ? vaultRepositoryUrl.trim() : null,
      passphrase
    })
    setBusy(null)

    if (!result.ok) {
      setError(result.error ?? 'Context sync failed.')
      return
    }
    setStatus(
      `Synced ${result.filesSynced ?? 0} context file${result.filesSynced === 1 ? '' : 's'} for ${
        result.repo?.owner
      }/${result.repo?.repo}.`
    )
  }

  const filteredRepos = useMemo(() => {
    const needle = repoFilter.trim().toLowerCase()
    if (!needle) return repos
    return repos.filter((repo) => repo.fullName.toLowerCase().includes(needle))
  }, [repoFilter, repos])

  return createPortal(
    <div className="github-import-modal-backdrop" onMouseDown={busy ? undefined : onClose}>
      <div
        className="github-import-modal"
        role="dialog"
        aria-modal="true"
        aria-label="GitHub project import"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="github-import-modal-header">
          <h2>GitHub project</h2>
          <button
            type="button"
            className="github-import-close"
            onClick={onClose}
            disabled={Boolean(busy)}
            aria-label="Close GitHub project import"
          >
            ✕
          </button>
        </div>

        <div className="github-import-body">
          <div className="github-import-tabs" role="tablist" aria-label="GitHub import mode">
            <button
              type="button"
              className={mode === 'oauth' ? 'active' : ''}
              aria-pressed={mode === 'oauth'}
              onClick={() => setMode('oauth')}
            >
              GitHub
            </button>
            <button
              type="button"
              className={mode === 'manual' ? 'active' : ''}
              aria-pressed={mode === 'manual'}
              onClick={() => setMode('manual')}
            >
              Manual
            </button>
          </div>

          {mode === 'oauth' ? (
            <section className="github-import-section" aria-label="GitHub sign-in and repositories">
              <div className="github-auth-row">
                <div className="github-auth-state">
                  <span>{auth?.authenticated ? auth.login ?? 'Signed in' : 'Not signed in'}</span>
                  <small>{auth?.authenticated ? auth.storage : 'repo scope'}</small>
                </div>
                {auth?.authenticated ? (
                  <button type="button" className="github-import-action" onClick={() => void signOut()}>
                    Sign out
                  </button>
                ) : (
                  <button
                    type="button"
                    className="github-import-action primary"
                    disabled={busy !== null}
                    onClick={() => void startSignIn()}
                  >
                    {busy === 'auth' ? 'Starting...' : 'Sign in'}
                  </button>
                )}
              </div>

              {!auth?.configured && !auth?.authenticated ? (
                <label className="github-import-field">
                  <span>OAuth client ID</span>
                  <input
                    value={oauthClientId}
                    spellCheck={false}
                    onChange={(event) => setOauthClientId(event.target.value)}
                  />
                </label>
              ) : null}

              {deviceFlow?.ok ? (
                <div className="github-device-code" role="status">
                  <span>{deviceFlow.userCode}</span>
                  <button type="button" className="github-import-action" onClick={() => void browser.openGitHubDevicePage()}>
                    Open
                  </button>
                </div>
              ) : null}

              {auth?.authenticated ? (
                <>
                  <label className="github-import-field">
                    <span>Repository</span>
                    <input
                      value={repoFilter}
                      spellCheck={false}
                      placeholder="Filter repositories"
                      onChange={(event) => setRepoFilter(event.target.value)}
                    />
                  </label>
                  <div className="github-repo-list" aria-label="GitHub repositories">
                    {busy === 'repos' ? (
                      <div className="github-import-msg">Loading repositories...</div>
                    ) : filteredRepos.length === 0 ? (
                      <div className="github-import-msg">No repositories found.</div>
                    ) : (
                      filteredRepos.map((repo) => (
                        <button
                          key={repo.id}
                          type="button"
                          className={`github-repo-row${repo.fullName === selectedRepoFullName ? ' active' : ''}`}
                          onClick={() => setSelectedRepoFullName(repo.fullName)}
                        >
                          <span>{repo.fullName}</span>
                          <small>{repo.private ? 'private' : 'public'}</small>
                        </button>
                      ))
                    )}
                  </div>
                </>
              ) : null}
            </section>
          ) : (
            <section className="github-import-section" aria-label="Manual GitHub import">
              <label className="github-import-field">
                <span>Repository</span>
                <input
                  value={repositoryUrl}
                  spellCheck={false}
                  placeholder="owner/repo or https://github.com/owner/repo.git"
                  onChange={(event) => setRepositoryUrl(event.target.value)}
                />
              </label>
              <label className="github-import-field">
                <span>Vault repository</span>
                <input
                  value={vaultRepositoryUrl}
                  spellCheck={false}
                  placeholder="git@github.com:owner/cadence-context-vault.git"
                  onChange={(event) => setVaultRepositoryUrl(event.target.value)}
                />
              </label>
            </section>
          )}

          <div className="github-import-field">
            <span>Destination</span>
            <div className="github-import-inline">
              <input value={destinationParentPath} readOnly placeholder="Choose folder" />
              <button type="button" className="github-import-action" onClick={() => void chooseDestination()}>
                Choose
              </button>
            </div>
          </div>

          <label className="github-import-field">
            <span>Folder name</span>
            <input
              value={targetDirectoryName}
              spellCheck={false}
              placeholder={defaultDirectoryName || 'project'}
              onChange={(event) => setTargetDirectoryName(event.target.value)}
            />
          </label>

          <label className="github-import-check">
            <input
              type="checkbox"
              checked={restoreContext}
              onChange={(event) => setRestoreContext(event.target.checked)}
            />
            <span>Restore private context</span>
          </label>

          <label className="github-import-field">
            <span>Vault passphrase</span>
            <input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </label>

          {mode === 'oauth' ? (
            <div className="github-vault-label">
              <span>Vault</span>
              <strong>{auth?.login ? `${auth.login}/${GITHUB_CONTEXT_VAULT_REPO_NAME}` : GITHUB_CONTEXT_VAULT_REPO_NAME}</strong>
            </div>
          ) : null}

          {error ? (
            <div className="github-import-status error" role="alert">
              {error}
            </div>
          ) : status ? (
            <div className="github-import-status" role="status">
              {status}
            </div>
          ) : null}
        </div>

        <div className="github-import-footer">
          <button
            type="button"
            className="github-import-action"
            disabled={busy !== null || !canSyncSelected}
            onClick={() => void runSync()}
            title={canSyncSelected ? 'Sync selected project context' : 'Select a project with a folder'}
          >
            {busy === 'sync' ? 'Syncing...' : 'Sync Context'}
          </button>
          <button
            type="button"
            className="github-import-action primary"
            disabled={busy !== null}
            onClick={() => void runImport()}
          >
            {busy === 'import' ? 'Importing...' : 'Import Project'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
