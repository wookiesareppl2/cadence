import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import type { PlatformSetup, SetupAction, SetupStatus } from '@shared/setup'
import { TerminalPane } from '../terminal-deck'
import './setup.css'

const POLL_INTERVAL_MS = 2_500

type RunningAction = { platform: PlatformId; action: SetupAction; command: string; label: string }

// First-run onboarding. Detects whether each CLI is installed + signed in, and
// walks the user through installing / connecting whichever they want — running the
// official command in an embedded terminal and watching the status flip. The app
// can be entered once at least one platform is connected (or skipped entirely).
export function SetupGate({
  onDone,
  mode = 'onboarding'
}: {
  onDone: () => void
  // 'onboarding' = first-run gate (Skip / Continue). 'manage' = re-opened from the
  // titlebar to connect or disconnect tools later (single Done button).
  mode?: 'onboarding' | 'manage'
}): JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [running, setRunning] = useState<RunningAction | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.dashboard.setup.getStatus())
    } catch {
      // Leave the last known status; the next poll retries.
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // While onboarding is open, poll so an install / sign-in that finishes in the
  // embedded terminal flips the cards without the user pressing anything.
  useEffect(() => {
    const id = window.setInterval(refresh, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  const startAction = useCallback(async (platform: PlatformId, action: SetupAction) => {
    const command = await window.dashboard.setup.getCommand(platform, action)
    setRunning({ platform, action, command: command.command, label: command.label })
  }, [])

  const stopAction = useCallback(() => {
    setRunning((current) => {
      if (current) window.dashboard.terminal.close(terminalIdFor(current))
      return null
    })
    void refresh()
  }, [refresh])

  const disconnect = useCallback(
    async (platform: PlatformId) => {
      await window.dashboard.setup.disconnect(platform)
      await refresh()
    },
    [refresh]
  )

  // Escape closes the gate (matching the app's other overlays); while a setup
  // command is running it first closes that embedded terminal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (running) stopAction()
      else onDone()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [running, stopAction, onDone])

  const anyConnected = Boolean(status && (status.claude.connected || status.codex.connected))

  return (
    <div className="setup-gate" role="dialog" aria-modal="true" aria-label="Set up Cadence">
      <div className="setup-panel">
        <header className="setup-head">
          <h1>{mode === 'manage' ? 'Connections' : 'Welcome to Cadence'}</h1>
          <p>
            {mode === 'manage'
              ? 'Connect or disconnect your AI coding tools. Cadence detects and sets them up for you.'
              : 'Connect the AI coding tools you use. Cadence detects and sets them up for you — pick one or both. You can change this later.'}
          </p>
        </header>

        <div className="setup-cards">
          {(Object.keys(PLATFORM_CONFIG) as PlatformId[]).map((platform) => (
            <SetupCard
              key={platform}
              platform={platform}
              setup={status?.[platform] ?? null}
              busy={running?.platform === platform}
              onInstall={() => startAction(platform, 'install')}
              onConnect={() => startAction(platform, 'connect')}
              onDisconnect={() => disconnect(platform)}
            />
          ))}
        </div>

        {running ? (
          <section className="setup-runner" aria-label={running.label}>
            <div className="setup-runner-head">
              <span className="setup-runner-label">{running.label}</span>
              <span className="setup-runner-hint">
                {running.action === 'install'
                  ? 'When it finishes, restart Cadence so it picks up the newly installed tool.'
                  : 'Complete the sign-in that opens in your browser, then come back here.'}
              </span>
              {running.action === 'install' ? (
                <button
                  type="button"
                  className="setup-runner-close"
                  onClick={() => window.dashboard.app.relaunch()}
                >
                  Restart Cadence
                </button>
              ) : null}
              <button type="button" className="setup-runner-close" onClick={stopAction}>
                Done
              </button>
            </div>
            <div className="setup-runner-terminal">
              <TerminalPane
                key={terminalIdFor(running)}
                terminalId={terminalIdFor(running)}
                platform={running.platform}
                cwd={null}
                wslDistro={null}
                title={`${PLATFORM_CONFIG[running.platform].label} ${running.action}`}
                initialInput={running.command}
                onClose={stopAction}
              />
            </div>
          </section>
        ) : null}

        <footer className="setup-foot">
          <span className="setup-foot-note">
            {anyConnected ? 'You’re connected — you can start using Cadence.' : 'Connect at least one tool to begin.'}
          </span>
          <div className="setup-foot-actions">
            {mode === 'manage' ? (
              <button type="button" className="setup-continue" onClick={onDone}>
                Done
              </button>
            ) : (
              <>
                <button type="button" className="setup-skip" onClick={onDone}>
                  Skip for now
                </button>
                <button type="button" className="setup-continue" disabled={!anyConnected} onClick={onDone}>
                  Continue
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

function terminalIdFor(running: RunningAction): string {
  return `setup-${running.platform}-${running.action}`
}

function SetupCard({
  platform,
  setup,
  busy,
  onInstall,
  onConnect,
  onDisconnect
}: {
  platform: PlatformId
  setup: PlatformSetup | null
  busy: boolean
  onInstall: () => void
  onConnect: () => void
  onDisconnect: () => void
}): JSX.Element {
  const label = PLATFORM_CONFIG[platform].label
  const state = cardState(setup)
  // Two-step inline confirm for the (recoverable) disconnect, per the design system.
  const [confirming, setConfirming] = useState(false)

  return (
    <div className="setup-card" data-state={state.key} data-platform={platform}>
      <div className="setup-card-head">
        <h2>{label}</h2>
        <span className={`setup-status setup-status-${state.key}`}>{state.status}</span>
      </div>
      {setup?.version ? <p className="setup-card-version">{setup.version}</p> : null}
      <div className="setup-card-action">
        {state.key === 'checking' ? (
          <span className="setup-card-checking">Checking…</span>
        ) : state.key === 'connected' ? (
          <div className="setup-card-connected">
            <span className="setup-card-done">✓ Connected</span>
            {confirming ? (
              <span className="setup-card-confirm">
                <span>Sign out?</span>
                <button
                  type="button"
                  className="setup-card-confirm-yes"
                  onClick={() => {
                    setConfirming(false)
                    onDisconnect()
                  }}
                >
                  Yes
                </button>
                <button type="button" className="setup-card-confirm-no" onClick={() => setConfirming(false)}>
                  No
                </button>
              </span>
            ) : (
              <button type="button" className="setup-card-disconnect" onClick={() => setConfirming(true)}>
                Disconnect
              </button>
            )}
          </div>
        ) : state.key === 'not-installed' ? (
          <button type="button" className="setup-action" disabled={busy} onClick={onInstall}>
            Set up {label}
          </button>
        ) : (
          <button type="button" className="setup-action" disabled={busy} onClick={onConnect}>
            Connect
          </button>
        )}
      </div>
    </div>
  )
}

function cardState(setup: PlatformSetup | null): { key: string; status: string } {
  if (!setup) return { key: 'checking', status: 'Checking' }
  if (setup.connected) return { key: 'connected', status: 'Ready' }
  if (setup.installed) return { key: 'not-connected', status: 'Installed — not connected' }
  return { key: 'not-installed', status: 'Not set up yet' }
}
