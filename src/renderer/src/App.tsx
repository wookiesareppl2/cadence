import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { ClaudePlanUsage } from '@shared/claude-plan-usage'
import { claudeSessions } from '@platforms/claude/fixtures'
import { codexSessions, codexUsageState } from '@platforms/codex/fixtures'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import type { TerminalPlatform, TerminalStartResult } from '@shared/terminal'

const PLAN_POLL_INTERVAL_MS = 180_000

export function App(): JSX.Element {
  const [platform, setPlatform] = useState<PlatformId>('claude')
  const activePlatform = PLATFORM_CONFIG[platform]

  const cssVars = useMemo(
    () =>
      ({
        '--accent': activePlatform.accent,
        '--accent-dim': activePlatform.accentDim,
        '--accent-hover': activePlatform.accentHover
      }) as React.CSSProperties,
    [activePlatform]
  )

  return (
    <div className="app-shell" style={cssVars} data-platform={platform}>
      <Titlebar platform={platform} onPlatformChange={setPlatform} />
      {platform === 'claude' ? <ClaudeWorkspace /> : <CodexWorkspace />}
    </div>
  )
}

function Titlebar({
  platform,
  onPlatformChange
}: {
  platform: PlatformId
  onPlatformChange: (platform: PlatformId) => void
}): JSX.Element {
  return (
    <header className="titlebar">
      <div className="platform-switcher" role="tablist" aria-label="Platform">
        {Object.values(PLATFORM_CONFIG).map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={platform === item.id}
            className={platform === item.id ? 'active' : 'inactive'}
            onClick={() => onPlatformChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="window-controls">
        <button type="button" aria-label="Minimize" onClick={() => window.dashboard.window.minimize()}>
          -
        </button>
        <button type="button" aria-label="Maximize" onClick={() => window.dashboard.window.toggleMaximize()}>
          □
        </button>
        <button type="button" aria-label="Close" className="close" onClick={() => window.dashboard.window.close()}>
          x
        </button>
      </div>
    </header>
  )
}

function useClaudePlanUsage(): { planUsage: ClaudePlanUsage | null; planError: string | null } {
  const [planUsage, setPlanUsage] = useState<ClaudePlanUsage | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)

  const fetchPlan = useCallback(() => {
    if (!window.dashboard?.usage?.getClaudePlanUsage) return
    window.dashboard.usage
      .getClaudePlanUsage()
      .then(setPlanUsage)
      .catch((err: unknown) => setPlanError(err instanceof Error ? err.message : 'Failed to fetch plan usage'))
  }, [])

  useEffect(() => {
    fetchPlan()
    const id = setInterval(fetchPlan, PLAN_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchPlan])

  return { planUsage, planError }
}

function useCountdown(resetsAt: string | null): string {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!resetsAt) return
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [resetsAt])

  if (!resetsAt) return '--'

  const diffMs = new Date(resetsAt).getTime() - now
  if (diffMs <= 0) return 'Resetting...'

  const totalMin = Math.floor(diffMs / 60_000)
  const hours = Math.floor(totalMin / 60)
  const mins = totalMin % 60

  if (hours > 0) return `Resets in ${hours} hr ${mins} min`
  return `Resets in ${mins} min`
}

function barTier(pct: number): string {
  if (pct >= 80) return 'critical'
  if (pct >= 60) return 'warning'
  return 'normal'
}

function ClaudeWorkspace(): JSX.Element {
  const { planUsage, planError } = useClaudePlanUsage()

  const statusLabel = planError
    ? 'error'
    : planUsage
      ? 'live'
      : 'connecting'

  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="Claude sessions">
        <div className="sidebar-header">
          <h2>Sessions</h2>
          <button type="button" className="icon-button" aria-label="New session">
            +
          </button>
        </div>
        <input className="sidebar-search" placeholder="Search sessions" aria-label="Search sessions" />
        <div className="session-list">
          {claudeSessions.map((session, index) => (
            <button key={session.id} type="button" className={`session-item ${index === 0 ? 'active' : ''}`}>
              <span className="session-title">{session.title}</span>
              <span className="session-project">{session.project}</span>
              <span className="session-meta">
                <span>{session.branch}</span>
                <span>{session.tokens}</span>
                <span>{session.age}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="content-grid" aria-label="Claude Code dashboard">
        <div className="usage-strip">
          {planError ? (
            <div className="usage-error">{planError}</div>
          ) : !planUsage ? (
            <div className="usage-loading">Fetching usage data...</div>
          ) : (
            <>
              {planUsage.fiveHour && (
                <UsageBar
                  label="5-Hour Usage"
                  utilization={planUsage.fiveHour.utilization}
                  resetsAt={planUsage.fiveHour.resetsAt}
                />
              )}
              {planUsage.sevenDay && (
                <UsageBar
                  label="Weekly Usage"
                  utilization={planUsage.sevenDay.utilization}
                  resetsAt={planUsage.sevenDay.resetsAt}
                />
              )}
            </>
          )}
        </div>

        <section className="panel terminal-panel claude-terminal-panel">
          <TerminalPane platform="claude" title="Claude Terminal" statusLabel={statusLabel} />
        </section>
      </section>
    </main>
  )
}

function CodexWorkspace(): JSX.Element {
  return (
    <main className="workspace">
      <aside className="sidebar" aria-label="Codex sessions">
        <div className="sidebar-header">
          <h2>Codex</h2>
        </div>
        <div className="session-action-group">
          <button type="button" className="primary-action">
            New Codex Session
          </button>
          <button type="button" className="secondary-action">
            Attach Workspace
          </button>
        </div>
        <div className="session-list">
          {codexSessions.map((session, index) => (
            <button key={session.id} type="button" className={`session-item ${index === 0 ? 'active' : ''}`}>
              <span className="session-title">{session.title}</span>
              <span className="session-project">{session.project}</span>
              <span className="session-meta">
                <span>{session.status}</span>
                <span>{session.age}</span>
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="content-grid" aria-label="Codex dashboard">
        <section className="panel codex-usage">
          <div className="panel-header">
            <h1>{codexUsageState.headline}</h1>
            <span className="status-pill">not configured</span>
          </div>
          <p className="muted-copy">{codexUsageState.detail}</p>
          <dl className="fact-list">
            {codexUsageState.telemetry.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="panel terminal-panel">
          <TerminalPane platform="codex" title="Codex Terminal" statusLabel="live" />
        </section>
      </section>
    </main>
  )
}

function TerminalPane({
  platform,
  title,
  statusLabel
}: {
  platform: TerminalPlatform
  title: string
  statusLabel: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [session, setSession] = useState<TerminalStartResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return

    fitAddon.fit()
    window.dashboard.terminal.resize(platform, terminal.cols, terminal.rows)
  }, [platform])

  const restartTerminal = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.clear()
    setError(null)
    window.dashboard.terminal
      .restart(platform)
      .then((result) => {
        setSession(result)
        if (result.replay) terminal.write(result.replay)
        fitTerminal()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Terminal restart failed')
      })
  }, [fitTerminal, platform])

  useEffect(() => {
    if (!hostRef.current) return

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 6000,
      theme: {
        background: '#191614',
        foreground: '#e7ded7',
        cursor: '#e07a5f',
        selectionBackground: '#3b322d',
        black: '#1e1b19',
        blue: '#7aa2d6',
        brightBlack: '#5e544d',
        brightBlue: '#9dc1ee',
        brightCyan: '#9ad7d4',
        brightGreen: '#a7cbb8',
        brightMagenta: '#d7a8c7',
        brightRed: '#e07a5f',
        brightWhite: '#f2ebe6',
        brightYellow: '#e2c178',
        cyan: '#81bfc0',
        green: '#81b29a',
        magenta: '#c793b7',
        red: '#c95f4c',
        white: '#e7ded7',
        yellow: '#d5aa5f'
      }
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(hostRef.current)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const dataDisposable = terminal.onData((data) => window.dashboard.terminal.input(platform, data))
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      window.dashboard.terminal.resize(platform, cols, rows)
    })
    const removeDataListener = window.dashboard.terminal.onData((event) => {
      if (event.platform === platform) terminal.write(event.data)
    })
    const observer = new ResizeObserver(() => window.requestAnimationFrame(fitTerminal))

    observer.observe(hostRef.current)
    window.requestAnimationFrame(fitTerminal)
    window.dashboard.terminal
      .start(platform)
      .then((result) => {
        setSession(result)
        if (result.replay) terminal.write(result.replay)
        fitTerminal()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Terminal failed to start')
      })

    return () => {
      observer.disconnect()
      removeDataListener()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [fitTerminal, platform])

  const shellLabel = session ? `${session.shell} pid ${session.pid}` : 'starting'

  return (
    <>
      <div className="panel-header terminal-header">
        <div className="terminal-heading">
          <h1>{title}</h1>
          <span>{shellLabel}</span>
        </div>
        <div className="terminal-actions">
          <span className="status-pill">{error ? 'error' : statusLabel}</span>
          <button type="button" className="terminal-action" onClick={restartTerminal}>
            Restart
          </button>
        </div>
      </div>
      {error ? <div className="terminal-error">{error}</div> : null}
      <div ref={hostRef} className="terminal-surface" aria-label={title} />
    </>
  )
}

function UsageBar({
  label,
  utilization,
  resetsAt,
  subtitle
}: {
  label: string
  utilization: number
  resetsAt: string | null
  subtitle?: string
}): JSX.Element {
  const countdown = useCountdown(resetsAt)
  const pct = Math.min(100, Math.max(0, Math.round(utilization)))
  const tier = barTier(pct)

  return (
    <div className="usage-bar-card" data-tier={tier}>
      <div className="usage-bar-header">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{pct}%</span>
      </div>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="usage-bar-footer">
        <span className="usage-bar-reset">{subtitle ?? countdown}</span>
      </div>
    </div>
  )
}
