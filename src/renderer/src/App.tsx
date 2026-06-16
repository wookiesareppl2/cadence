import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import {
  createPendingSessionId,
  isPendingSessionId,
  SessionDetailAccordion,
  SessionHistorySidebar,
  ProjectSessionSidebar,
  useProjectSessionBrowserState,
  useSessionHistory
} from '@renderer/components/session-browser'
import type { ProjectSessionBrowserState, ProjectSessionGroup } from '@renderer/components/session-browser'
import { TerminalDeck, useTerminalDeck } from '@renderer/components/terminal-deck'
import type { TerminalTab } from '@renderer/components/terminal-deck'
import type { ClaudePlanUsage, PlanUsageRefreshMeta, UsageWindow } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import type { AssistantSession, SessionOrigin } from '@shared/sessions'

const PLAN_POLL_INTERVAL_MS = 60_000
const HISTORY_SIDEBAR_CLOSED_WIDTH = 32
const HISTORY_SIDEBAR_MOTION_MS = 180
const HISTORY_SIDEBAR_START_OFFSET_MS = -24
const HISTORY_SIDEBAR_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'

// Split the platform's flat terminal list into the selected session's terminals
// (shown in the deck) and the rest, which stay alive in the background. The
// background tally drives the "running in N other sessions" hint so hidden shells
// aren't silently lost.
function partitionTerminalTabs(
  tabs: TerminalTab[],
  selectedSessionId: string | null
): { visibleTabs: TerminalTab[]; backgroundTabCount: number; backgroundSessionCount: number } {
  const visibleTabs: TerminalTab[] = []
  const backgroundSessionKeys = new Set<string>()

  for (const tab of tabs) {
    if (selectedSessionId && tab.sessionKey === selectedSessionId) {
      visibleTabs.push(tab)
    } else {
      backgroundSessionKeys.add(tab.sessionKey)
    }
  }

  return {
    visibleTabs,
    backgroundTabCount: tabs.length - visibleTabs.length,
    backgroundSessionCount: backgroundSessionKeys.size
  }
}

// A started session is selected before its transcript exists on disk, so its
// terminals are tagged with a pending id. The slot remembers where the session
// was started (so the adoption pass can match the transcript when it appears) and
// enough to render the session as a row in the sidebar immediately.
const DEFAULT_PENDING_TITLE = 'New session'
type PendingSessionSlot = {
  id: string
  projectId: string
  projectName: string
  projectPath: string
  origin: SessionOrigin
  title: string
  createdAtMs: number
}

// Render a pending slot as a normal session row so a freshly started session is
// listed (and reselectable) before its transcript exists.
function toPendingSession(slot: PendingSessionSlot, platform: PlatformId): AssistantSession {
  return {
    id: slot.id,
    platform,
    projectId: slot.projectId,
    title: slot.title,
    rawTitle: null,
    inferredTitle: null,
    generatedTitle: null,
    titleSource: 'fallback',
    titleStatus: null,
    titleUpdatedAt: null,
    project: slot.projectName,
    projectPath: slot.projectPath,
    branch: null,
    origin: slot.origin,
    usageLabel: null,
    status: 'pending',
    age: 'new',
    updatedAt: new Date(slot.createdAtMs).toISOString()
  }
}

const PENDING_SESSION_POLL_MS = 5_000
// Only poll aggressively for a short burst after a session is started; past this
// the baseline 60s session poll still adopts, just less eagerly. Bounds the scan
// rate when a "Start session" is left idle (transcript not created yet).
const PENDING_FAST_POLL_WINDOW_MS = 120_000

function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase()
}

// Session-scoped terminal deck: terminals belong to a session, not just a project.
// Starting a session mints a pending slot + first terminal; once the session's
// transcript is discovered it is adopted (terminals + selection retagged onto the
// real id). Other sessions' terminals keep running in the background meanwhile.
function useSessionScopedTerminals(
  platform: PlatformId,
  browser: ProjectSessionBrowserState,
  selectedSessionId: string | null,
  onSelectedSessionIdChange: (sessionId: string | null) => void
): {
  visibleTabs: TerminalTab[]
  backgroundTabCount: number
  backgroundSessionCount: number
  pendingSessions: AssistantSession[]
  addTerminal: (cwd?: string | null, title?: string, wslDistro?: string | null) => void
  closeTerminal: (id: string) => void
  startSession: (project: ProjectSessionGroup) => void
  abandonPendingSession: (id: string) => Promise<{ trashed: number }>
  renamePendingSession: (id: string, title: string | null) => Promise<void>
} {
  const { tabs, addTerminal, closeTerminal, retagSession } = useTerminalDeck(platform)
  const [pending, setPending] = useState<PendingSessionSlot[]>([])
  const { sessions, selectedProject, refreshSessions } = browser

  const { visibleTabs, backgroundTabCount, backgroundSessionCount } = useMemo(
    () => partitionTerminalTabs(tabs, selectedSessionId),
    [tabs, selectedSessionId]
  )

  const pendingSessions = useMemo(() => pending.map((slot) => toPendingSession(slot, platform)), [pending, platform])

  // Creating a session only adds the (empty) session and selects it — the user
  // opens its first terminal explicitly via the deck, same as selecting any other
  // terminal-less session. No shell is auto-spawned.
  const startSession = useCallback(
    (project: ProjectSessionGroup) => {
      if (!project.path) return
      const pendingId = createPendingSessionId()
      setPending((prev) => [
        ...prev,
        {
          id: pendingId,
          projectId: project.id,
          projectName: project.name,
          projectPath: project.path!,
          origin: project.origin,
          title: DEFAULT_PENDING_TITLE,
          createdAtMs: Date.now()
        }
      ])
      onSelectedSessionIdChange(pendingId)
    },
    [onSelectedSessionIdChange]
  )

  // Abandon a started-but-unused session: close its terminals (killing their ptys)
  // and drop the slot. Returns a trashed count so the row's delete control reports
  // success and the synthetic row disappears.
  const abandonPendingSession = useCallback(
    async (id: string): Promise<{ trashed: number }> => {
      for (const tab of tabs) {
        if (tab.sessionKey === id) closeTerminal(tab.id)
      }
      setPending((prev) => prev.filter((slot) => slot.id !== id))
      if (selectedSessionId === id) onSelectedSessionIdChange(null)
      return { trashed: 1 }
    },
    [tabs, closeTerminal, selectedSessionId, onSelectedSessionIdChange]
  )

  const renamePendingSession = useCallback(async (id: string, title: string | null): Promise<void> => {
    setPending((prev) =>
      prev.map((slot) => (slot.id === id ? { ...slot, title: title?.trim() || DEFAULT_PENDING_TITLE } : slot))
    )
  }, [])

  const handleAddTerminal = useCallback(
    (cwd?: string | null, title?: string, wslDistro?: string | null) => {
      // Add to the selected session (real or still-pending); with nothing concrete
      // selected, fall back to starting a new session so the terminal has an owner.
      if (selectedSessionId) {
        addTerminal(selectedSessionId, cwd, title, wslDistro)
      } else if (selectedProject) {
        startSession(selectedProject)
      }
    },
    [addTerminal, selectedProject, selectedSessionId, startSession]
  )

  // Adopt: when the poll reveals a session whose folder matches a waiting pending
  // slot, retag its terminals (and the selection) onto the real id. Oldest slot
  // claims first; each transcript is claimed at most once.
  const knownSessionIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (pending.length > 0) {
      const known = knownSessionIdsRef.current
      const added = sessions.filter((session) => !known.has(session.id))
      if (added.length > 0) {
        const claimed = new Set<string>()
        const adoptions: { from: string; to: string }[] = []
        for (const slot of [...pending].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
          const match = added.find(
            (session) =>
              !claimed.has(session.id) &&
              samePath(session.projectPath, slot.projectPath) &&
              (session.origin?.distro ?? null) === slot.origin.distro
          )
          if (match) {
            claimed.add(match.id)
            adoptions.push({ from: slot.id, to: match.id })
          }
        }
        if (adoptions.length > 0) {
          for (const { from, to } of adoptions) {
            retagSession(from, to)
            if (selectedSessionId === from) onSelectedSessionIdChange(to)
          }
          const adoptedIds = new Set(adoptions.map((adoption) => adoption.from))
          setPending((prev) => prev.filter((slot) => !adoptedIds.has(slot.id)))
        }
      }
    }
    knownSessionIdsRef.current = new Set(sessions.map((session) => session.id))
  }, [sessions, pending, retagSession, selectedSessionId, onSelectedSessionIdChange])

  // Drop pending slots once nothing references them (terminals all closed and not
  // selected), so a never-used "Start session" stops the fast adoption poll.
  useEffect(() => {
    setPending((prev) => {
      const next = prev.filter(
        (slot) => selectedSessionId === slot.id || tabs.some((tab) => tab.sessionKey === slot.id)
      )
      return next.length === prev.length ? prev : next
    })
  }, [tabs, selectedSessionId])

  // While a freshly started session awaits its transcript, poll faster than the
  // 60s baseline so adoption snaps in within a few seconds. Limited to the window
  // just after creation so an idle "+ New Session" doesn't scan the filesystem
  // forever (the baseline poll still adopts a later first prompt within ~60s).
  const fastPollWanted = useCallback(
    () => pending.some((slot) => Date.now() - slot.createdAtMs < PENDING_FAST_POLL_WINDOW_MS),
    [pending]
  )
  useEffect(() => {
    if (pending.length === 0 || !fastPollWanted()) return
    const id = window.setInterval(() => {
      if (!fastPollWanted()) {
        window.clearInterval(id)
        return
      }
      void refreshSessions()
    }, PENDING_SESSION_POLL_MS)
    return () => window.clearInterval(id)
  }, [pending.length, fastPollWanted, refreshSessions])

  return {
    visibleTabs,
    backgroundTabCount,
    backgroundSessionCount,
    pendingSessions,
    addTerminal: handleAddTerminal,
    closeTerminal,
    startSession,
    abandonPendingSession,
    renamePendingSession
  }
}

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
    // Don't restore a transient pending-session selection — start clean instead.
    (value) => ({
      claude: isPendingSessionId(value.claude) ? null : value.claude,
      codex: isPendingSessionId(value.codex) ? null : value.codex
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

function usePersistentPlatformFlag(
  key: string,
  platform: PlatformId,
  fallback = false
): [boolean, () => void] {
  const [value, setValue] = usePersistentState<Record<PlatformId, boolean>>(key, {
    claude: fallback,
    codex: fallback
  })
  const toggle = useCallback(() => {
    setValue((current) => ({ ...current, [platform]: !current[platform] }))
  }, [platform, setValue])

  return [value[platform], toggle]
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
  const days = Math.floor(totalMin / 1_440)
  const hours = Math.floor((totalMin % 1_440) / 60)
  const mins = totalMin % 60

  if (days > 0) return `Resets in ${days} ${days === 1 ? 'day' : 'days'} ${hours} hr ${mins} min`
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
  const closingGhostRef = useRef<HTMLElement | null>(null)

  const cancelAnimations = useCallback(() => {
    for (const animation of animationsRef.current) {
      animation.cancel()
    }
    animationsRef.current = []
  }, [])

  const removeClosingGhost = useCallback(() => {
    closingGhostRef.current?.remove()
    closingGhostRef.current = null
  }, [])

  const setMotionPhase = useCallback((phase: string | null) => {
    const body = contentBodyRef.current
    if (!body) return

    if (phase) body.dataset.historyMotion = phase
    else delete body.dataset.historyMotion
  }, [])

  const resetMotionState = useCallback(() => {
    cancelAnimations()
    removeClosingGhost()
    setMotionPhase(null)
  }, [cancelAnimations, removeClosingGhost, setMotionPhase])

  useEffect(() => resetMotionState, [resetMotionState])

  const toggleHistorySidebar = useCallback(() => {
    const body = contentBodyRef.current
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!body || reducedMotion) {
      flushSync(onToggle)
      return
    }

    const mainStack = body.querySelector<HTMLElement>('.main-stack')
    const historyShell = body.querySelector<HTMLElement>('.history-sidebar-shell')
    if (!mainStack || !historyShell) {
      flushSync(onToggle)
      return
    }

    resetMotionState()

    if (!open) {
      const firstMain = mainStack.getBoundingClientRect()
      const firstShell = historyShell.getBoundingClientRect()
      flushSync(onToggle)

      const lastMain = mainStack.getBoundingClientRect()
      const lastShell = historyShell.getBoundingClientRect()
      const mainScale = firstMain.width / Math.max(lastMain.width, 1)
      const shellClip = Math.max(lastShell.width - firstShell.width, 0)

      animationsRef.current = [
        mainStack.animate(
          [{ transform: `scaleX(${mainScale})` }, { transform: 'scaleX(1)' }],
          {
            duration: HISTORY_SIDEBAR_MOTION_MS,
            delay: HISTORY_SIDEBAR_START_OFFSET_MS,
            easing: HISTORY_SIDEBAR_EASING
          }
        ),
        historyShell.animate(
          [{ clipPath: `inset(0 0 0 ${shellClip}px)` }, { clipPath: 'inset(0 0 0 0)' }],
          {
            duration: HISTORY_SIDEBAR_MOTION_MS,
            delay: HISTORY_SIDEBAR_START_OFFSET_MS,
            easing: HISTORY_SIDEBAR_EASING
          }
        )
      ]
      return
    }

    const firstMain = mainStack.getBoundingClientRect()
    const shellRect = historyShell.getBoundingClientRect()
    const shellClip = Math.max(shellRect.width - HISTORY_SIDEBAR_CLOSED_WIDTH, 0)

    const closingGhost = document.createElement('aside')
    closingGhostRef.current = closingGhost
    closingGhost.classList.add('history-sidebar-closing-ghost')
    closingGhost.setAttribute('aria-hidden', 'true')
    Object.assign(closingGhost.style, {
      left: `${shellRect.left}px`,
      top: `${shellRect.top}px`,
      width: `${shellRect.width}px`,
      height: `${shellRect.height}px`
    })
    ;(body.closest('.app-shell') ?? document.body).appendChild(closingGhost)

    setMotionPhase('closing')
    flushSync(onToggle)

    const lastMain = mainStack.getBoundingClientRect()
    const mainScale = firstMain.width / Math.max(lastMain.width, 1)

    const mainAnimation = mainStack.animate(
      [{ transform: `scaleX(${mainScale})` }, { transform: 'scaleX(1)' }],
      {
        duration: HISTORY_SIDEBAR_MOTION_MS,
        delay: HISTORY_SIDEBAR_START_OFFSET_MS,
        easing: HISTORY_SIDEBAR_EASING
      }
    )
    const ghostAnimation = closingGhost.animate(
      [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: `inset(0 0 0 ${shellClip}px)` }],
      {
        duration: HISTORY_SIDEBAR_MOTION_MS,
        delay: HISTORY_SIDEBAR_START_OFFSET_MS,
        easing: HISTORY_SIDEBAR_EASING
      }
    )
    animationsRef.current = [mainAnimation, ghostAnimation]

    ghostAnimation.finished
      .then(() => {
        removeClosingGhost()
        animationsRef.current = []
        setMotionPhase(null)
      })
      .catch(() => undefined)

    window.setTimeout(() => {
      if (closingGhostRef.current === closingGhost) {
        removeClosingGhost()
        animationsRef.current = []
        setMotionPhase(null)
      }
    }, HISTORY_SIDEBAR_MOTION_MS + 80)
  }, [onToggle, open, removeClosingGhost, resetMotionState, setMotionPhase])

  return { contentBodyRef, toggleHistorySidebar }
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
  const {
    visibleTabs,
    backgroundTabCount,
    backgroundSessionCount,
    pendingSessions,
    addTerminal: handleAddTerminal,
    closeTerminal,
    startSession,
    abandonPendingSession,
    renamePendingSession
  } = useSessionScopedTerminals('claude', sessionBrowser, selectedSessionId, onSelectedSessionIdChange)
  const [historySidebarOpen, toggleHistorySidebarState] = usePersistentPlatformFlag(
    'selection:history-sidebar:v1',
    'claude'
  )
  const { contentBodyRef, toggleHistorySidebar } = useHistorySidebarMotion(
    historySidebarOpen,
    toggleHistorySidebarState
  )
  const newSession = isPendingSessionId(selectedSessionId)

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
        pendingSessions={pendingSessions}
        onStartSession={startSession}
        onAbandonPendingSession={abandonPendingSession}
        onRenamePendingSession={renamePendingSession}
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
              tabs={visibleTabs}
              defaultCwd={sessionBrowser.selectedProject?.path ?? null}
              defaultWslDistro={sessionBrowser.selectedProject?.origin?.distro ?? null}
              projectName={sessionBrowser.selectedProject?.name ?? null}
              statusLabel={statusLabel}
              backgroundTabCount={backgroundTabCount}
              backgroundSessionCount={backgroundSessionCount}
              onAdd={handleAddTerminal}
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
  const {
    visibleTabs,
    backgroundTabCount,
    backgroundSessionCount,
    pendingSessions,
    addTerminal: handleAddTerminal,
    closeTerminal,
    startSession,
    abandonPendingSession,
    renamePendingSession
  } = useSessionScopedTerminals('codex', sessionBrowser, selectedSessionId, onSelectedSessionIdChange)
  const [historySidebarOpen, toggleHistorySidebarState] = usePersistentPlatformFlag(
    'selection:history-sidebar:v1',
    'codex'
  )
  const { contentBodyRef, toggleHistorySidebar } = useHistorySidebarMotion(
    historySidebarOpen,
    toggleHistorySidebarState
  )
  const newSession = isPendingSessionId(selectedSessionId)
  const statusLabel = planError ? 'usage error' : planUsage ? 'live' : 'connecting'

  return (
    <main className="workspace">
      <ProjectSessionSidebar
        title="Projects"
        ariaLabel="Codex projects"
        emptyLabel="No Codex projects found"
        browser={sessionBrowser}
        pendingSessions={pendingSessions}
        onStartSession={startSession}
        onAbandonPendingSession={abandonPendingSession}
        onRenamePendingSession={renamePendingSession}
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
              tabs={visibleTabs}
              defaultCwd={sessionBrowser.selectedProject?.path ?? null}
              defaultWslDistro={sessionBrowser.selectedProject?.origin?.distro ?? null}
              projectName={sessionBrowser.selectedProject?.name ?? null}
              statusLabel={statusLabel}
              backgroundTabCount={backgroundTabCount}
              backgroundSessionCount={backgroundSessionCount}
              onAdd={handleAddTerminal}
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
