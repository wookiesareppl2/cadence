import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  ProjectSessionSidebar,
  SessionDetailDrawer,
  SessionHistoryPanel,
  useProjectSessionBrowserState,
  useSessionHistory
} from '@renderer/components/session-browser'
import type { ProjectSessionGroup } from '@renderer/components/session-browser'
import type { ClaudePlanUsage, PlanUsageRefreshMeta, UsageWindow } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import type { TerminalPlatform, TerminalStartResult } from '@shared/terminal'

const PLAN_POLL_INTERVAL_MS = 60_000

// A bump in `nonce` re-triggers a terminal (re)start in `cwd`, even if the same
// project is started twice in a row.
type TerminalStartRequest = { cwd: string; nonce: number }
type PlanUsageDisplay = {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  fetchedAt: string
  refresh?: PlanUsageRefreshMeta
}
type PlanUsageState<T extends PlanUsageDisplay> = {
  planUsage: T | null
  planError: string | null
  refreshing: boolean
}
type PlanUsageStates = {
  claude: PlanUsageState<ClaudePlanUsage>
  codex: PlanUsageState<CodexPlanUsage>
}

export function App(): JSX.Element {
  const [platform, setPlatform] = useState<PlatformId>('claude')
  const planUsageStates = usePlanUsagePolling()
  const [selectedSessionIds, setSelectedSessionIds] = useState<Record<PlatformId, string | null>>({
    claude: null,
    codex: null
  })
  const [selectedProjectIds, setSelectedProjectIds] = useState<Record<PlatformId, string | null>>({
    claude: null,
    codex: null
  })
  const [sessionDetailOpen, setSessionDetailOpen] = useState<Record<PlatformId, boolean>>({
    claude: false,
    codex: false
  })
  const activePlatform = PLATFORM_CONFIG[platform]

  const selectClaudeSession = useCallback((sessionId: string | null) => {
    setSelectedSessionIds((current) =>
      current.claude === sessionId ? current : { ...current, claude: sessionId }
    )
  }, [])

  const selectClaudeProject = useCallback((projectId: string | null) => {
    setSelectedProjectIds((current) =>
      current.claude === projectId ? current : { ...current, claude: projectId }
    )
  }, [])

  const selectCodexSession = useCallback((sessionId: string | null) => {
    setSelectedSessionIds((current) => (current.codex === sessionId ? current : { ...current, codex: sessionId }))
  }, [])

  const selectCodexProject = useCallback((projectId: string | null) => {
    setSelectedProjectIds((current) => (current.codex === projectId ? current : { ...current, codex: projectId }))
  }, [])

  const toggleClaudeSessionDetail = useCallback(() => {
    setSessionDetailOpen((current) => ({ ...current, claude: !current.claude }))
  }, [])

  const toggleCodexSessionDetail = useCallback(() => {
    setSessionDetailOpen((current) => ({ ...current, codex: !current.codex }))
  }, [])

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
      {platform === 'claude' ? (
        <ClaudeWorkspace
          usageState={planUsageStates.claude}
          selectedProjectId={selectedProjectIds.claude}
          selectedSessionId={selectedSessionIds.claude}
          sessionDetailOpen={sessionDetailOpen.claude}
          onSelectedProjectIdChange={selectClaudeProject}
          onSelectedSessionIdChange={selectClaudeSession}
          onToggleSessionDetail={toggleClaudeSessionDetail}
        />
      ) : (
        <CodexWorkspace
          usageState={planUsageStates.codex}
          selectedProjectId={selectedProjectIds.codex}
          selectedSessionId={selectedSessionIds.codex}
          sessionDetailOpen={sessionDetailOpen.codex}
          onSelectedProjectIdChange={selectCodexProject}
          onSelectedSessionIdChange={selectCodexSession}
          onToggleSessionDetail={toggleCodexSessionDetail}
        />
      )}
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

function usePlanUsagePolling(): PlanUsageStates {
  const [states, setStates] = useState<PlanUsageStates>({
    claude: { planUsage: null, planError: null, refreshing: false },
    codex: { planUsage: null, planError: null, refreshing: false }
  })

  const fetchPlan = useCallback((platform: PlatformId) => {
    const loader =
      platform === 'claude'
        ? window.dashboard?.usage?.getClaudePlanUsage
        : window.dashboard?.usage?.getCodexPlanUsage

    if (!loader) {
      setStates((current) => ({
        ...current,
        [platform]: {
          ...current[platform],
          planError: `${PLATFORM_CONFIG[platform].label} usage API unavailable`,
          refreshing: false
        }
      }))
      return
    }

    setStates((current) => ({
      ...current,
      [platform]: { ...current[platform], refreshing: true }
    }))

    loader()
      .then((usage) => {
        setStates((current) => ({
          ...current,
          [platform]: { planUsage: usage, planError: null, refreshing: false }
        }))
      })
      .catch((err: unknown) => {
        setStates((current) => ({
          ...current,
          [platform]: {
            ...current[platform],
            planError: err instanceof Error ? err.message : `${PLATFORM_CONFIG[platform].label} usage refresh failed`,
            refreshing: false
          }
        }))
      })
  }, [])

  useEffect(() => {
    fetchPlan('claude')
    fetchPlan('codex')
    const id = setInterval(() => {
      fetchPlan('claude')
      fetchPlan('codex')
    }, PLAN_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchPlan])

  return states
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

function ClaudeWorkspace({
  usageState,
  selectedProjectId,
  selectedSessionId,
  sessionDetailOpen,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange,
  onToggleSessionDetail
}: {
  usageState: PlanUsageState<ClaudePlanUsage>
  selectedProjectId: string | null
  selectedSessionId: string | null
  sessionDetailOpen: boolean
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
  onToggleSessionDetail: () => void
}): JSX.Element {
  const { planUsage, planError } = usageState
  const sessionBrowser = useProjectSessionBrowserState({
    platform: 'claude',
    selectedProjectId,
    selectedSessionId,
    onSelectedProjectIdChange,
    onSelectedSessionIdChange
  })
  const historyState = useSessionHistory(sessionBrowser.selectedSession)
  const [startRequest, setStartRequest] = useState<TerminalStartRequest | null>(null)
  const startSession = useCallback((project: ProjectSessionGroup) => {
    if (project.path) setStartRequest({ cwd: project.path, nonce: Date.now() })
  }, [])

  const statusLabel = planError
    ? 'error'
    : planUsage
      ? 'live'
      : 'connecting'

  return (
    <main className="workspace">
      <ProjectSessionSidebar
        title="Projects"
        ariaLabel="Claude projects"
        emptyLabel="No Claude projects found"
        browser={sessionBrowser}
        onStartSession={startSession}
      />

      <section
        className={`content-grid ${sessionDetailOpen ? 'detail-open' : 'detail-closed'}`}
        aria-label="Claude Code dashboard"
      >
        <UsageStrip
          planUsage={planUsage}
          planError={planError}
          loadingLabel="Fetching Claude usage"
        />

        <div className="main-stack">
          <SessionHistoryPanel session={sessionBrowser.selectedSession} historyState={historyState} />
          <section className="panel terminal-panel claude-terminal-panel">
            <TerminalPane
              platform="claude"
              title="Claude Terminal"
              statusLabel={statusLabel}
              startRequest={startRequest}
            />
          </section>
        </div>
        <SessionDetailDrawer
          session={sessionBrowser.selectedSession}
          emptyLabel="No Claude session selected"
          open={sessionDetailOpen}
          onToggle={onToggleSessionDetail}
        />
      </section>
    </main>
  )
}

function CodexWorkspace({
  usageState,
  selectedProjectId,
  selectedSessionId,
  sessionDetailOpen,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange,
  onToggleSessionDetail
}: {
  usageState: PlanUsageState<CodexPlanUsage>
  selectedProjectId: string | null
  selectedSessionId: string | null
  sessionDetailOpen: boolean
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
  onToggleSessionDetail: () => void
}): JSX.Element {
  const { planUsage, planError } = usageState
  const sessionBrowser = useProjectSessionBrowserState({
    platform: 'codex',
    selectedProjectId,
    selectedSessionId,
    onSelectedProjectIdChange,
    onSelectedSessionIdChange
  })
  const historyState = useSessionHistory(sessionBrowser.selectedSession)
  const [startRequest, setStartRequest] = useState<TerminalStartRequest | null>(null)
  const startSession = useCallback((project: ProjectSessionGroup) => {
    if (project.path) setStartRequest({ cwd: project.path, nonce: Date.now() })
  }, [])
  const statusLabel = planError ? 'usage error' : planUsage ? 'live' : 'connecting'

  return (
    <main className="workspace">
      <ProjectSessionSidebar
        title="Projects"
        ariaLabel="Codex projects"
        emptyLabel="No Codex projects found"
        browser={sessionBrowser}
        onStartSession={startSession}
      />

      <section
        className={`content-grid ${sessionDetailOpen ? 'detail-open' : 'detail-closed'}`}
        aria-label="Codex dashboard"
      >
        <UsageStrip
          planUsage={planUsage}
          planError={planError}
          loadingLabel="Fetching Codex usage"
        />

        <div className="main-stack">
          <SessionHistoryPanel session={sessionBrowser.selectedSession} historyState={historyState} />
          <section className="panel terminal-panel codex-terminal-panel">
            <TerminalPane
              platform="codex"
              title="Codex Terminal"
              statusLabel={statusLabel}
              startRequest={startRequest}
            />
          </section>
        </div>
        <SessionDetailDrawer
          session={sessionBrowser.selectedSession}
          emptyLabel="No Codex session selected"
          open={sessionDetailOpen}
          onToggle={onToggleSessionDetail}
        />
      </section>
    </main>
  )
}

function TerminalPane({
  platform,
  title,
  statusLabel,
  startRequest
}: {
  platform: TerminalPlatform
  title: string
  statusLabel: string
  startRequest?: TerminalStartRequest | null
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const handledStartNonceRef = useRef<number | null>(null)
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

  useEffect(() => {
    if (!startRequest || handledStartNonceRef.current === startRequest.nonce) return
    const terminal = terminalRef.current
    if (!terminal) return

    handledStartNonceRef.current = startRequest.nonce
    setError(null)
    terminal.reset()
    window.dashboard.terminal
      .start(platform, startRequest.cwd)
      .then((result) => {
        setSession(result)
        if (result.replay) terminal.write(result.replay)
        fitTerminal()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to start session')
      })
  }, [startRequest, platform, fitTerminal])

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

function UsageStrip({
  planUsage,
  planError,
  loadingLabel
}: {
  planUsage: PlanUsageDisplay | null
  planError: string | null
  loadingLabel: string
}): JSX.Element {
  const refreshLabel = planUsage ? usageRefreshLabel(planUsage, planError) : null
  const refreshTitle = planUsage ? planError ?? planUsage.refresh?.message ?? undefined : undefined

  return (
    <div className="usage-strip">
      {planUsage?.fiveHour ? (
        <UsageBar
          label="5-Hour Usage"
          utilization={planUsage.fiveHour.utilization}
          resetsAt={planUsage.fiveHour.resetsAt}
          refreshLabel={refreshLabel}
          refreshTitle={refreshTitle}
        />
      ) : (
        <UsageBarPlaceholder label="5-Hour Usage" message={planError ?? loadingLabel} />
      )}
      {planUsage?.sevenDay ? (
        <UsageBar
          label="Weekly Usage"
          utilization={planUsage.sevenDay.utilization}
          resetsAt={planUsage.sevenDay.resetsAt}
          refreshLabel={refreshLabel}
          refreshTitle={refreshTitle}
        />
      ) : (
        <UsageBarPlaceholder label="Weekly Usage" message={planError ? 'Waiting for safe retry' : loadingLabel} />
      )}
    </div>
  )
}

function usageRefreshLabel(
  usage: PlanUsageDisplay,
  error: string | null
): string {
  if (error) return 'Refresh error'
  if (usage.refresh?.state === 'rate_limited') return 'Rate limited'
  return `Updated ${formatUsageFetchedAt(usage.fetchedAt)}`
}

function formatUsageFetchedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function UsageBarPlaceholder({ label, message }: { label: string; message: string }): JSX.Element {
  return (
    <div className="usage-bar-card usage-bar-placeholder">
      <div className="usage-bar-header">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">--</span>
      </div>
      <div className="usage-bar-track">
        <div className="usage-bar-fill" style={{ width: '0%' }} />
      </div>
      <div className="usage-bar-footer">
        <span className="usage-bar-refresh">{message}</span>
        <span className="usage-bar-reset">--</span>
      </div>
    </div>
  )
}

function UsageBar({
  label,
  utilization,
  resetsAt,
  refreshLabel,
  refreshTitle,
  subtitle
}: {
  label: string
  utilization: number
  resetsAt: string | null
  refreshLabel?: string | null
  refreshTitle?: string
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
        {refreshLabel ? (
          <span className="usage-bar-refresh" title={refreshTitle}>
            {refreshLabel}
          </span>
        ) : (
          <span />
        )}
        <span className="usage-bar-reset">{subtitle ?? countdown}</span>
      </div>
    </div>
  )
}
