import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, JSX, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import {
  createPendingSessionId,
  isPendingSessionId,
  SessionDetailModal,
  SessionHistorySidebar,
  ProjectSessionSidebar,
  useProjectSessionBrowserState,
  useSessionHistory
} from '@renderer/components/session-browser'
import type { ProjectSessionBrowserState, ProjectSessionGroup } from '@renderer/components/session-browser'
import { TerminalDeck, useTerminalDeck } from '@renderer/components/terminal-deck'
import type { TerminalTab } from '@renderer/components/terminal-deck'
import { CheatSheet } from '@renderer/components/cheat-sheet'
import { ProjectWorkspaceDock } from '@renderer/components/project-workspace'
import { FileTreePanel, FilePreviewModal, FilePreviewPane } from '@renderer/components/file-tree'
import { TitlebarSearch } from '@renderer/components/search/TitlebarSearch'
import { MemoryView } from '@renderer/components/memory/MemoryView'
import { SetupGate } from '@renderer/components/setup/SetupGate'
import { SettingsModal } from '@renderer/components/settings/SettingsModal'
import { TitlebarMenus, type TitlebarMenuItem } from '@renderer/components/titlebar/TitlebarMenus'
import { OpenCodeActivityPanel } from '@renderer/components/opencode/OpenCodeActivityPanel'
import { OpenCodeCompanionWindow } from '@renderer/components/opencode/OpenCodeCompanionWindow'
import { OpenCodeSlimUpdateBanner } from '@renderer/components/opencode/OpenCodeSlimUpdateBanner'
import type { ClaudePlanUsage, PlanUsageRefreshMeta, UsageWindow } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { OpenCodePlanLimit, OpenCodePlanUsage } from '@shared/opencode'
import { isPlatformId, PLATFORM_CONFIG, PLATFORM_IDS, type PlatformId } from '@shared/platform'
import { APP_NAME } from '@shared/brand'
import type { AssistantSession, SessionOrigin } from '@shared/sessions'
import { memoryIdFromProjectRelPath } from '@shared/memory'
import {
  backgroundTerminalLocations,
  type TerminalBackgroundLocation,
  type TerminalSessionLocator
} from '@shared/terminal'
import type {
  FileRequest,
  ProjectFileChangedEvent,
  ProjectFileWatchMode,
  ProjectFileWatchRequest
} from '@shared/project-files'
import type { SearchResultItem } from '@shared/search'
import type { SetupStatus } from '@shared/setup'

const PLAN_POLL_INTERVAL_MS = 120_000
const SETUP_STATUS_CACHE_KEY = 'setup:last-status:v1'
// Splash: keep it on screen long enough to read (no jarring flash on a warm cache),
// fade out once the active platform's first project scan resolves, and never trap
// the user if a scan stalls.
const SPLASH_FADE_MS = 320
const SPLASH_MIN_VISIBLE_MS = 450
const SPLASH_MAX_VISIBLE_MS = 9_000
const HISTORY_SIDEBAR_CLOSED_WIDTH = 32
const HISTORY_SIDEBAR_MOTION_MS = 180
const HISTORY_SIDEBAR_START_OFFSET_MS = -24
const HISTORY_SIDEBAR_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const PROJECT_SIDEBAR_DEFAULT_WIDTH = 310
const FILES_PANEL_DEFAULT_WIDTH = 280
const HISTORY_SIDEBAR_DEFAULT_WIDTH = 410
const WORKSPACE_DOCK_DEFAULT_HEIGHT = 280
const PROJECT_LIST_DEFAULT_HEIGHT = 260

type CSSVars = CSSProperties & Record<`--${string}`, string | number>
type PanelSizeKey = 'projectSidebar' | 'projectList' | 'filesPanel' | 'historySidebar' | 'workspaceDock'
type PlatformPanelSizes = Record<PanelSizeKey, number | null>
type PanelSizePreferences = Record<PlatformId, PlatformPanelSizes>
type PanelResizeEdge = 'left' | 'right' | 'top' | 'bottom'

const DEFAULT_PANEL_SIZES: PanelSizePreferences = {
  claude: {
    projectSidebar: null,
    projectList: null,
    filesPanel: null,
    historySidebar: null,
    workspaceDock: null
  },
  codex: {
    projectSidebar: null,
    projectList: null,
    filesPanel: null,
    historySidebar: null,
    workspaceDock: null
  },
  opencode: {
    projectSidebar: null,
    projectList: null,
    filesPanel: null,
    historySidebar: null,
    workspaceDock: null
  }
}

const PANEL_SIZE_LIMITS: Record<PanelSizeKey, { min: number; max: number }> = {
  projectSidebar: { min: 240, max: 520 },
  projectList: { min: 120, max: 620 },
  filesPanel: { min: 220, max: 520 },
  historySidebar: { min: 320, max: 680 },
  workspaceDock: { min: 190, max: 520 }
}

const PANEL_SIZE_FALLBACKS: Record<PanelSizeKey, number> = {
  projectSidebar: PROJECT_SIDEBAR_DEFAULT_WIDTH,
  projectList: PROJECT_LIST_DEFAULT_HEIGHT,
  filesPanel: FILES_PANEL_DEFAULT_WIDTH,
  historySidebar: HISTORY_SIDEBAR_DEFAULT_WIDTH,
  workspaceDock: WORKSPACE_DOCK_DEFAULT_HEIGHT
}

function clampPanelSize(key: PanelSizeKey, value: number): number {
  const limit = PANEL_SIZE_LIMITS[key]
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)))
}

function normalizePanelSize(key: PanelSizeKey, value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? clampPanelSize(key, value) : null
}

function revivePanelSizePreferences(value: PanelSizePreferences): PanelSizePreferences {
  return {
    claude: {
      projectSidebar: normalizePanelSize('projectSidebar', value.claude?.projectSidebar),
      projectList: normalizePanelSize('projectList', value.claude?.projectList),
      filesPanel: normalizePanelSize('filesPanel', value.claude?.filesPanel),
      historySidebar: normalizePanelSize('historySidebar', value.claude?.historySidebar),
      workspaceDock: normalizePanelSize('workspaceDock', value.claude?.workspaceDock)
    },
    codex: {
      projectSidebar: normalizePanelSize('projectSidebar', value.codex?.projectSidebar),
      projectList: normalizePanelSize('projectList', value.codex?.projectList),
      filesPanel: normalizePanelSize('filesPanel', value.codex?.filesPanel),
      historySidebar: normalizePanelSize('historySidebar', value.codex?.historySidebar),
      workspaceDock: normalizePanelSize('workspaceDock', value.codex?.workspaceDock)
    },
    opencode: {
      projectSidebar: normalizePanelSize('projectSidebar', value.opencode?.projectSidebar),
      projectList: normalizePanelSize('projectList', value.opencode?.projectList),
      filesPanel: normalizePanelSize('filesPanel', value.opencode?.filesPanel),
      historySidebar: normalizePanelSize('historySidebar', value.opencode?.historySidebar),
      workspaceDock: normalizePanelSize('workspaceDock', value.opencode?.workspaceDock)
    }
  }
}

function startPanelResize({
  event,
  edge,
  key,
  startSize,
  onResize
}: {
  event: ReactPointerEvent<HTMLElement>
  edge: PanelResizeEdge
  key: PanelSizeKey
  startSize: number
  onResize: (size: number) => void
}): void {
  if (event.button !== 0) return

  event.preventDefault()
  event.stopPropagation()

  const handle = event.currentTarget
  const startX = event.clientX
  const startY = event.clientY
  const initialSize = clampPanelSize(key, startSize || PANEL_SIZE_FALLBACKS[key])
  const axis = edge === 'top' || edge === 'bottom' ? 'y' : 'x'

  handle.classList.add('resizing')
  document.body.dataset.panelResize = axis
  handle.setPointerCapture?.(event.pointerId)

  const move = (moveEvent: PointerEvent): void => {
    moveEvent.preventDefault()
    const delta =
      edge === 'right'
        ? moveEvent.clientX - startX
        : edge === 'left'
          ? startX - moveEvent.clientX
          : edge === 'bottom'
            ? moveEvent.clientY - startY
            : startY - moveEvent.clientY
    onResize(clampPanelSize(key, initialSize + delta))
  }

  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    handle.classList.remove('resizing')
    delete document.body.dataset.panelResize
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

function getDetachedTerminalPlatform(): PlatformId | null {
  const params = new URLSearchParams(window.location.search)
  if (params.get('view') !== 'terminals') return null
  const platform = params.get('platform')
  return isPlatformId(platform) ? platform : null
}

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
    updatedAt: new Date(slot.createdAtMs).toISOString(),
    model: null,
    contextTokens: null,
    contextWindow: null
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

// Pending slots and the set of session ids already seen for adoption live in module
// scope, not only component state, so they survive a platform-switch remount (which
// unmounts the whole workspace). Without this, a session started just before
// switching platforms would lose its pending slot — and with it the ability to
// adopt its terminal — on the way back. They reset when the renderer reloads (a real
// restart), matching the transient-pending-state contract. Keyed per platform, and
// per renderer window, so the main and detached windows never cross-contaminate.
const pendingSessionsByPlatform = new Map<PlatformId, PendingSessionSlot[]>()
const knownSessionIdsByPlatform = new Map<PlatformId, Set<string>>()

// Session-scoped terminal deck: terminals belong to a session, not just a project.
// Starting a session mints a pending slot + first terminal; once the session's
// transcript is discovered it is adopted (terminals + selection retagged onto the
// real id). Other sessions' terminals keep running in the background meanwhile.
function useSessionScopedTerminals(
  platform: PlatformId,
  browser: ProjectSessionBrowserState,
  selectedSessionId: string | null,
  onSelectedProjectIdChange: (projectId: string | null) => void,
  onSelectedSessionIdChange: (sessionId: string | null) => void
): {
  visibleTabs: TerminalTab[]
  backgroundTabCount: number
  backgroundSessionCount: number
  backgroundTerminals: TerminalBackgroundLocation[]
  pendingSessions: AssistantSession[]
  addTerminal: (cwd?: string | null, title?: string, wslDistro?: string | null, initialInput?: string | null) => void
  resumeSession: (session: AssistantSession) => void
  closeTerminal: (id: string) => void
  selectBackgroundTerminal: (terminal: TerminalBackgroundLocation) => void
  startSession: (project: ProjectSessionGroup) => void
  abandonPendingSession: (id: string) => Promise<{ trashed: number }>
  renamePendingSession: (id: string, title: string | null) => Promise<void>
} {
  const { tabs, reconciled, addTerminal, closeTerminal, retagSession } = useTerminalDeck(platform)
  // Seeded from the module store so a platform-switch remount restores any pending
  // slots (and their adoption ability); mirrored back to the store on every change.
  const [pending, setPending] = useState<PendingSessionSlot[]>(() => pendingSessionsByPlatform.get(platform) ?? [])
  useEffect(() => {
    pendingSessionsByPlatform.set(platform, pending)
  }, [platform, pending])
  const { sessions, selectedProject, refreshSessions } = browser

  const partition = useMemo(() => partitionTerminalTabs(tabs, selectedSessionId), [tabs, selectedSessionId])
  // Until reconciliation confirms which restored tabs still have a live pty, expose
  // nothing: rendering a pane would respawn a dead shell, and counting a dead tab
  // would show a phantom "running" background terminal. Both resolve a beat later
  // once the worker's live set is known.
  const visibleTabs = reconciled ? partition.visibleTabs : []
  const backgroundTabCount = reconciled ? partition.backgroundTabCount : 0
  const backgroundSessionCount = reconciled ? partition.backgroundSessionCount : 0

  const pendingSessions = useMemo(() => pending.map((slot) => toPendingSession(slot, platform)), [pending, platform])
  const terminalSessionLocators = useMemo<TerminalSessionLocator[]>(
    () => [
      ...sessions.map((session) => ({
        sessionKey: session.id,
        sessionTitle: session.title,
        projectId: session.projectId,
        projectName: session.project,
        projectPath: session.projectPath
      })),
      ...pending.map((slot) => ({
        sessionKey: slot.id,
        sessionTitle: slot.title,
        projectId: slot.projectId,
        projectName: slot.projectName,
        projectPath: slot.projectPath
      }))
    ],
    [pending, sessions]
  )
  const backgroundTerminals = useMemo(
    () => (reconciled ? backgroundTerminalLocations(tabs, selectedSessionId, terminalSessionLocators) : []),
    [reconciled, selectedSessionId, tabs, terminalSessionLocators]
  )

  const selectBackgroundTerminal = useCallback(
    (terminal: TerminalBackgroundLocation) => {
      if (terminal.projectId) onSelectedProjectIdChange(terminal.projectId)
      onSelectedSessionIdChange(terminal.sessionKey)
    },
    [onSelectedProjectIdChange, onSelectedSessionIdChange]
  )

  // Mint a fresh pending session in a project, select it, and optionally open its
  // first terminal. The pending id keeps the terminal unattached to any historical
  // transcript until the adoption pass retags it onto the real session once that
  // session's first prompt is recorded. Returns the new pending id.
  const beginSession = useCallback(
    (
      project: ProjectSessionGroup,
      openTerminal: boolean,
      cwd?: string | null,
      title?: string,
      wslDistro?: string | null,
      initialInput?: string | null
    ): string | null => {
      if (!project.path) return null
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
      if (openTerminal) {
        addTerminal(pendingId, cwd ?? project.path, title, wslDistro ?? project.origin?.distro ?? null, initialInput)
      }
      onSelectedSessionIdChange(pendingId)
      return pendingId
    },
    [addTerminal, onSelectedSessionIdChange]
  )

  // "+ New Session": add the (empty) session and select it — the user opens its
  // first terminal explicitly via the deck. No shell is auto-spawned.
  const startSession = useCallback((project: ProjectSessionGroup) => beginSession(project, false), [beginSession])

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

  // Resume a past session: bring it to the front, then run the CLI's resume
  // command. If the session already has a terminal, send the command into it
  // (no duplicate tab); otherwise open a new terminal in its project folder/WSL
  // distro and auto-run it there. Assumes an existing terminal is at a shell
  // prompt — sending it while a CLI is already running just types into that CLI.
  const resumeSession = useCallback(
    (session: AssistantSession) => {
      if (session.projectId) onSelectedProjectIdChange(session.projectId)
      onSelectedSessionIdChange(session.id)
      const command =
        platform === 'claude'
          ? `claude --resume ${session.id}`
          : platform === 'codex'
            ? `codex resume ${session.id}`
            : `opencode --session ${session.id}`
      const existing = tabs.find((tab) => tab.sessionKey === session.id)
      if (existing) {
        window.dashboard.terminal.input(existing.id, `${command}\r`)
        return
      }
      addTerminal(session.id, session.projectPath, undefined, session.origin?.distro ?? null, command)
    },
    [tabs, addTerminal, onSelectedProjectIdChange, onSelectedSessionIdChange, platform]
  )

  const handleAddTerminal = useCallback(
    (cwd?: string | null, title?: string, wslDistro?: string | null, initialInput?: string | null) => {
      // Add a side-shell only to a genuinely *active* session: one that is pending
      // (just started) or already has a live terminal (e.g. a resumed one). Extra
      // terminals then stay grouped with that session.
      const sessionIsActive =
        selectedSessionId != null &&
        (isPendingSessionId(selectedSessionId) || tabs.some((tab) => tab.sessionKey === selectedSessionId))
      if (sessionIsActive) {
        addTerminal(selectedSessionId!, cwd, title, wslDistro, initialInput)
        return
      }
      // A historical session is selected but has no live terminal (typically after
      // an app restart closed its shell). "Add terminal" here means "get me back
      // into this session", so RESUME it — this reuses the real session id via the
      // CLI's resume command. Never bind a fresh shell to a historical id directly:
      // that files new work under the wrong session (decision 601 / PIN-023).
      const historical =
        selectedSessionId != null ? sessions.find((session) => session.id === selectedSessionId) : undefined
      if (historical) {
        resumeSession(historical)
        return
      }
      // Only a project is selected (no session at all): a terminal here is new work,
      // so begin a fresh session rooted in the project.
      if (selectedProject) beginSession(selectedProject, true, cwd, title, wslDistro, initialInput)
    },
    [addTerminal, beginSession, resumeSession, sessions, selectedProject, selectedSessionId, tabs]
  )

  // Adopt: when the poll reveals a session whose folder matches a waiting pending
  // slot, retag its terminals (and the selection) onto the real id. Oldest slot
  // claims first; each transcript is claimed at most once.
  // Seeded from the module store so a remount resumes "sessions seen since last
  // poll" where it left off, rather than treating every existing session as newly
  // added — which could otherwise adopt a stale prior session in the same folder.
  const knownSessionIdsRef = useRef<Set<string>>(new Set(knownSessionIdsByPlatform.get(platform) ?? []))
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
    knownSessionIdsByPlatform.set(platform, knownSessionIdsRef.current)
  }, [platform, sessions, pending, retagSession, selectedSessionId, onSelectedSessionIdChange])

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
    backgroundTerminals,
    pendingSessions,
    addTerminal: handleAddTerminal,
    resumeSession,
    closeTerminal,
    selectBackgroundTerminal,
    startSession,
    abandonPendingSession,
    renamePendingSession
  }
}

type PlanUsageDisplay = {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  monthly?: UsageWindow | null
  isEstimate?: boolean
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
  opencode: PlanUsageState<OpenCodePlanUsage>
}

function isOpenCodeCompanionWindow(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'opencode-companion'
}

function isSetupStatus(value: unknown): value is SetupStatus {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<Record<PlatformId, unknown>>
  return PLATFORM_IDS.every((platform) => {
    const setup = record[platform]
    return (
      Boolean(setup) &&
      typeof setup === 'object' &&
      typeof (setup as { installed?: unknown }).installed === 'boolean' &&
      typeof (setup as { connected?: unknown }).connected === 'boolean'
    )
  })
}

function readCachedSetupStatus(): SetupStatus | null {
  try {
    const raw = window.localStorage.getItem(SETUP_STATUS_CACHE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSetupStatus(parsed) ? parsed : null
  } catch {
    return null
  }
}

function cacheSetupStatus(status: SetupStatus): void {
  try {
    window.localStorage.setItem(SETUP_STATUS_CACHE_KEY, JSON.stringify(status))
  } catch {
    // A live in-memory status still works when storage is unavailable.
  }
}
type FilePreviewSelection = {
  projectId: string | null
  request: FileRequest
  highlight?: string
  changeToken?: number
}
type MemorySelectionRequest = {
  id: string
  sequence: number
}

type ProjectFileChangeState = {
  event: ProjectFileChangedEvent | null
  sequence: number
  mode: ProjectFileWatchMode | null
  error: string | null
}

function sameWatchRoot(a: ProjectFileWatchRequest | null, b: ProjectFileWatchRequest | null): boolean {
  return Boolean(a && b && a.rootPath === b.rootPath && (a.distro ?? null) === (b.distro ?? null))
}

function useProjectFileWatcher(
  root: ProjectFileWatchRequest | null,
  active: boolean
): ProjectFileChangeState {
  const [state, setState] = useState<ProjectFileChangeState>({
    event: null,
    sequence: 0,
    mode: null,
    error: null
  })

  useEffect(() => {
    if (!active || !root?.rootPath) {
      window.dashboard?.projectFiles?.unwatch?.()
      setState((current) => ({ ...current, mode: null, error: null }))
      return
    }

    let cancelled = false
    const remove = window.dashboard.projectFiles.onChanged((event) => {
      if (!sameWatchRoot(event, root)) return
      setState((current) => ({ ...current, event, sequence: current.sequence + 1, error: null }))
    })

    window.dashboard.projectFiles
      .watch(root)
      .then((result) => {
        if (cancelled) return
        setState((current) => ({
          ...current,
          mode: result.mode ?? null,
          error: result.ok ? null : result.error ?? 'Could not watch project files'
        }))
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState((current) => ({
          ...current,
          mode: null,
          error: error instanceof Error ? error.message : 'Could not watch project files'
        }))
      })

    return () => {
      cancelled = true
      remove()
      window.dashboard.projectFiles.unwatch()
    }
  }, [active, root?.rootPath, root?.distro])

  return state
}

export function App(): JSX.Element {
  if (isOpenCodeCompanionWindow()) return <OpenCodeCompanionWindow />

  const detachedTerminalPlatform = getDetachedTerminalPlatform()
  if (detachedTerminalPlatform) return <DetachedTerminalWindow platform={detachedTerminalPlatform} />

  return <DashboardApp />
}

function DashboardApp(): JSX.Element {
  const [platform, setPlatform] = useState<PlatformId>('claude')
  // First-run onboarding gate: shown until the user connects a tool or skips, then
  // remembered so it doesn't reappear on later launches.
  const [setupState, setSetupState] = usePersistentState<{ done: boolean }>('setup:completed:v1', {
    done: false
  })
  // Keep the complete last-known setup status so Connections can paint immediately.
  // A fresh main-process scan runs in the background and replaces this cached snapshot.
  const [connectionStatus, setConnectionStatus] = useState<SetupStatus | null>(readCachedSetupStatus)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const updateConnectionStatus = useCallback((next: SetupStatus) => {
    cacheSetupStatus(next)
    setConnectionStatus(next)
  }, [])

  const refreshConnections = useCallback(async () => {
    try {
      const status = await window.dashboard.setup.getStatus()
      updateConnectionStatus(status)
    } catch {
      // Keep the last known set; the next refresh retries.
    }
  }, [updateConnectionStatus])

  useEffect(() => {
    refreshConnections()
  }, [refreshConnections])

  // Active platforms = those connected. Until the first status lands, or if none are
  // connected (e.g. onboarding was skipped), keep all platforms available so the app
  // isn't a dead end. The switcher only appears when more than one is active.
  const connectedPlatforms = useMemo<PlatformId[] | null>(() => {
    if (!isSetupStatus(connectionStatus)) return null
    return PLATFORM_IDS.filter((id) => connectionStatus[id].connected)
  }, [connectionStatus])

  const activePlatforms = useMemo<PlatformId[]>(() => {
    const all = Object.keys(PLATFORM_CONFIG) as PlatformId[]
    if (!connectedPlatforms || connectedPlatforms.length === 0) return all
    return all.filter((id) => connectedPlatforms.includes(id))
  }, [connectedPlatforms])

  // Never leave the app showing a platform that isn't active.
  useEffect(() => {
    if (!activePlatforms.includes(platform)) setPlatform(activePlatforms[0])
  }, [activePlatforms, platform])

  const [cheatSheetOpen, setCheatSheetOpen] = useState(false)
  const [memoryOpen, setMemoryOpen] = useState(false)
  const memorySelectionSequenceRef = useRef(0)
  const [memorySelectionRequest, setMemorySelectionRequest] = useState<MemorySelectionRequest | null>(null)

  const openConnections = useCallback(() => {
    setConnectionsOpen(true)
    setSettingsOpen(false)
    setMemoryOpen(false)
    setCheatSheetOpen(false)
  }, [])

  const openSettings = useCallback(() => {
    setSettingsOpen(true)
    setMemoryOpen(false)
    setCheatSheetOpen(false)
  }, [])

  const closeSettings = useCallback(() => setSettingsOpen(false), [])

  const toggleCheatSheet = useCallback(() => {
    setSettingsOpen(false)
    setCheatSheetOpen((open) => !open)
    setMemoryOpen(false)
  }, [])

  const toggleMemory = useCallback(() => {
    setSettingsOpen(false)
    setMemorySelectionRequest(null)
    setMemoryOpen((open) => !open)
    setCheatSheetOpen(false)
  }, [])
  const planUsageStates = usePlanUsagePolling(connectedPlatforms)
  const [selectedSessionIds, setSelectedSessionIds] = usePersistentState<Record<PlatformId, string | null>>(
    'selection:sessions:v1',
    { claude: null, codex: null, opencode: null },
    undefined,
    // Don't restore a transient pending-session selection from a previous run —
    // start clean. Passed as the load-only transform so a live pending selection
    // still syncs across windows (starting a session while terminals are detached
    // must not scrub itself as the selection round-trips main ↔ detached window).
    (value) => ({
      claude: isPendingSessionId(value.claude) ? null : value.claude,
      codex: isPendingSessionId(value.codex) ? null : value.codex,
      opencode: isPendingSessionId(value.opencode) ? null : value.opencode
    })
  )
  const [selectedProjectIds, setSelectedProjectIds] = usePersistentState<Record<PlatformId, string | null>>(
    'selection:projects:v1',
    { claude: null, codex: null, opencode: null }
  )
  // Session details is now a modal popup (not a persistent panel), so this is a
  // transient per-platform open flag, not persisted across launches.
  const [sessionDetailOpen, setSessionDetailOpen] = useState<Record<PlatformId, boolean>>({
    claude: false,
    codex: false,
    opencode: false
  })
  const [historySidebarOpen, setHistorySidebarOpen] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:history-sidebar:v1',
    { claude: false, codex: false, opencode: false }
  )
  const [projectSidebarOpen, setProjectSidebarOpen] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:project-sidebar:v1',
    { claude: true, codex: true, opencode: true }
  )
  const [workspaceDockOpen, setWorkspaceDockOpen] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:workspace-dock:v1',
    { claude: false, codex: false, opencode: false }
  )
  const [filesPanelOpen, setFilesPanelOpen] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:files-panel:v1',
    { claude: false, codex: false, opencode: false }
  )
  const [panelSizes, setPanelSizes] = usePersistentState<PanelSizePreferences>(
    'selection:panel-sizes:v1',
    DEFAULT_PANEL_SIZES,
    revivePanelSizePreferences
  )
  const [terminalDetached, setTerminalDetached] = useState<Record<PlatformId, boolean>>({
    claude: false,
    codex: false,
    opencode: false
  })
  const [previewFollowEdits, setPreviewFollowEdits] = usePersistentState<Record<PlatformId, boolean>>(
    'selection:file-preview-follow-edits:v1',
    { claude: true, codex: true, opencode: true }
  )
  const [filePreviewSelections, setFilePreviewSelections] = useState<Record<PlatformId, FilePreviewSelection | null>>({
    claude: null,
    codex: null,
    opencode: null
  })
  const activePlatform = PLATFORM_CONFIG[platform]

  useEffect(
    () =>
      window.dashboard.openCode.onCompanionFocus((target) => {
        setPlatform('opencode')
        if (target.projectId) {
          setSelectedProjectIds((current) =>
            current.opencode === target.projectId ? current : { ...current, opencode: target.projectId }
          )
        }
        setSelectedSessionIds((current) =>
          current.opencode === target.sessionId ? current : { ...current, opencode: target.sessionId }
        )
        setProjectSidebarOpen((current) =>
          current.opencode ? current : { ...current, opencode: true }
        )
      }),
    [setProjectSidebarOpen, setSelectedProjectIds, setSelectedSessionIds]
  )

  // A file result from global search opens the shared preview modal at the app
  // level (decoupled from the file tree), so search can preview any project file
  // and highlight the term that was searched for.
  const [searchPreview, setSearchPreview] = useState<{
    request: FileRequest
    highlight: string
    scrollToLine?: number
  } | null>(null)

  useEffect(() => {
    try {
      window.localStorage.removeItem('selection:terminal-detached:v1')
    } catch {
      // Runtime-only state; ignore storage cleanup failures.
    }

    return window.dashboard.terminal.onDetachedClosed((event) => {
      setTerminalDetached((current) =>
        current[event.platform] ? { ...current, [event.platform]: false } : current
      )
    })
  }, [])

  const handleSearchActivate = useCallback(
    (item: SearchResultItem, query: string) => {
      if (item.kind === 'project') {
        setSelectedProjectIds((current) => ({ ...current, [platform]: item.projectId }))
        setProjectSidebarOpen((current) => ({ ...current, [platform]: true }))
        return
      }
      if (item.kind === 'session') {
        setSelectedProjectIds((current) => ({ ...current, [platform]: item.projectId }))
        setSelectedSessionIds((current) => ({ ...current, [platform]: item.sessionId ?? null }))
        setProjectSidebarOpen((current) => ({ ...current, [platform]: true }))
        return
      }
      if (item.kind === 'history') {
        setSelectedProjectIds((current) => ({ ...current, [platform]: item.projectId }))
        setSelectedSessionIds((current) => ({ ...current, [platform]: item.sessionId ?? null }))
        setProjectSidebarOpen((current) => ({ ...current, [platform]: true }))
        setHistorySidebarOpen((current) => ({ ...current, [platform]: true }))
        return
      }
      if (item.kind === 'file' && item.file) {
        setSelectedProjectIds((current) => ({ ...current, [platform]: item.projectId }))
        const memoryFileId = memoryIdFromProjectRelPath(item.file.relPath)
        if (memoryFileId) {
          memorySelectionSequenceRef.current += 1
          setMemorySelectionRequest({ id: memoryFileId, sequence: memorySelectionSequenceRef.current })
          setMemoryOpen(true)
          setCheatSheetOpen(false)
          setSearchPreview(null)
          return
        }
        if (terminalDetached[platform]) {
          setFilePreviewSelections((current) => ({
            ...current,
            [platform]: { projectId: item.projectId, request: item.file, highlight: query }
          }))
        } else {
          setSearchPreview({ request: item.file, highlight: query })
        }
      }
    },
    [
      platform,
      setHistorySidebarOpen,
      setProjectSidebarOpen,
      setSelectedProjectIds,
      setSelectedSessionIds,
      terminalDetached
    ]
  )

  // A file clicked inside an (attached) terminal session opens in the shared
  // preview modal — same surface global search uses, with no search highlight,
  // optionally scrolled to the line parsed from a `file.ts:42` mention.
  const openTerminalFile = useCallback((request: FileRequest, line?: number) => {
    setSearchPreview({ request, highlight: '', scrollToLine: line })
  }, [])

  // Splash gate: shown until the active platform's first session scan resolves.
  // Set once and never reset, so switching platforms later never re-shows it.
  const [appReady, setAppReady] = useState(false)
  const splashShownAtRef = useRef(Date.now())
  const readyScheduledRef = useRef(false)

  const handleWorkspaceReady = useCallback(() => {
    if (readyScheduledRef.current) return
    readyScheduledRef.current = true
    const remaining = Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAtRef.current))
    window.setTimeout(() => setAppReady(true), remaining)
  }, [])

  // Safety net: never let a stalled scan keep the splash up indefinitely.
  useEffect(() => {
    const id = window.setTimeout(() => setAppReady(true), SPLASH_MAX_VISIBLE_MS)
    return () => window.clearTimeout(id)
  }, [])

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

  const selectProviderSession = useCallback((sessionId: string | null) => {
    setSelectedSessionIds((current) =>
      current[platform] === sessionId ? current : { ...current, [platform]: sessionId }
    )
  }, [platform, setSelectedSessionIds])

  const selectProviderProject = useCallback((projectId: string | null) => {
    setSelectedProjectIds((current) =>
      current[platform] === projectId ? current : { ...current, [platform]: projectId }
    )
  }, [platform, setSelectedProjectIds])

  const toggleClaudeSessionDetail = useCallback(() => {
    setSessionDetailOpen((current) => ({ ...current, claude: !current.claude }))
  }, [setSessionDetailOpen])

  const toggleProviderSessionDetail = useCallback(() => {
    setSessionDetailOpen((current) => ({ ...current, [platform]: !current[platform] }))
  }, [platform, setSessionDetailOpen])

  const toggleClaudeHistorySidebar = useCallback(() => {
    setHistorySidebarOpen((current) => ({ ...current, claude: !current.claude }))
  }, [setHistorySidebarOpen])

  const toggleProviderHistorySidebar = useCallback(() => {
    setHistorySidebarOpen((current) => ({ ...current, [platform]: !current[platform] }))
  }, [platform, setHistorySidebarOpen])

  const toggleClaudeProjectSidebar = useCallback(() => {
    setProjectSidebarOpen((current) => ({ ...current, claude: !current.claude }))
  }, [setProjectSidebarOpen])

  const toggleProviderProjectSidebar = useCallback(() => {
    setProjectSidebarOpen((current) => ({ ...current, [platform]: !current[platform] }))
  }, [platform, setProjectSidebarOpen])

  const toggleClaudeWorkspaceDock = useCallback(() => {
    setWorkspaceDockOpen((current) => ({ ...current, claude: !current.claude }))
  }, [setWorkspaceDockOpen])

  const toggleProviderWorkspaceDock = useCallback(() => {
    setWorkspaceDockOpen((current) => ({ ...current, [platform]: !current[platform] }))
  }, [platform, setWorkspaceDockOpen])

  const toggleClaudeFilesPanel = useCallback(() => {
    setFilesPanelOpen((current) => ({ ...current, claude: !current.claude }))
  }, [setFilesPanelOpen])

  const toggleProviderFilesPanel = useCallback(() => {
    setFilesPanelOpen((current) => ({ ...current, [platform]: !current[platform] }))
  }, [platform, setFilesPanelOpen])

  const setPanelSize = useCallback(
    (targetPlatform: PlatformId, key: PanelSizeKey, size: number) => {
      setPanelSizes((current) => ({
        ...current,
        [targetPlatform]: {
          ...current[targetPlatform],
          [key]: clampPanelSize(key, size)
        }
      }))
    },
    [setPanelSizes]
  )

  const detachTerminals = useCallback(
    (targetPlatform: PlatformId) => {
      setTerminalDetached((current) =>
        current[targetPlatform] ? current : { ...current, [targetPlatform]: true }
      )
      window.dashboard.terminal
        .openDetached(targetPlatform)
        .then((opened) => {
          if (!opened) setTerminalDetached((current) => ({ ...current, [targetPlatform]: false }))
        })
        .catch(() => {
          setTerminalDetached((current) => ({ ...current, [targetPlatform]: false }))
        })
    },
    [setTerminalDetached]
  )

  const openDetachedTerminals = useCallback(
    (targetPlatform: PlatformId) => {
      setTerminalDetached((current) =>
        current[targetPlatform] ? current : { ...current, [targetPlatform]: true }
      )
      window.dashboard.terminal
        .openDetached(targetPlatform)
        .then((opened) => {
          if (!opened) setTerminalDetached((current) => ({ ...current, [targetPlatform]: false }))
        })
        .catch(() => {
          setTerminalDetached((current) => ({ ...current, [targetPlatform]: false }))
        })
    },
    [setTerminalDetached]
  )

  const attachTerminals = useCallback(
    (targetPlatform: PlatformId) => {
      setTerminalDetached((current) =>
        current[targetPlatform] ? { ...current, [targetPlatform]: false } : current
      )
      window.dashboard.terminal.attachDetached(targetPlatform).catch(() => undefined)
    },
    [setTerminalDetached]
  )

  // Session details is a modal, not a collapsible panel, so it's excluded from the
  // Collapse all / Expand all set.
  const activePanelStates = useMemo(
    () => [
      projectSidebarOpen[platform],
      historySidebarOpen[platform],
      workspaceDockOpen[platform],
      filesPanelOpen[platform]
    ],
    [filesPanelOpen, historySidebarOpen, platform, projectSidebarOpen, workspaceDockOpen]
  )
  const activePanelsAllCollapsed = activePanelStates.every((open) => !open)
  const activePanelsAllExpanded = activePanelStates.every(Boolean)

  const setActivePlatformPanelsOpen = useCallback(
    (open: boolean) => {
      setProjectSidebarOpen((current) => (current[platform] === open ? current : { ...current, [platform]: open }))
      setHistorySidebarOpen((current) => (current[platform] === open ? current : { ...current, [platform]: open }))
      setWorkspaceDockOpen((current) => (current[platform] === open ? current : { ...current, [platform]: open }))
      setFilesPanelOpen((current) => (current[platform] === open ? current : { ...current, [platform]: open }))
    },
    [platform, setFilesPanelOpen, setHistorySidebarOpen, setProjectSidebarOpen, setWorkspaceDockOpen]
  )
  const collapseAllPanels = useCallback(() => setActivePlatformPanelsOpen(false), [setActivePlatformPanelsOpen])
  const expandAllPanels = useCallback(() => setActivePlatformPanelsOpen(true), [setActivePlatformPanelsOpen])

  const cssVars = useMemo(
    () =>
      ({
        '--accent': activePlatform.accent,
        '--accent-dim': activePlatform.accentDim,
        '--accent-hover': activePlatform.accentHover
      }) as CSSVars,
    [activePlatform]
  )

  return (
    <div className="app-shell" style={cssVars} data-platform={platform}>
      <SplashScreen active={!appReady} />
      {!setupState.done || connectionsOpen ? (
        <SetupGate
          mode={setupState.done ? 'manage' : 'onboarding'}
          initialStatus={isSetupStatus(connectionStatus) ? connectionStatus : null}
          onStatusChange={updateConnectionStatus}
          onDone={() => {
            if (!setupState.done) setSetupState({ done: true })
            setConnectionsOpen(false)
            void refreshConnections()
          }}
        />
      ) : null}
      <Titlebar
        platform={platform}
        platforms={activePlatforms}
        onPlatformChange={setPlatform}
        onOpenConnections={openConnections}
        onOpenSettings={openSettings}
        cheatSheetOpen={cheatSheetOpen}
        onToggleCheatSheet={toggleCheatSheet}
        memoryOpen={memoryOpen}
        onToggleMemory={toggleMemory}
        panelsAllCollapsed={activePanelsAllCollapsed}
        panelsAllExpanded={activePanelsAllExpanded}
        onCollapseAllPanels={collapseAllPanels}
        onExpandAllPanels={expandAllPanels}
        selectedProjectId={selectedProjectIds[platform]}
        onSearchActivate={handleSearchActivate}
      />
      <SettingsModal open={settingsOpen} onClose={closeSettings} />
      <OpenCodeSlimUpdateBanner />
      {memoryOpen ? (
        <MemoryView
          platform={platform}
          projectId={selectedProjectIds[platform]}
          initialFileId={memorySelectionRequest?.id ?? null}
          initialFileRequestKey={memorySelectionRequest?.sequence ?? null}
          onClose={() => {
            setMemoryOpen(false)
            setMemorySelectionRequest(null)
          }}
        />
      ) : cheatSheetOpen ? (
        <CheatSheet onClose={() => setCheatSheetOpen(false)} />
      ) : platform === 'claude' ? (
        <ClaudeWorkspace
          onReady={handleWorkspaceReady}
          usageState={planUsageStates.claude}
          selectedProjectId={selectedProjectIds.claude}
          selectedSessionId={selectedSessionIds.claude}
          sessionDetailOpen={sessionDetailOpen.claude}
          projectSidebarOpen={projectSidebarOpen.claude}
          historySidebarOpen={historySidebarOpen.claude}
          workspaceDockOpen={workspaceDockOpen.claude}
          filesPanelOpen={filesPanelOpen.claude}
          panelSizes={panelSizes.claude}
          terminalsDetached={terminalDetached.claude}
          followEdits={previewFollowEdits.claude}
          previewSelection={filePreviewSelections.claude}
          onSelectedProjectIdChange={selectClaudeProject}
          onSelectedSessionIdChange={selectClaudeSession}
          onToggleSessionDetail={toggleClaudeSessionDetail}
          onToggleProjectSidebar={toggleClaudeProjectSidebar}
          onToggleHistorySidebar={toggleClaudeHistorySidebar}
          onToggleWorkspaceDock={toggleClaudeWorkspaceDock}
          onToggleFilesPanel={toggleClaudeFilesPanel}
          onPanelResize={(key, size) => setPanelSize('claude', key, size)}
          onPreviewFile={(selection) =>
            setFilePreviewSelections((current) => ({ ...current, claude: selection }))
          }
          onOpenTerminalFile={openTerminalFile}
          onToggleFollowEdits={() =>
            setPreviewFollowEdits((current) => ({ ...current, claude: !current.claude }))
          }
          onDetachTerminals={() => detachTerminals('claude')}
          onOpenDetachedTerminals={() => openDetachedTerminals('claude')}
          onAttachTerminals={() => attachTerminals('claude')}
        />
      ) : (
        <ProviderWorkspace
          platform={platform}
          onReady={handleWorkspaceReady}
          usageState={planUsageStates[platform]}
          selectedProjectId={selectedProjectIds[platform]}
          selectedSessionId={selectedSessionIds[platform]}
          sessionDetailOpen={sessionDetailOpen[platform]}
          projectSidebarOpen={projectSidebarOpen[platform]}
          historySidebarOpen={historySidebarOpen[platform]}
          workspaceDockOpen={workspaceDockOpen[platform]}
          filesPanelOpen={filesPanelOpen[platform]}
          panelSizes={panelSizes[platform]}
          terminalsDetached={terminalDetached[platform]}
          followEdits={previewFollowEdits[platform]}
          previewSelection={filePreviewSelections[platform]}
          onSelectedProjectIdChange={selectProviderProject}
          onSelectedSessionIdChange={selectProviderSession}
          onToggleSessionDetail={toggleProviderSessionDetail}
          onToggleProjectSidebar={toggleProviderProjectSidebar}
          onToggleHistorySidebar={toggleProviderHistorySidebar}
          onToggleWorkspaceDock={toggleProviderWorkspaceDock}
          onToggleFilesPanel={toggleProviderFilesPanel}
          onPanelResize={(key, size) => setPanelSize(platform, key, size)}
          onPreviewFile={(selection) =>
            setFilePreviewSelections((current) => ({ ...current, [platform]: selection }))
          }
          onOpenTerminalFile={openTerminalFile}
          onToggleFollowEdits={() =>
            setPreviewFollowEdits((current) => ({ ...current, [platform]: !current[platform] }))
          }
          onDetachTerminals={() => detachTerminals(platform)}
          onOpenDetachedTerminals={() => openDetachedTerminals(platform)}
          onAttachTerminals={() => attachTerminals(platform)}
        />
      )}
      {searchPreview ? (
        <FilePreviewModal
          request={searchPreview.request}
          highlight={searchPreview.highlight}
          scrollToLine={searchPreview.scrollToLine}
          onOpenExternally={() => window.dashboard.projectFiles.open(searchPreview.request)}
          onClose={() => setSearchPreview(null)}
        />
      ) : null}
    </div>
  )
}

function DetachedTerminalWindow({ platform }: { platform: PlatformId }): JSX.Element {
  const platformConfig = PLATFORM_CONFIG[platform]
  const [selectedSessionIds, setSelectedSessionIds] = usePersistentState<Record<PlatformId, string | null>>(
    'selection:sessions:v1',
    { claude: null, codex: null, opencode: null },
    undefined,
    // Load-only (see the main window's copy): strip a stale pending selection on
    // first mount, but let a live pending selection sync in from the main window.
    (value) => ({
      claude: isPendingSessionId(value.claude) ? null : value.claude,
      codex: isPendingSessionId(value.codex) ? null : value.codex,
      opencode: isPendingSessionId(value.opencode) ? null : value.opencode
    })
  )
  const [selectedProjectIds, setSelectedProjectIds] = usePersistentState<Record<PlatformId, string | null>>(
    'selection:projects:v1',
    { claude: null, codex: null, opencode: null }
  )
  const selectSession = useCallback(
    (sessionId: string | null) => {
      setSelectedSessionIds((current) =>
        current[platform] === sessionId ? current : { ...current, [platform]: sessionId }
      )
    },
    [platform, setSelectedSessionIds]
  )
  const selectProject = useCallback(
    (projectId: string | null) => {
      setSelectedProjectIds((current) =>
        current[platform] === projectId ? current : { ...current, [platform]: projectId }
      )
    },
    [platform, setSelectedProjectIds]
  )
  const attachHere = useCallback(() => {
    window.dashboard.terminal.attachDetached(platform).catch(() => window.dashboard.window.close())
  }, [platform])

  const sessionBrowser = useProjectSessionBrowserState({
    platform,
    selectedProjectId: selectedProjectIds[platform],
    selectedSessionId: selectedSessionIds[platform],
    onSelectedProjectIdChange: selectProject,
    onSelectedSessionIdChange: selectSession
  })
  const {
    visibleTabs,
    backgroundTabCount,
    backgroundSessionCount,
    backgroundTerminals,
    addTerminal,
    closeTerminal,
    selectBackgroundTerminal
  } = useSessionScopedTerminals(platform, sessionBrowser, selectedSessionIds[platform], selectProject, selectSession)
  const cssVars = useMemo(
    () =>
      ({
        '--accent': platformConfig.accent,
        '--accent-dim': platformConfig.accentDim,
        '--accent-hover': platformConfig.accentHover
      }) as CSSVars,
    [platformConfig]
  )

  // A file clicked inside a detached terminal previews in this window's own modal
  // (the main-window preview pane lives in a different process/window).
  const [filePreview, setFilePreview] = useState<{ request: FileRequest; line?: number } | null>(null)

  return (
    <div className="app-shell detached-terminal-shell" style={cssVars} data-platform={platform}>
      <header className="detached-terminal-titlebar">
        <div className="detached-terminal-heading">
          <CadenceMark className="titlebar-logo" />
          <span>{platformConfig.label} Terminals</span>
          <span className="detached-terminal-project">
            {sessionBrowser.selectedProject?.name ?? 'No project selected'}
          </span>
        </div>
        <div className="detached-terminal-actions">
          <button type="button" className="terminal-action" onClick={attachHere}>
            Attach to main
          </button>
        </div>
        <WindowControls />
      </header>
      <main className="detached-terminal-body">
        <TerminalDeck
          platform={platform}
          tabs={visibleTabs}
          defaultCwd={sessionBrowser.selectedProject?.path ?? null}
          defaultWslDistro={sessionBrowser.selectedProject?.origin?.distro ?? null}
          projectName={sessionBrowser.selectedProject?.name ?? null}
          loading={sessionBrowser.loading && !sessionBrowser.selectedProject}
          backgroundTabCount={backgroundTabCount}
          backgroundSessionCount={backgroundSessionCount}
          backgroundTerminals={backgroundTerminals}
          onSelectBackgroundTerminal={selectBackgroundTerminal}
          onAdd={addTerminal}
          onClose={closeTerminal}
          onOpenFile={(request, line) => setFilePreview({ request, line })}
        />
      </main>
      {filePreview ? (
        <FilePreviewModal
          request={filePreview.request}
          scrollToLine={filePreview.line}
          onOpenExternally={() => window.dashboard.projectFiles.open(filePreview.request)}
          onClose={() => setFilePreview(null)}
        />
      ) : null}
    </div>
  )
}

function Titlebar({
  platform,
  platforms,
  onPlatformChange,
  onOpenConnections,
  onOpenSettings,
  cheatSheetOpen,
  onToggleCheatSheet,
  memoryOpen,
  onToggleMemory,
  panelsAllCollapsed,
  panelsAllExpanded,
  onCollapseAllPanels,
  onExpandAllPanels,
  selectedProjectId,
  onSearchActivate
}: {
  platform: PlatformId
  // Connected platforms. The switcher shows only when more than one is active;
  // with a single platform it collapses to a static label.
  platforms: PlatformId[]
  onPlatformChange: (platform: PlatformId) => void
  onOpenConnections: () => void
  onOpenSettings: () => void
  cheatSheetOpen: boolean
  onToggleCheatSheet: () => void
  memoryOpen: boolean
  onToggleMemory: () => void
  panelsAllCollapsed: boolean
  panelsAllExpanded: boolean
  onCollapseAllPanels: () => void
  onExpandAllPanels: () => void
  selectedProjectId: string | null
  onSearchActivate: (item: SearchResultItem, query: string) => void
}): JSX.Element {
  const [version, setVersion] = useState<string>('')
  const platformLabel = PLATFORM_CONFIG[platform].label
  useEffect(() => {
    window.dashboard?.app?.getVersion?.().then(setVersion).catch(() => undefined)
  }, [])
  const viewItems = useMemo<TitlebarMenuItem[]>(
    () => [
      {
        id: 'collapse-all',
        label: 'Collapse all',
        description: `Collapse all ${platformLabel} panels`,
        icon: <CollapseAllIcon />,
        disabled: panelsAllCollapsed,
        onSelect: onCollapseAllPanels
      },
      {
        id: 'expand-all',
        label: 'Expand all',
        description: `Expand all ${platformLabel} panels`,
        icon: <ExpandAllIcon />,
        disabled: panelsAllExpanded,
        onSelect: onExpandAllPanels
      }
    ],
    [onCollapseAllPanels, onExpandAllPanels, panelsAllCollapsed, panelsAllExpanded, platformLabel]
  )
  const toolItems = useMemo<TitlebarMenuItem[]>(
    () => [
      {
        id: 'connections',
        label: 'Connections',
        description: 'Manage connected AI tools',
        icon: <ConnectionsIcon />,
        onSelect: onOpenConnections
      },
      {
        id: 'memory',
        label: 'Memory',
        description: 'Project memory and context',
        icon: <MemoryIcon />,
        checked: memoryOpen,
        onSelect: onToggleMemory
      },
      {
        id: 'commands',
        label: 'Commands',
        description: 'Terminal commands cheat sheet',
        icon: <CommandsIcon />,
        checked: cheatSheetOpen,
        onSelect: onToggleCheatSheet
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Cadence application preferences',
        icon: <SettingsIcon />,
        onSelect: onOpenSettings
      }
    ],
    [
      cheatSheetOpen,
      memoryOpen,
      onOpenConnections,
      onOpenSettings,
      onToggleCheatSheet,
      onToggleMemory
    ]
  )
  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <CadenceMark className="titlebar-logo" />
        <div className="titlebar-brand-lockup">
          <span className="titlebar-brand-name">{APP_NAME}</span>
          {version ? (
            <span className="app-version" title={`${APP_NAME} v${version}`}>
              v{version}
            </span>
          ) : null}
        </div>
        <TitlebarMenus viewItems={viewItems} toolItems={toolItems} />
      </div>
      {platforms.length > 1 ? (
        <div className="platform-switcher" role="tablist" aria-label="Platform">
          {platforms.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={platform === id}
              className={platform === id ? 'active' : 'inactive'}
              onClick={() => onPlatformChange(id)}
            >
              {PLATFORM_CONFIG[id].label}
            </button>
          ))}
        </div>
      ) : (
        <div className="platform-indicator" aria-label="Platform">
          {PLATFORM_CONFIG[platforms[0] ?? platform].label}
        </div>
      )}
      <div className="titlebar-right">
        <TitlebarSearch platform={platform} projectId={selectedProjectId} onActivate={onSearchActivate} />
      </div>
      <WindowControls />
    </header>
  )
}

function SettingsIcon(): JSX.Element {
  return (
    <svg className="titlebar-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="2.25" />
      <path d="M6.9 2.4 7.3 1h1.4l.4 1.4 1.2.5 1.3-.7 1 1-0.7 1.3.5 1.2 1.4.4v1.4l-1.4.4-.5 1.2.7 1.3-1 1-1.3-.7-1.2.5-.4 1.4H7.3l-.4-1.4-1.2-.5-1.3.7-1-1 .7-1.3L3.6 9l-1.4-.4V7.2l1.4-.4.5-1.2-.7-1.3 1-1 1.3.7 1.2-.5Z" />
    </svg>
  )
}

// Memory bank: a stacked database cylinder (the legible line-icon version of the
// old ⛁ glyph). Stroked with currentColor so it tracks the button's text colour
// through hover/active, matching the file-tree action icons.
function MemoryIcon(): JSX.Element {
  return (
    <svg className="titlebar-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <ellipse cx="8" cy="3.75" rx="5" ry="2" />
      <path d="M3 3.75v8.5c0 1.1 2.24 2 5 2s5-.9 5-2v-8.5" />
      <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </svg>
  )
}

// Terminal commands cheat sheet: a terminal window with a prompt chevron and
// command line. Same stroked-currentColor method as MemoryIcon / the file-tree
// icons, replacing the old ">_" text glyph.
function CommandsIcon(): JSX.Element {
  return (
    <svg className="titlebar-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.75" y="3" width="12.5" height="10" rx="1.5" />
      <path d="M4.5 6.5l2 1.75-2 1.75" />
      <path d="M8 10.25h3.5" />
    </svg>
  )
}

// Connections / setup: three linked endpoints, distinct from the Settings gear.
function ConnectionsIcon(): JSX.Element {
  return (
    <svg className="titlebar-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="4" cy="4" r="1.75" />
      <circle cx="12" cy="5" r="1.75" />
      <circle cx="7.5" cy="12" r="1.75" />
      <path d="m5.7 4.2 4.55.55M5 5.55l1.65 4.8M10.85 6.55 8.6 10.4" />
    </svg>
  )
}

// Collapse-all / expand-all: stacked chevrons that point inward (collapse) or
// outward (expand), mirroring the vertical panel motion they control. Shown only
// at narrow widths where the "Collapse all" / "Expand all" labels are hidden.
function CollapseAllIcon(): JSX.Element {
  return (
    <svg className="titlebar-action-icon panel-layout-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5 4l3 3 3-3" />
      <path d="M5 12l3-3 3 3" />
    </svg>
  )
}

function ExpandAllIcon(): JSX.Element {
  return (
    <svg className="titlebar-action-icon panel-layout-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5 6l3-3 3 3" />
      <path d="M5 10l3 3 3-3" />
    </svg>
  )
}

function WindowControls(): JSX.Element {
  return (
    <div className="window-controls">
      <button type="button" aria-label="Minimize" onClick={() => window.dashboard.window.minimize()}>
        <span className="window-control-icon minimize-icon" aria-hidden="true" />
      </button>
      <button type="button" aria-label="Maximize" onClick={() => window.dashboard.window.toggleMaximize()}>
        <span className="window-control-icon maximize-icon" aria-hidden="true" />
      </button>
      <button type="button" aria-label="Close" className="close" onClick={() => window.dashboard.window.close()}>
        <span className="window-control-icon close-icon" aria-hidden="true" />
      </button>
    </div>
  )
}

// The Cadence mark: a node-graph shaped into a 'C' (nodes connected by edges) —
// reads as a dev/network tool and doubles as the Cadence monogram. Inlined as JSX so
// it inherits `currentColor` and stays crisp at any size. Geometry mirrors
// src/renderer/src/assets/cadence-mark.svg and scripts/generate-icon.py — keep the
// three in sync if the shape changes.
function CadenceMark({ className }: { className?: string }): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline
        points="64,27 41,23 25,41 25,59 41,77 64,73"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g fill="currentColor">
        <circle cx="64" cy="27" r="7" />
        <circle cx="41" cy="23" r="7" />
        <circle cx="25" cy="41" r="7" />
        <circle cx="25" cy="59" r="7" />
        <circle cx="41" cy="77" r="7" />
        <circle cx="64" cy="73" r="7" />
      </g>
    </svg>
  )
}

// Full-shell loading screen shown from the first window paint until the active
// platform's first project scan resolves, then faded out and unmounted. Stays
// mounted through the fade so the transition is visible.
function SplashScreen({ active }: { active: boolean }): JSX.Element | null {
  const [rendered, setRendered] = useState(true)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (active) {
      setRendered(true)
      setLeaving(false)
      return
    }
    setLeaving(true)
    const id = window.setTimeout(() => setRendered(false), SPLASH_FADE_MS)
    return () => window.clearTimeout(id)
  }, [active])

  if (!rendered) return null

  return (
    <div className={`splash ${leaving ? 'splash-leaving' : ''}`} role="status" aria-live="polite" aria-hidden={leaving}>
      <div className="splash-body">
        <CadenceMark className="splash-mark" />
        <span className="splash-logo">{APP_NAME}</span>
        <span className="splash-sub">Spinning up your workspace…</span>
        <div className="splash-bar" aria-hidden="true">
          <div className="splash-bar-fill" />
        </div>
      </div>
    </div>
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
  revive?: (value: T) => T,
  // Applied ONLY to the value restored from storage on first mount — never to live
  // cross-window updates. Use this to discard transient state left over from a
  // previous run (e.g. a pending "new session" selection) while still letting an
  // identical selection made in another live window (the detached terminal window
  // shares these keys) sync across intact. Applying it to live updates would scrub
  // a freshly started session as its selection round-trips between windows.
  reviveOnLoad?: (value: T) => T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key)
      if (raw) {
        let merged = { ...fallback, ...(JSON.parse(raw) as Partial<T>) } as T
        if (revive) merged = revive(merged)
        if (reviveOnLoad) merged = reviveOnLoad(merged)
        return merged
      }
    } catch {
      // Corrupt/unavailable storage falls back to defaults.
    }
    return fallback
  })

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.storageArea !== window.localStorage || event.key !== key) return
      try {
        const next = event.newValue
          ? ({ ...fallback, ...(JSON.parse(event.newValue) as Partial<T>) } as T)
          : fallback
        const revived = revive ? revive(next) : next
        setValue((current) => (JSON.stringify(current) === JSON.stringify(revived) ? current : revived))
      } catch {
        setValue(fallback)
      }
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [key, revive])

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Persistence is best-effort.
    }
  }, [key, value])

  return [value, setValue]
}

function usePlanUsagePolling(connectedPlatforms: PlatformId[] | null): PlanUsageStates {
  const [states, setStates] = useState<PlanUsageStates>({
    claude: { planUsage: null, planError: null, refreshing: false },
    codex: { planUsage: null, planError: null, refreshing: false },
    opencode: { planUsage: null, planError: null, refreshing: false }
  })

  const fetchPlan = useCallback((platform: PlatformId) => {
    const loader: (() => Promise<PlanUsageDisplay>) | undefined =
      platform === 'claude'
        ? window.dashboard?.usage?.getClaudePlanUsage
        : platform === 'codex'
          ? window.dashboard?.usage?.getCodexPlanUsage
          : window.dashboard?.usage?.getOpenCodePlanUsage

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
    if (!connectedPlatforms) return

    const connected = new Set(connectedPlatforms)
    setStates((current) => {
      const next = { ...current }
      for (const platform of PLATFORM_IDS) {
        if (!connected.has(platform)) {
          next[platform] = { planUsage: null, planError: null, refreshing: false }
        }
      }
      return next
    })

    connectedPlatforms.forEach(fetchPlan)
    if (connectedPlatforms.length === 0) return
    const id = setInterval(() => {
      connectedPlatforms.forEach(fetchPlan)
    }, PLAN_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [connectedPlatforms, fetchPlan])

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

function usePanelResizeHandlers(
  panelSizes: PlatformPanelSizes,
  onPanelResize: (key: PanelSizeKey, size: number) => void
): {
  startProjectSidebarResize: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
  startProjectListResize: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
  startFilesPanelResize: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
  startHistorySidebarResize: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
  startWorkspaceDockResize: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
} {
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLElement>, key: PanelSizeKey, edge: PanelResizeEdge, startSize: number) => {
      startPanelResize({
        event,
        key,
        edge,
        startSize: startSize || panelSizes[key] || PANEL_SIZE_FALLBACKS[key],
        onResize: (size) => onPanelResize(key, size)
      })
    },
    [onPanelResize, panelSizes]
  )

  return {
    startProjectSidebarResize: useCallback(
      (event, startSize) => startResize(event, 'projectSidebar', 'right', startSize),
      [startResize]
    ),
    startProjectListResize: useCallback(
      (event, startSize) => startResize(event, 'projectList', 'bottom', startSize),
      [startResize]
    ),
    startFilesPanelResize: useCallback(
      (event, startSize) => startResize(event, 'filesPanel', 'right', startSize),
      [startResize]
    ),
    startHistorySidebarResize: useCallback(
      (event, startSize) => startResize(event, 'historySidebar', 'left', startSize),
      [startResize]
    ),
    startWorkspaceDockResize: useCallback(
      (event, startSize) => startResize(event, 'workspaceDock', 'top', startSize),
      [startResize]
    )
  }
}

function ClaudeWorkspace({
  onReady,
  usageState,
  selectedProjectId,
  selectedSessionId,
  sessionDetailOpen,
  projectSidebarOpen,
  historySidebarOpen,
  workspaceDockOpen,
  filesPanelOpen,
  panelSizes,
  terminalsDetached,
  followEdits,
  previewSelection,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange,
  onToggleSessionDetail,
  onToggleProjectSidebar,
  onToggleHistorySidebar,
  onToggleWorkspaceDock,
  onToggleFilesPanel,
  onPanelResize,
  onPreviewFile,
  onOpenTerminalFile,
  onToggleFollowEdits,
  onDetachTerminals,
  onOpenDetachedTerminals,
  onAttachTerminals
}: {
  onReady: () => void
  usageState: PlanUsageState<ClaudePlanUsage>
  selectedProjectId: string | null
  selectedSessionId: string | null
  sessionDetailOpen: boolean
  projectSidebarOpen: boolean
  historySidebarOpen: boolean
  workspaceDockOpen: boolean
  filesPanelOpen: boolean
  panelSizes: PlatformPanelSizes
  terminalsDetached: boolean
  followEdits: boolean
  previewSelection: FilePreviewSelection | null
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
  onToggleSessionDetail: () => void
  onToggleProjectSidebar: () => void
  onToggleHistorySidebar: () => void
  onToggleWorkspaceDock: () => void
  onToggleFilesPanel: () => void
  onPanelResize: (key: PanelSizeKey, size: number) => void
  onPreviewFile: (selection: FilePreviewSelection) => void
  onOpenTerminalFile: (request: FileRequest, line?: number) => void
  onToggleFollowEdits: () => void
  onDetachTerminals: () => void
  onOpenDetachedTerminals: () => void
  onAttachTerminals: () => void
}): JSX.Element {
  const { planUsage, planError } = usageState
  const sessionBrowser = useProjectSessionBrowserState({
    platform: 'claude',
    selectedProjectId,
    selectedSessionId,
    onSelectedProjectIdChange,
    onSelectedSessionIdChange
  })
  // Dismiss the splash once the first project scan resolves (onReady is idempotent).
  const sessionsLoading = sessionBrowser.loading
  useEffect(() => {
    if (!sessionsLoading) onReady()
  }, [sessionsLoading, onReady])
  const historyState = useSessionHistory(sessionBrowser.selectedSession)
  const {
    visibleTabs,
    backgroundTabCount,
    backgroundSessionCount,
    backgroundTerminals,
    pendingSessions,
    addTerminal: handleAddTerminal,
    resumeSession,
    closeTerminal,
    selectBackgroundTerminal,
    startSession,
    abandonPendingSession,
    renamePendingSession
  } = useSessionScopedTerminals(
    'claude',
    sessionBrowser,
    selectedSessionId,
    onSelectedProjectIdChange,
    onSelectedSessionIdChange
  )
  const { contentBodyRef, toggleHistorySidebar } = useHistorySidebarMotion(
    historySidebarOpen,
    onToggleHistorySidebar
  )
  const panelResize = usePanelResizeHandlers(panelSizes, onPanelResize)
  const newSession = isPendingSessionId(selectedSessionId)
  const selectedProject = sessionBrowser.selectedProject
  const watchRoot = useMemo<ProjectFileWatchRequest | null>(
    () =>
      selectedProject?.path
        ? { rootPath: selectedProject.path, distro: selectedProject.origin?.distro ?? null }
        : null,
    [selectedProject]
  )
  const fileChangeState = useProjectFileWatcher(watchRoot, terminalsDetached && followEdits)
  const activePreview = previewSelection?.projectId === selectedProject?.id ? previewSelection : null
  const previewExtraActions = (
    <>
      <button type="button" onClick={onOpenDetachedTerminals}>
        Open detached
      </button>
      <button type="button" onClick={onAttachTerminals}>
        Show terminals here
      </button>
    </>
  )

  const handlePreviewFile = useCallback(
    (relPath: string) => {
      if (!selectedProject?.path) return
      onPreviewFile({
        projectId: selectedProject.id,
        request: {
          rootPath: selectedProject.path,
          distro: selectedProject.origin?.distro ?? null,
          relPath
        }
      })
    },
    [onPreviewFile, selectedProject]
  )

  // Auto-follow: react only to genuinely new watcher events. `onPreviewFile` is a
  // fresh closure on every App render, so without this per-sequence guard the
  // effect would re-run on every incidental re-render (e.g. opening a search
  // result) while an event is present and loop setState → render → setState.
  const lastFollowedSequenceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!terminalsDetached || !followEdits || !selectedProject?.id || !fileChangeState.event) return
    if (lastFollowedSequenceRef.current === fileChangeState.sequence) return
    lastFollowedSequenceRef.current = fileChangeState.sequence
    onPreviewFile({
      projectId: selectedProject.id,
      request: {
        rootPath: fileChangeState.event.rootPath,
        distro: fileChangeState.event.distro,
        relPath: fileChangeState.event.relPath
      },
      changeToken: fileChangeState.sequence
    })
  }, [fileChangeState.event, fileChangeState.sequence, followEdits, onPreviewFile, selectedProject, terminalsDetached])

  return (
    <main className="workspace">
      <ProjectSessionSidebar
        title="Projects"
        ariaLabel="Claude projects"
        emptyLabel="No Claude projects found"
        browser={sessionBrowser}
        pendingSessions={pendingSessions}
        open={projectSidebarOpen}
        onToggle={onToggleProjectSidebar}
        width={panelSizes.projectSidebar}
        onResizeStart={panelResize.startProjectSidebarResize}
        projectListHeight={panelSizes.projectList}
        onProjectListResize={panelResize.startProjectListResize}
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
          <FileTreePanel
            rootPath={sessionBrowser.selectedProject?.path ?? null}
            distro={sessionBrowser.selectedProject?.origin?.distro ?? null}
            projectId={sessionBrowser.selectedProject?.id ?? null}
            projectName={sessionBrowser.selectedProject?.name ?? null}
            open={filesPanelOpen}
            onToggle={onToggleFilesPanel}
            width={panelSizes.filesPanel}
            onResizeStart={panelResize.startFilesPanelResize}
            onPreviewFile={terminalsDetached ? handlePreviewFile : undefined}
          />
          <div className="main-stack">
            {sessionDetailOpen && sessionBrowser.selectedSession ? (
              <SessionDetailModal session={sessionBrowser.selectedSession} onClose={onToggleSessionDetail} />
            ) : null}
            {terminalsDetached ? (
              <FilePreviewPane
                request={activePreview?.request ?? null}
                highlight={activePreview?.highlight}
                followEdits={followEdits}
                watchMode={fileChangeState.mode}
                watchError={fileChangeState.error}
                changeToken={activePreview?.changeToken}
                onToggleFollowEdits={onToggleFollowEdits}
                extraActions={previewExtraActions}
                onOpenExternally={() =>
                  activePreview
                    ? window.dashboard.projectFiles.open(activePreview.request)
                    : Promise.resolve({ ok: false, error: 'No file selected' })
                }
              />
            ) : (
              <TerminalDeck
                platform="claude"
                tabs={visibleTabs}
                defaultCwd={sessionBrowser.selectedProject?.path ?? null}
                defaultWslDistro={sessionBrowser.selectedProject?.origin?.distro ?? null}
                projectName={sessionBrowser.selectedProject?.name ?? null}
                loading={sessionBrowser.loading && !sessionBrowser.selectedProject}
                backgroundTabCount={backgroundTabCount}
                backgroundSessionCount={backgroundSessionCount}
                backgroundTerminals={backgroundTerminals}
                onSelectBackgroundTerminal={selectBackgroundTerminal}
                onAdd={handleAddTerminal}
                onClose={closeTerminal}
                onOpenFile={onOpenTerminalFile}
                onDetach={onDetachTerminals}
              />
            )}
            <ProjectWorkspaceDock
              projectId={sessionBrowser.selectedProject?.id ?? null}
              projectName={sessionBrowser.selectedProject?.name ?? null}
              open={workspaceDockOpen}
              onToggle={onToggleWorkspaceDock}
              height={panelSizes.workspaceDock}
              onResizeStart={panelResize.startWorkspaceDockResize}
            />
          </div>
          <SessionHistorySidebar
            session={sessionBrowser.selectedSession}
            historyState={historyState}
            newSession={newSession}
            open={historySidebarOpen}
            onToggle={toggleHistorySidebar}
            width={panelSizes.historySidebar}
            onResizeStart={panelResize.startHistorySidebarResize}
            onShowDetails={onToggleSessionDetail}
            onResume={() => {
              const target = sessionBrowser.selectedSession
              if (target) resumeSession(target)
            }}
          />
        </div>
      </section>
    </main>
  )
}

function ProviderWorkspace({
  platform,
  onReady,
  usageState,
  selectedProjectId,
  selectedSessionId,
  sessionDetailOpen,
  projectSidebarOpen,
  historySidebarOpen,
  workspaceDockOpen,
  filesPanelOpen,
  panelSizes,
  terminalsDetached,
  followEdits,
  previewSelection,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange,
  onToggleSessionDetail,
  onToggleProjectSidebar,
  onToggleHistorySidebar,
  onToggleWorkspaceDock,
  onToggleFilesPanel,
  onPanelResize,
  onPreviewFile,
  onOpenTerminalFile,
  onToggleFollowEdits,
  onDetachTerminals,
  onOpenDetachedTerminals,
  onAttachTerminals
}: {
  platform: PlatformId
  onReady: () => void
  usageState: PlanUsageState<PlanUsageDisplay>
  selectedProjectId: string | null
  selectedSessionId: string | null
  sessionDetailOpen: boolean
  projectSidebarOpen: boolean
  historySidebarOpen: boolean
  workspaceDockOpen: boolean
  filesPanelOpen: boolean
  panelSizes: PlatformPanelSizes
  terminalsDetached: boolean
  followEdits: boolean
  previewSelection: FilePreviewSelection | null
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
  onToggleSessionDetail: () => void
  onToggleProjectSidebar: () => void
  onToggleHistorySidebar: () => void
  onToggleWorkspaceDock: () => void
  onToggleFilesPanel: () => void
  onPanelResize: (key: PanelSizeKey, size: number) => void
  onPreviewFile: (selection: FilePreviewSelection) => void
  onOpenTerminalFile: (request: FileRequest, line?: number) => void
  onToggleFollowEdits: () => void
  onDetachTerminals: () => void
  onOpenDetachedTerminals: () => void
  onAttachTerminals: () => void
}): JSX.Element {
  const { planUsage, planError } = usageState
  const platformConfig = PLATFORM_CONFIG[platform]
  const sessionBrowser = useProjectSessionBrowserState({
    platform,
    selectedProjectId,
    selectedSessionId,
    onSelectedProjectIdChange,
    onSelectedSessionIdChange
  })
  // Dismiss the splash once the first project scan resolves (onReady is idempotent).
  const sessionsLoading = sessionBrowser.loading
  useEffect(() => {
    if (!sessionsLoading) onReady()
  }, [sessionsLoading, onReady])
  const historyState = useSessionHistory(sessionBrowser.selectedSession)
  const {
    visibleTabs,
    backgroundTabCount,
    backgroundSessionCount,
    backgroundTerminals,
    pendingSessions,
    addTerminal: handleAddTerminal,
    resumeSession,
    closeTerminal,
    selectBackgroundTerminal,
    startSession,
    abandonPendingSession,
    renamePendingSession
  } = useSessionScopedTerminals(
    platform,
    sessionBrowser,
    selectedSessionId,
    onSelectedProjectIdChange,
    onSelectedSessionIdChange
  )
  const { contentBodyRef, toggleHistorySidebar } = useHistorySidebarMotion(
    historySidebarOpen,
    onToggleHistorySidebar
  )
  const panelResize = usePanelResizeHandlers(panelSizes, onPanelResize)
  const newSession = isPendingSessionId(selectedSessionId)
  const selectedProject = sessionBrowser.selectedProject
  useEffect(() => {
    if (platform !== 'opencode' || sessionBrowser.loading) return
    window.dashboard.openCode
      .setCompanionTarget({
        sessionId: newSession ? null : selectedSessionId,
        projectId: selectedProject?.id ?? null,
        projectName: selectedProject?.name ?? sessionBrowser.selectedSession?.project ?? null
      })
      .catch(() => undefined)
  }, [
    newSession,
    platform,
    sessionBrowser.loading,
    selectedProject?.id,
    selectedProject?.name,
    selectedSessionId,
    sessionBrowser.selectedSession?.project
  ])
  const watchRoot = useMemo<ProjectFileWatchRequest | null>(
    () =>
      selectedProject?.path
        ? { rootPath: selectedProject.path, distro: selectedProject.origin?.distro ?? null }
        : null,
    [selectedProject]
  )
  const fileChangeState = useProjectFileWatcher(watchRoot, terminalsDetached && followEdits)
  const activePreview = previewSelection?.projectId === selectedProject?.id ? previewSelection : null
  const previewExtraActions = (
    <>
      <button type="button" onClick={onOpenDetachedTerminals}>
        Open detached
      </button>
      <button type="button" onClick={onAttachTerminals}>
        Show terminals here
      </button>
    </>
  )

  const handlePreviewFile = useCallback(
    (relPath: string) => {
      if (!selectedProject?.path) return
      onPreviewFile({
        projectId: selectedProject.id,
        request: {
          rootPath: selectedProject.path,
          distro: selectedProject.origin?.distro ?? null,
          relPath
        }
      })
    },
    [onPreviewFile, selectedProject]
  )

  // Auto-follow: react only to genuinely new watcher events. `onPreviewFile` is a
  // fresh closure on every App render, so without this per-sequence guard the
  // effect would re-run on every incidental re-render (e.g. opening a search
  // result) while an event is present and loop setState → render → setState.
  const lastFollowedSequenceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!terminalsDetached || !followEdits || !selectedProject?.id || !fileChangeState.event) return
    if (lastFollowedSequenceRef.current === fileChangeState.sequence) return
    lastFollowedSequenceRef.current = fileChangeState.sequence
    onPreviewFile({
      projectId: selectedProject.id,
      request: {
        rootPath: fileChangeState.event.rootPath,
        distro: fileChangeState.event.distro,
        relPath: fileChangeState.event.relPath
      },
      changeToken: fileChangeState.sequence
    })
  }, [fileChangeState.event, fileChangeState.sequence, followEdits, onPreviewFile, selectedProject, terminalsDetached])
  return (
    <main className="workspace">
      <ProjectSessionSidebar
        title="Projects"
        ariaLabel={`${platformConfig.label} projects`}
        emptyLabel={`No ${platformConfig.label} projects found`}
        browser={sessionBrowser}
        pendingSessions={pendingSessions}
        open={projectSidebarOpen}
        onToggle={onToggleProjectSidebar}
        width={panelSizes.projectSidebar}
        onResizeStart={panelResize.startProjectSidebarResize}
        projectListHeight={panelSizes.projectList}
        onProjectListResize={panelResize.startProjectListResize}
        onStartSession={startSession}
        onAbandonPendingSession={abandonPendingSession}
        onRenamePendingSession={renamePendingSession}
      />

      <section className="content-grid" aria-label={`${platformConfig.label} dashboard`}>
        <UsageStrip
          planUsage={planUsage}
          planError={planError}
          loadingLabel={`Fetching ${platformConfig.label} usage`}
          spend={platform === 'opencode' ? openCodeSpend(planUsage) : null}
        />

        <div
          ref={contentBodyRef}
          className={`content-body ${historySidebarOpen ? 'history-open' : 'history-closed'}`}
        >
          <FileTreePanel
            rootPath={sessionBrowser.selectedProject?.path ?? null}
            distro={sessionBrowser.selectedProject?.origin?.distro ?? null}
            projectId={sessionBrowser.selectedProject?.id ?? null}
            projectName={sessionBrowser.selectedProject?.name ?? null}
            open={filesPanelOpen}
            onToggle={onToggleFilesPanel}
            width={panelSizes.filesPanel}
            onResizeStart={panelResize.startFilesPanelResize}
            onPreviewFile={terminalsDetached ? handlePreviewFile : undefined}
          />
          <div className="main-stack">
            {sessionDetailOpen && sessionBrowser.selectedSession ? (
              <SessionDetailModal session={sessionBrowser.selectedSession} onClose={onToggleSessionDetail} />
            ) : null}
            {terminalsDetached ? (
              <FilePreviewPane
                request={activePreview?.request ?? null}
                highlight={activePreview?.highlight}
                followEdits={followEdits}
                watchMode={fileChangeState.mode}
                watchError={fileChangeState.error}
                changeToken={activePreview?.changeToken}
                onToggleFollowEdits={onToggleFollowEdits}
                extraActions={previewExtraActions}
                onOpenExternally={() =>
                  activePreview
                    ? window.dashboard.projectFiles.open(activePreview.request)
                    : Promise.resolve({ ok: false, error: 'No file selected' })
                }
              />
            ) : (
              <TerminalDeck
                platform={platform}
                tabs={visibleTabs}
                defaultCwd={sessionBrowser.selectedProject?.path ?? null}
                defaultWslDistro={sessionBrowser.selectedProject?.origin?.distro ?? null}
                projectName={sessionBrowser.selectedProject?.name ?? null}
                loading={sessionBrowser.loading && !sessionBrowser.selectedProject}
                backgroundTabCount={backgroundTabCount}
                backgroundSessionCount={backgroundSessionCount}
                backgroundTerminals={backgroundTerminals}
                onSelectBackgroundTerminal={selectBackgroundTerminal}
                onAdd={handleAddTerminal}
                onClose={closeTerminal}
                onOpenFile={onOpenTerminalFile}
                onDetach={onDetachTerminals}
              />
            )}
            {platform === 'opencode' ? (
              <OpenCodeActivityPanel
                sessionId={newSession ? null : selectedSessionId}
                projectPath={sessionBrowser.selectedProject?.path ?? null}
                wslDistro={sessionBrowser.selectedProject?.origin?.distro ?? null}
                onOpenFile={onOpenTerminalFile}
              />
            ) : null}
            <ProjectWorkspaceDock
              projectId={sessionBrowser.selectedProject?.id ?? null}
              projectName={sessionBrowser.selectedProject?.name ?? null}
              open={workspaceDockOpen}
              onToggle={onToggleWorkspaceDock}
              height={panelSizes.workspaceDock}
              onResizeStart={panelResize.startWorkspaceDockResize}
            />
          </div>
          <SessionHistorySidebar
            session={sessionBrowser.selectedSession}
            historyState={historyState}
            newSession={newSession}
            open={historySidebarOpen}
            onToggle={toggleHistorySidebar}
            width={panelSizes.historySidebar}
            onResizeStart={panelResize.startHistorySidebarResize}
            onShowDetails={onToggleSessionDetail}
            onResume={() => {
              const target = sessionBrowser.selectedSession
              if (target) resumeSession(target)
            }}
          />
        </div>
      </section>
    </main>
  )
}

function UsageStrip({
  planUsage,
  planError,
  loadingLabel,
  spend
}: {
  planUsage: PlanUsageDisplay | null
  planError: string | null
  loadingLabel: string
  // Present only for OpenCode, whose figures are metered spend rather than a
  // quota — see OpenCodeUsageStrip.
  spend?: OpenCodeSpend | null
}): JSX.Element {
  const refreshLabel = planUsage ? usageRefreshLabel(planUsage, planError) : null
  const refreshTitle = planUsage ? planError ?? planUsage.refresh?.message ?? undefined : undefined
  const unavailableMessage =
    planError ??
    (planUsage?.refresh?.state === 'rate_limited' ? refreshLabel : planUsage?.refresh?.message) ??
    loadingLabel

  if (spend) return <OpenCodeUsageStrip spend={spend} planError={planError} />

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
        <UsageBarPlaceholder label="5-Hour Usage" message={unavailableMessage} />
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
        <UsageBarPlaceholder label="Weekly Usage" message={unavailableMessage} />
      )}
      {planUsage && 'monthly' in planUsage ? (
        planUsage.monthly ? (
          <UsageBar
            label="Monthly Estimate"
            utilization={planUsage.monthly.utilization}
            resetsAt={planUsage.monthly.resetsAt}
            refreshLabel={refreshLabel}
            refreshTitle={refreshTitle}
          />
        ) : (
          <UsageBarPlaceholder label="Monthly Estimate" message={unavailableMessage} />
        )
      ) : null}
    </div>
  )
}

function usageRefreshLabel(
  usage: PlanUsageDisplay,
  error: string | null
): string {
  if (error) return 'Refresh error'
  if (usage.refresh?.state === 'rate_limited') {
    const retryAtMs = usage.refresh.nextRefreshAt ? Date.parse(usage.refresh.nextRefreshAt) : Number.NaN
    if (!Number.isNaN(retryAtMs)) {
      const minutes = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 60_000))
      return `Rate limited · retry in ${minutes} min`
    }
    return 'Rate limited · safe retry pending'
  }
  return `${usage.isEstimate ? 'Estimated' : 'Updated'} ${formatUsageFetchedAt(usage.fetchedAt)}`
}

function formatUsageFetchedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--'
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

type OpenCodeSpend = {
  limit: OpenCodePlanLimit | null
  sevenDayCost: number
  monthlyCost: number
}

// Null until the first poll lands, so the strip shows its loading state rather
// than an authoritative-looking $0.00.
function openCodeSpend(planUsage: PlanUsageDisplay | null): OpenCodeSpend | null {
  if (!planUsage || !('monthlyCost' in planUsage)) return null
  const usage = planUsage as OpenCodePlanUsage
  return {
    limit: usage.limit ?? null,
    sevenDayCost: usage.sevenDayCost,
    monthlyCost: usage.monthlyCost
  }
}

function formatSpend(cost: number): string {
  return `$${cost.toFixed(2)}`
}

// OpenCode's plan quota is enforced by the provider and readable nowhere: there is
// no usage endpoint, and plan-included models report zero cost, so a percentage
// bar could only ever sit at 0% however hard the plan is worked. Rather than show
// a gauge that is confidently wrong, this mirrors the context gauge's rule — never
// render a misleading empty gauge — and shows only what is actually known: the
// provider's own limit report when it exists, and real metered spend otherwise.
function OpenCodeUsageStrip({
  spend,
  planError
}: {
  spend: OpenCodeSpend
  planError: string | null
}): JSX.Element {
  const { limit } = spend
  const meteredNote = 'Metered spend only — plan models are not billed per use'

  return (
    <div className="usage-strip">
      {limit ? (
        // A reached limit is the one hard fact available, so it takes the leading
        // slot at full bar: barTier() puts 100% in the critical tier already.
        <UsageBar
          label={`${limit.limitName} limit reached`}
          utilization={100}
          resetsAt={limit.resetsAt}
          refreshLabel="Reported by OpenCode"
          refreshTitle={limit.detail ?? undefined}
        />
      ) : (
        <UsageBarPlaceholder label="Plan limit" message={planError ?? 'No limit reported by OpenCode'} />
      )}
      <UsageBarPlaceholder label="Weekly spend" message={`${formatSpend(spend.sevenDayCost)} · ${meteredNote}`} />
      <UsageBarPlaceholder label="Monthly spend" message={`${formatSpend(spend.monthlyCost)} · ${meteredNote}`} />
    </div>
  )
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
