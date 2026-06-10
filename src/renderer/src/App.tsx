import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import {
  NEW_SESSION_ID,
  SessionDetailAccordion,
  SessionHistorySidebar,
  ProjectSessionSidebar,
  useProjectSessionBrowserState,
  useSessionHistory
} from '@renderer/components/session-browser'
import type { ProjectSessionGroup } from '@renderer/components/session-browser'
import { TerminalDeck, useTerminalDeck } from '@renderer/components/terminal-deck'
import type { ClaudePlanUsage, PlanUsageRefreshMeta, UsageWindow } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'

const PLAN_POLL_INTERVAL_MS = 60_000
const HISTORY_SIDEBAR_CLOSED_WIDTH = 32
const HISTORY_SIDEBAR_MOTION_MS = 180
const HISTORY_SIDEBAR_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'

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
  const [selectedSessionIds, setSelectedSessionIds] = usePersistentState<Record<PlatformId, string | null>>(
    'selection:sessions:v1',
    { claude: null, codex: null },
    // Don't restore the transient "new session" sentinel — start clean instead.
    (value) => ({
      claude: value.claude === NEW_SESSION_ID ? null : value.claude,
      codex: value.codex === NEW_SESSION_ID ? null : value.codex
    })
  )
  const [selectedProjectIds, setSelectedProjectIds] = usePersistentState<Record<PlatformId, string | null>>(
    'selection:projects:v1',
    { claude: null, codex: null }
  )
  const [sessionDetailOpen, setSessionDetailOpen] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:session-detail-accordion:v1',
    { claude: false, codex: false }
  )
  const [historySidebarOpen, setHistorySidebarOpen] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:history-sidebar:v1',
    { claude: false, codex: false }
  )
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

  const toggleClaudeHistorySidebar = useCallback(() => {
    setHistorySidebarOpen((current) => ({ ...current, claude: !current.claude }))
  }, [])

  const toggleCodexHistorySidebar = useCallback(() => {
    setHistorySidebarOpen((current) => ({ ...current, codex: !current.codex }))
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
          historySidebarOpen={historySidebarOpen.claude}
          onSelectedProjectIdChange={selectClaudeProject}
          onSelectedSessionIdChange={selectClaudeSession}
          onToggleSessionDetail={toggleClaudeSessionDetail}
          onToggleHistorySidebar={toggleClaudeHistorySidebar}
        />
      ) : (
        <CodexWorkspace
          usageState={planUsageStates.codex}
          selectedProjectId={selectedProjectIds.codex}
          selectedSessionId={selectedSessionIds.codex}
          sessionDetailOpen={sessionDetailOpen.codex}
          historySidebarOpen={historySidebarOpen.codex}
          onSelectedProjectIdChange={selectCodexProject}
          onSelectedSessionIdChange={selectCodexSession}
          onToggleSessionDetail={toggleCodexSessionDetail}
          onToggleHistorySidebar={toggleCodexHistorySidebar}
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
  const [version, setVersion] = useState<string>('')
  useEffect(() => {
    window.dashboard?.app?.getVersion?.().then(setVersion).catch(() => undefined)
  }, [])
  return (
    <header className="titlebar">
      {version ? (
        <span className="app-version" title={`AI Dashboard v${version}`}>
          v{version}
        </span>
      ) : null}
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

// Persist a small record of UI state to localStorage so the workspace reopens
// where the user left it. Stored values are merged over the fallback (tolerates
// shape changes) and an optional `revive` sanitizes the loaded value. Stale ids
// are harmless: the session browser falls back to a valid selection when an id no
// longer exists.
function usePersistentState<T extends object>(
  key: string,
  fallback: T,
  revive?: (value: T) => T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        const merged = { ...fallback, ...(JSON.parse(raw) as Partial<T>) } as T
        return revive ? revive(merged) : merged
      }
    } catch {
      // Corrupt/unavailable storage falls back to defaults.
    }
    return fallback
  })

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Persistence is best-effort.
    }
  }, [key, value])

  return [value, setValue]
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

function useHistorySidebarMotion(
  open: boolean,
  onToggle: () => void
): {
  contentBodyRef: React.RefObject<HTMLDivElement | null>
  toggleHistorySidebar: () => void
} {
  const contentBodyRef = useRef<HTMLDivElement | null>(null)
  const animationsRef = useRef<Animation[]>([])

  const clearAnimations = useCallback(() => {
    for (const animation of animationsRef.current) {
      animation.cancel()
    }
    animationsRef.current = []
  }, [])

  useEffect(() => clearAnimations, [clearAnimations])

  const toggleHistorySidebar = useCallback(() => {
    const body = contentBodyRef.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!body || reducedMotion) {
      onToggle()
      return
    }

    const mainStack = body.querySelector<HTMLElement>('.main-stack')
    const historyShell = body.querySelector<HTMLElement>('.history-sidebar-shell')
    if (!mainStack || !historyShell) {
      onToggle()
      return
    }

    clearAnimations()

    if (!open) {
      const firstMain = mainStack.getBoundingClientRect()
      const firstShell = historyShell.getBoundingClientRect()
      onToggle()

      window.requestAnimationFrame(() => {
        const lastMain = mainStack.getBoundingClientRect()
        const lastShell = historyShell.getBoundingClientRect()
        const mainScale = firstMain.width / Math.max(lastMain.width, 1)
        const shellClip = Math.max(lastShell.width - firstShell.width, 0)

        animationsRef.current = [
          mainStack.animate(
            [{ transform: `scaleX(${mainScale})` }, { transform: 'scaleX(1)' }],
            {
              duration: HISTORY_SIDEBAR_MOTION_MS,
              easing: HISTORY_SIDEBAR_EASING
            }
          ),
          historyShell.animate(
            [{ clipPath: `inset(0 0 0 ${shellClip}px)` }, { clipPath: 'inset(0 0 0 0)' }],
            {
              duration: HISTORY_SIDEBAR_MOTION_MS,
              easing: HISTORY_SIDEBAR_EASING
            }
          )
        ]
      })
      return
    }

    const bodyRect = body.getBoundingClientRect()
    const mainRect = mainStack.getBoundingClientRect()
    const shellRect = historyShell.getBoundingClientRect()
    const bodyStyles = window.getComputedStyle(body)
    const gap = Number.parseFloat(bodyStyles.columnGap || bodyStyles.gap || '0') || 0
    const finalMainWidth = Math.max(
      bodyRect.width - gap - HISTORY_SIDEBAR_CLOSED_WIDTH,
      mainRect.width
    )
    const mainScale = finalMainWidth / Math.max(mainRect.width, 1)
    const shellClip = Math.max(shellRect.width - HISTORY_SIDEBAR_CLOSED_WIDTH, 0)

    const mainAnimation = mainStack.animate(
      [{ transform: 'scaleX(1)' }, { transform: `scaleX(${mainScale})` }],
      {
        duration: HISTORY_SIDEBAR_MOTION_MS,
        easing: HISTORY_SIDEBAR_EASING,
        fill: 'forwards'
      }
    )
    const shellAnimation = historyShell.animate(
      [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: `inset(0 0 0 ${shellClip}px)` }],
      {
        duration: HISTORY_SIDEBAR_MOTION_MS,
        easing: HISTORY_SIDEBAR_EASING,
        fill: 'forwards'
      }
    )
    animationsRef.current = [mainAnimation, shellAnimation]

    shellAnimation.finished
      .then(() => {
        onToggle()
        window.requestAnimationFrame(clearAnimations)
      })
      .catch(() => undefined)
  }, [clearAnimations, onToggle, open])

  return { contentBodyRef, toggleHistorySidebar }
}

function ClaudeWorkspace({
  usageState,
  selectedProjectId,
  selectedSessionId,
  sessionDetailOpen,
  historySidebarOpen,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange,
  onToggleSessionDetail,
  onToggleHistorySidebar
}: {
  usageState: PlanUsageState<ClaudePlanUsage>
  selectedProjectId: string | null
  selectedSessionId: string | null
  sessionDetailOpen: boolean
  historySidebarOpen: boolean
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
  onToggleSessionDetail: () => void
  onToggleHistorySidebar: () => void
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
  const { tabs, addTerminal, closeTerminal, resetTerminals } = useTerminalDeck('claude')
  const { contentBodyRef, toggleHistorySidebar } = useHistorySidebarMotion(
    historySidebarOpen,
    onToggleHistorySidebar
  )
  const newSession = selectedSessionId === NEW_SESSION_ID
  const startSession = useCallback(
    (project: ProjectSessionGroup) => {
      if (!project.path) return
      resetTerminals(project.path, project.name)
      onSelectedSessionIdChange(NEW_SESSION_ID)
    },
    [resetTerminals, onSelectedSessionIdChange]
  )

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

      <section className="content-grid" aria-label="Claude Code dashboard">
        <UsageStrip
          planUsage={planUsage}
          planError={planError}
          loadingLabel="Fetching Claude usage"
        />

        <div
          ref={contentBodyRef}
          className={`content-body ${historySidebarOpen ? 'history-open' : 'history-closed'}`}
        >
          <div className="main-stack">
            <SessionDetailAccordion
              session={sessionBrowser.selectedSession}
              emptyLabel="No Claude session selected"
              open={sessionDetailOpen}
              onToggle={onToggleSessionDetail}
            />
            <TerminalDeck
              platform="claude"
              tabs={tabs}
              defaultCwd={sessionBrowser.selectedProject?.path ?? null}
              projectName={sessionBrowser.selectedProject?.name ?? null}
              statusLabel={statusLabel}
              onAdd={addTerminal}
              onClose={closeTerminal}
            />
          </div>
          <SessionHistorySidebar
            session={sessionBrowser.selectedSession}
            historyState={historyState}
            newSession={newSession}
            open={historySidebarOpen}
            onToggle={toggleHistorySidebar}
          />
        </div>
      </section>
    </main>
  )
}

function CodexWorkspace({
  usageState,
  selectedProjectId,
  selectedSessionId,
  sessionDetailOpen,
  historySidebarOpen,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange,
  onToggleSessionDetail,
  onToggleHistorySidebar
}: {
  usageState: PlanUsageState<CodexPlanUsage>
  selectedProjectId: string | null
  selectedSessionId: string | null
  sessionDetailOpen: boolean
  historySidebarOpen: boolean
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
  onToggleSessionDetail: () => void
  onToggleHistorySidebar: () => void
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
  const { tabs, addTerminal, closeTerminal, resetTerminals } = useTerminalDeck('codex')
  const { contentBodyRef, toggleHistorySidebar } = useHistorySidebarMotion(
    historySidebarOpen,
    onToggleHistorySidebar
  )
  const newSession = selectedSessionId === NEW_SESSION_ID
  const startSession = useCallback(
    (project: ProjectSessionGroup) => {
      if (!project.path) return
      resetTerminals(project.path, project.name)
      onSelectedSessionIdChange(NEW_SESSION_ID)
    },
    [resetTerminals, onSelectedSessionIdChange]
  )
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

      <section className="content-grid" aria-label="Codex dashboard">
        <UsageStrip
          planUsage={planUsage}
          planError={planError}
          loadingLabel="Fetching Codex usage"
        />

        <div
          ref={contentBodyRef}
          className={`content-body ${historySidebarOpen ? 'history-open' : 'history-closed'}`}
        >
          <div className="main-stack">
            <SessionDetailAccordion
              session={sessionBrowser.selectedSession}
              emptyLabel="No Codex session selected"
              open={sessionDetailOpen}
              onToggle={onToggleSessionDetail}
            />
            <TerminalDeck
              platform="codex"
              tabs={tabs}
              defaultCwd={sessionBrowser.selectedProject?.path ?? null}
              projectName={sessionBrowser.selectedProject?.name ?? null}
              statusLabel={statusLabel}
              onAdd={addTerminal}
              onClose={closeTerminal}
            />
          </div>
          <SessionHistorySidebar
            session={sessionBrowser.selectedSession}
            historyState={historyState}
            newSession={newSession}
            open={historySidebarOpen}
            onToggle={toggleHistorySidebar}
          />
        </div>
      </section>
    </main>
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
