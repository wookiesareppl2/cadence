import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { GitHubContextVaultKeyStatus } from '@shared/github-import'
import type { ProjectSessionBrowserState } from './use-session-browser'
import { useVaultStatus } from './use-vault-status'

// The context-vault key manager: a single modal that adapts to what this device needs —
// sign in, first-time setup, unlock with a recovery key, or manage an unlocked vault —
// plus the unmissable one-time Recovery Key reveal. Styled with the shared GitHub-import
// modal tokens (per DESIGN.md / PAT-112); only the key-reveal block adds its own classes.

type RevealState = { key: string; rotated: boolean; githubRecovery: boolean }

function formatSyncedAt(value: string | null): string {
  if (!value) return 'never'
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) return 'unknown'
  return new Date(ms).toLocaleString()
}

export function VaultManagerModal({
  browser,
  projectId,
  onClose
}: {
  browser: ProjectSessionBrowserState
  projectId: string | null
  onClose: () => void
}): JSX.Element {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [keyStatus, setKeyStatus] = useState<GitHubContextVaultKeyStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [recoveryInput, setRecoveryInput] = useState('')
  const [reveal, setReveal] = useState<RevealState | null>(null)
  const [savedConfirmed, setSavedConfirmed] = useState(false)
  const [copied, setCopied] = useState(false)
  const vault = useVaultStatus(browser.platform, projectId)

  const refresh = useCallback(async () => {
    const [auth, keys] = await Promise.all([
      browser.getGitHubAuthStatus(),
      window.dashboard.github.vaultKeyStatus()
    ])
    setAuthed(Boolean(auth?.authenticated))
    setKeyStatus(keys)
  }, [browser])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Close on Esc (DESIGN.md overlay convention) — but never while busy, and never while
  // the one-time recovery key is on screen (it must be dismissed via the confirmed
  // "Done" path so it can't be lost by a stray keypress).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy && !reveal) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, reveal, onClose])

  const runSetup = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    const result = await window.dashboard.github.setupVault()
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not set up the vault.')
      return
    }
    if (result.recoveryKey) {
      setReveal({ key: result.recoveryKey, rotated: false, githubRecovery: Boolean(result.githubRecovery) })
      return
    }
    // Already set up on the account; just refresh to reflect lock state.
    await refresh()
    setStatus(result.unlocked ? 'Vault is already set up and unlocked on this device.' : null)
  }

  const runUnlock = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    const result = await window.dashboard.github.unlockVault({ recoveryKey: recoveryInput })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not unlock the vault.')
      return
    }
    setRecoveryInput('')
    setStatus('Vault unlocked on this device.')
    await refresh()
  }

  const runRotate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    const result = await window.dashboard.github.rotateVaultRecoveryKey()
    setBusy(false)
    if (!result.ok || !result.recoveryKey) {
      setError(result.error ?? 'Could not create a new recovery key.')
      return
    }
    setReveal({ key: result.recoveryKey, rotated: true, githubRecovery: false })
  }

  const runRecoverViaGithub = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    const result = await window.dashboard.github.recoverVaultViaGitHub()
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not recover via GitHub.')
      return
    }
    setStatus('Recovered and unlocked on this device via your GitHub account.')
    await refresh()
  }

  const toggleGithubRecovery = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    setStatus(null)
    const result = await window.dashboard.github.setVaultGithubRecovery({ enabled })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Could not update GitHub recovery.')
      return
    }
    setStatus(enabled ? 'GitHub-account recovery is on.' : 'GitHub-account recovery is off.')
    await refresh()
  }

  const runSync = async (): Promise<void> => {
    if (!projectId) {
      setError('Select a project to sync.')
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    const result = await browser.syncProjectContext({ projectId })
    setBusy(false)
    if (!result.ok) {
      setError(result.error ?? 'Sync failed.')
      return
    }
    setStatus(`Synced ${result.filesSynced ?? 0} context file${result.filesSynced === 1 ? '' : 's'} to the vault.`)
    vault.refresh()
  }

  const copyKey = async (): Promise<void> => {
    if (!reveal) return
    await window.dashboard.clipboard.writeText(reveal.key)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const dismissReveal = async (): Promise<void> => {
    setReveal(null)
    setSavedConfirmed(false)
    setCopied(false)
    setStatus('Recovery key saved. Keep it somewhere safe.')
    await refresh()
  }

  const view: 'loading' | 'signed-out' | 'setup' | 'locked' | 'manage' =
    authed === null || keyStatus === null
      ? 'loading'
      : !authed
        ? 'signed-out'
        : !keyStatus.exists
          ? 'setup'
          : !keyStatus.unlocked
            ? 'locked'
            : 'manage'

  return createPortal(
    <div className="github-import-modal-backdrop" onMouseDown={busy || reveal ? undefined : onClose}>
      <div
        className="github-import-modal vault-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Context vault"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="github-import-modal-header">
          <h2>Context vault</h2>
          <button
            type="button"
            className="github-import-close"
            onClick={onClose}
            disabled={busy || Boolean(reveal)}
            aria-label="Close context vault"
          >
            ✕
          </button>
        </div>

        <div className="github-import-body">
          {reveal ? (
            <div className="vault-key-reveal" role="group" aria-label="Your recovery key">
              <p className="vault-key-warning">
                {reveal.rotated
                  ? 'This is your new recovery key. Your previous key no longer works.'
                  : 'Your context vault is encrypted. This recovery key is the only way back in if you lose your devices.'}
                <strong> Save it now — it will not be shown again.</strong>
              </p>
              <div className="vault-key-code" aria-label="Recovery key">
                {reveal.key}
              </div>
              <button type="button" className="github-import-action" onClick={() => void copyKey()}>
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
              {reveal.githubRecovery ? (
                <p className="vault-modal-hint">
                  As a backup, you can also get back in by signing into GitHub — so you won&apos;t be locked out if you
                  misplace this key. You can turn that off later for maximum security.
                </p>
              ) : null}
              <label className="github-import-check vault-key-confirm">
                <input
                  type="checkbox"
                  checked={savedConfirmed}
                  onChange={(event) => setSavedConfirmed(event.target.checked)}
                />
                <span>I have saved my recovery key somewhere safe</span>
              </label>
            </div>
          ) : view === 'loading' ? (
            <div className="github-import-msg">Checking vault…</div>
          ) : view === 'signed-out' ? (
            <p className="vault-modal-intro">
              Sign in to GitHub to use the context vault. Open <strong>+ New → GitHub</strong> in the projects sidebar
              to connect your account, then reopen this.
            </p>
          ) : view === 'setup' ? (
            <>
              <p className="vault-modal-intro">
                Set up an encrypted vault so your memory and context follow you across devices. Cadence will create a
                random key, unlock it automatically on this device, and give you a one-time recovery key to keep safe.
              </p>
              <button
                type="button"
                className="github-import-action primary"
                disabled={busy}
                onClick={() => void runSetup()}
              >
                {busy ? 'Setting up…' : 'Set up context vault'}
              </button>
            </>
          ) : view === 'locked' ? (
            <>
              <p className="vault-modal-intro">
                This vault is locked on this device. Enter your recovery key to unlock it — after that it opens
                automatically here.
              </p>
              <label className="github-import-field">
                <span>Recovery key</span>
                <input
                  value={recoveryInput}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
                  onChange={(event) => setRecoveryInput(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="github-import-action primary"
                disabled={busy || !recoveryInput.trim()}
                onClick={() => void runUnlock()}
              >
                {busy ? 'Unlocking…' : 'Unlock vault'}
              </button>
              {keyStatus?.githubRecovery ? (
                <>
                  <div className="vault-or-divider">or</div>
                  <button
                    type="button"
                    className="github-import-action"
                    disabled={busy}
                    onClick={() => void runRecoverViaGithub()}
                  >
                    Recover with my GitHub account
                  </button>
                  <p className="vault-modal-hint">
                    You&apos;re signed in as this account, so you can unlock without the recovery key.
                  </p>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="github-vault-label">
                <span>Sync state</span>
                <strong>{vault.state ?? 'not synced'}</strong>
              </div>
              <div className="github-vault-label">
                <span>Last synced</span>
                <strong>{formatSyncedAt(vault.lastSyncedAt)}</strong>
              </div>
              <div className="github-vault-label">
                <span>GitHub recovery</span>
                <span className="vault-recovery-toggle">
                  <strong>{keyStatus?.githubRecovery ? 'On' : 'Off'}</strong>
                  <button
                    type="button"
                    className="github-import-action"
                    disabled={busy}
                    onClick={() => void toggleGithubRecovery(!keyStatus?.githubRecovery)}
                  >
                    {keyStatus?.githubRecovery ? 'Turn off' : 'Turn on'}
                  </button>
                </span>
              </div>
              <div className="vault-manage-actions">
                <button
                  type="button"
                  className="github-import-action primary"
                  disabled={busy || !projectId}
                  onClick={() => void runSync()}
                >
                  {busy ? 'Working…' : 'Sync now'}
                </button>
                <button type="button" className="github-import-action" disabled={busy} onClick={() => void runRotate()}>
                  Show new recovery key
                </button>
              </div>
              <p className="vault-modal-hint">
                {keyStatus?.githubRecovery
                  ? 'GitHub recovery lets you unlock a new device by signing in — but anyone who takes over your GitHub account could read your synced context. Turn it off for maximum security (you’ll then need your recovery key).'
                  : 'With GitHub recovery off, your recovery key is the only way back in on a new device — keep it safe. Rotating replaces it with a new one.'}
              </p>
            </>
          )}

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
          {reveal ? (
            <button
              type="button"
              className="github-import-action primary"
              disabled={!savedConfirmed}
              onClick={() => void dismissReveal()}
            >
              Done
            </button>
          ) : (
            <button type="button" className="github-import-action" onClick={onClose} disabled={busy}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
