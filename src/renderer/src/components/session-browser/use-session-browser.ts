import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PlatformId } from '@shared/platform'
import type {
  AssistantProject,
  AssistantSession,
  AssistantSessionHistory,
  SessionTitleGenerationStatus
} from '@shared/sessions'
import { WINDOWS_ORIGIN } from '@shared/sessions'
import type { Workspace } from '@shared/workspaces'
import type {
  GitHubAuthStatus,
  GitHubContextSyncRequest,
  GitHubContextSyncResult,
  GitHubDeviceFlowPollResult,
  GitHubDeviceFlowStartResult,
  GitHubImportRequest,
  GitHubImportResult,
  GitHubRepositoryListResult
} from '@shared/github-import'
import type { SessionMetadata } from '@shared/session-metadata'
import { applyProjectAlias, applySessionAlias, emptyMetadata } from '@shared/session-metadata'

const SESSION_POLL_INTERVAL_MS = 60_000

// Sentinel selection for a freshly started session: nothing exists on disk yet,
// so the History panel is intentionally empty and no list row is highlighted
// until the user's first prompt creates a real transcript the poll can pick up.
export const NEW_SESSION_ID = '__new__'

// Per-start pending ids extend the bare sentinel so several started-but-unsaved
// sessions can coexist (each scoping its own terminals) until their transcripts
// appear and are adopted onto the real session id.
const PENDING_SESSION_PREFIX = '__new__:'

export function createPendingSessionId(): string {
  return `${PENDING_SESSION_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// A pending session is the bare NEW_SESSION_ID sentinel or any per-start pending
// id. Both resolve to an empty selection (no transcript on disk yet) and suppress
// the auto-select-most-recent effect.
export function isPendingSessionId(id: string | null | undefined): boolean {
  return id === NEW_SESSION_ID || (typeof id === 'string' && id.startsWith(PENDING_SESSION_PREFIX))
}

export type ProjectSessionGroup = AssistantProject & {
  sessions: AssistantSession[]
}

type UseProjectSessionBrowserStateArgs = {
  platform: PlatformId
  selectedProjectId: string | null
  selectedSessionId: string | null
  onSelectedProjectIdChange: (projectId: string | null) => void
  onSelectedSessionIdChange: (sessionId: string | null) => void
}

export type ProjectSessionBrowserState = {
  platform: PlatformId
  sessions: AssistantSession[]
  projects: ProjectSessionGroup[]
  filteredProjects: ProjectSessionGroup[]
  selectedProject: ProjectSessionGroup | null
  selectedSession: AssistantSession | null
  selectedProjectId: string | null
  selectedSessionId: string | null
  projectSessions: AssistantSession[]
  loading: boolean
  error: string | null
  titleGenerationStatus: SessionTitleGenerationStatus | null
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  selectProject: (projectId: string) => void
  selectSession: (sessionId: string) => void
  refreshSessions: () => Promise<void>
  attachWorkspace: () => Promise<void>
  getGitHubAuthStatus: () => Promise<GitHubAuthStatus | null>
  startGitHubDeviceFlow: (clientId?: string | null) => Promise<GitHubDeviceFlowStartResult>
  pollGitHubDeviceFlow: () => Promise<GitHubDeviceFlowPollResult>
  openGitHubDevicePage: () => Promise<{ ok: boolean; error?: string }>
  signOutGitHub: () => Promise<GitHubAuthStatus | null>
  listGitHubRepositories: (page?: number) => Promise<GitHubRepositoryListResult>
  chooseGithubImportDirectory: () => Promise<string | null>
  importGithubProject: (request: Omit<GitHubImportRequest, 'platform'>) => Promise<GitHubImportResult>
  syncProjectContext: (
    request: Omit<GitHubContextSyncRequest, 'platform'>
  ) => Promise<GitHubContextSyncResult>
  renameProject: (projectId: string, name: string | null) => Promise<void>
  renameSession: (sessionId: string, title: string | null) => Promise<void>
  deleteProject: (projectId: string) => Promise<{ trashed: number }>
  deleteSession: (sessionId: string) => Promise<{ trashed: number }>
}

export type SessionHistoryState = {
  history: AssistantSessionHistory | null
  loading: boolean
  error: string | null
}

export function useProjectSessionBrowserState({
  platform,
  selectedProjectId,
  selectedSessionId,
  onSelectedProjectIdChange,
  onSelectedSessionIdChange
}: UseProjectSessionBrowserStateArgs): ProjectSessionBrowserState {
  const {
    sessions: rawSessions,
    loading,
    error,
    titleGenerationStatus,
    refresh: refreshSessions
  } = usePlatformSessions(platform)
  const { workspaces, refresh: refreshWorkspaces } = useWorkspaces()
  const { metadata, refresh: refreshMetadata } = useSessionMetadata()
  const [query, setQuery] = useState('')

  // Overlay user-set aliases on top of the inferred names. Done once here so the
  // alias flows through the project grouping, session list, detail drawer and
  // history header uniformly.
  const sessions = useMemo(
    () => rawSessions.map((session) => applySessionAlias(session, metadata.sessionAliases)),
    [rawSessions, metadata.sessionAliases]
  )

  const projects = useMemo(
    () =>
      mergeWorkspaceProjects(
        platform,
        groupSessionsByProject(platform, sessions, metadata.projectAliases),
        workspaces,
        metadata.projectAliases
      ),
    [platform, sessions, workspaces, metadata.projectAliases]
  )
  const filteredProjects = useMemo(() => filterProjects(projects, query), [projects, query])

  // Remember the last project we actually resolved for the current selection. A
  // refresh briefly returns a partial list (the fast Windows-only scan drops WSL
  // projects until the full scan pushes them back), and a search query can filter
  // the selection out of view. Holding the last-known project through those gaps
  // stops the UI from yanking the user onto a different project.
  const lastResolvedProjectRef = useRef<ProjectSessionGroup | null>(null)
  const selectedProject = useMemo(() => {
    if (selectedProjectId == null) {
      const fallback = filteredProjects[0] ?? null
      lastResolvedProjectRef.current = fallback
      return fallback
    }
    const match =
      filteredProjects.find((project) => project.id === selectedProjectId) ??
      projects.find((project) => project.id === selectedProjectId)
    if (match) {
      lastResolvedProjectRef.current = match
      return match
    }
    // The selection isn't in this (possibly partial) list. If we've resolved it
    // before, keep showing it — the scan will include it again once it settles.
    // Only a never-resolved id (e.g. a stale persisted selection) falls back to
    // the first project for display.
    if (lastResolvedProjectRef.current?.id === selectedProjectId) return lastResolvedProjectRef.current
    return filteredProjects[0] ?? null
  }, [filteredProjects, projects, selectedProjectId])
  const projectSessions = selectedProject?.sessions ?? []
  const selectedSession = useMemo(
    () =>
      isPendingSessionId(selectedSessionId)
        ? null
        : projectSessions.find((session) => session.id === selectedSessionId) ?? projectSessions[0] ?? null,
    [projectSessions, selectedSessionId]
  )

  useEffect(() => {
    if (loading) return
    if (selectedProjectId == null) {
      // Nothing chosen yet — default to the first available project.
      const nextProjectId = filteredProjects[0]?.id ?? null
      if (nextProjectId !== selectedProjectId) onSelectedProjectIdChange(nextProjectId)
      return
    }
    // Keep an explicit selection as long as it exists now or has resolved before,
    // so a partial refresh (the Windows-only fast scan) or a search filter never
    // silently reassigns the user to another project.
    const knownNow = projects.some((project) => project.id === selectedProjectId)
    const knownBefore = lastResolvedProjectRef.current?.id === selectedProjectId
    if (knownNow || knownBefore) return
    // A truly unknown id (e.g. a stale persisted selection for a deleted project):
    // fall back to a sensible default so the UI isn't stuck on nothing.
    const nextProjectId = filteredProjects[0]?.id ?? null
    if (nextProjectId !== selectedProjectId) onSelectedProjectIdChange(nextProjectId)
  }, [loading, onSelectedProjectIdChange, filteredProjects, projects, selectedProjectId])

  useEffect(() => {
    if (loading) return
    // A fresh session holds its empty selection until the user picks a real one.
    if (isPendingSessionId(selectedSessionId)) return
    const nextSessionId = selectedSession?.id ?? null
    if (selectedSessionId !== nextSessionId) onSelectedSessionIdChange(nextSessionId)
  }, [loading, onSelectedSessionIdChange, selectedSession, selectedSessionId])

  const selectProject = useCallback(
    (projectId: string) => {
      const project = projects.find((item) => item.id === projectId) ?? null
      onSelectedProjectIdChange(project?.id ?? null)
      onSelectedSessionIdChange(project?.sessions[0]?.id ?? null)
    },
    [onSelectedProjectIdChange, onSelectedSessionIdChange, projects]
  )

  const selectSession = useCallback(
    (sessionId: string) => onSelectedSessionIdChange(sessionId),
    [onSelectedSessionIdChange]
  )

  const attachWorkspace = useCallback(async () => {
    const workspace = await window.dashboard?.workspaces?.attach()
    if (!workspace) return
    await refreshWorkspaces()
    onSelectedProjectIdChange(`${platform}:${workspaceProjectKey(workspace.path)}`)
    onSelectedSessionIdChange(null)
  }, [onSelectedProjectIdChange, onSelectedSessionIdChange, platform, refreshWorkspaces])

  const chooseGithubImportDirectory = useCallback(async (): Promise<string | null> => {
    return (await window.dashboard?.github?.chooseImportDirectory?.()) ?? null
  }, [])

  const getGitHubAuthStatus = useCallback(async (): Promise<GitHubAuthStatus | null> => {
    return (await window.dashboard?.github?.getAuthStatus?.()) ?? null
  }, [])

  const startGitHubDeviceFlow = useCallback(
    async (clientId?: string | null): Promise<GitHubDeviceFlowStartResult> => {
      const start = window.dashboard?.github?.startDeviceFlow
      if (!start) return { ok: false, error: 'GitHub auth API unavailable' }
      return start(clientId)
    },
    []
  )

  const pollGitHubDeviceFlow = useCallback(async (): Promise<GitHubDeviceFlowPollResult> => {
    const poll = window.dashboard?.github?.pollDeviceFlow
    if (!poll) return { status: 'error', error: 'GitHub auth API unavailable' }
    return poll()
  }, [])

  const openGitHubDevicePage = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    const open = window.dashboard?.github?.openDevicePage
    if (!open) return { ok: false, error: 'GitHub auth API unavailable' }
    return open()
  }, [])

  const signOutGitHub = useCallback(async (): Promise<GitHubAuthStatus | null> => {
    return (await window.dashboard?.github?.signOut?.()) ?? null
  }, [])

  const listGitHubRepositories = useCallback(async (page?: number): Promise<GitHubRepositoryListResult> => {
    const list = window.dashboard?.github?.listRepositories
    if (!list) return { ok: false, error: 'GitHub repository API unavailable' }
    return list(page)
  }, [])

  const importGithubProject = useCallback(
    async (request: Omit<GitHubImportRequest, 'platform'>): Promise<GitHubImportResult> => {
      const importer = window.dashboard?.github?.importProject
      if (!importer) return { ok: false, error: 'GitHub import API unavailable' }
      const result = await importer({ ...request, platform })
      if (result.ok && result.workspace) {
        await Promise.all([refreshWorkspaces(), refreshSessions(), refreshMetadata()])
        onSelectedProjectIdChange(`${platform}:${workspaceProjectKey(result.workspace.path)}`)
        onSelectedSessionIdChange(null)
      }
      return result
    },
    [
      onSelectedProjectIdChange,
      onSelectedSessionIdChange,
      platform,
      refreshMetadata,
      refreshSessions,
      refreshWorkspaces
    ]
  )

  const syncProjectContext = useCallback(
    async (request: Omit<GitHubContextSyncRequest, 'platform'>): Promise<GitHubContextSyncResult> => {
      const sync = window.dashboard?.github?.syncProjectContext
      if (!sync) return { ok: false, error: 'Context vault API unavailable' }
      return sync({ ...request, platform })
    },
    [platform]
  )

  const renameProject = useCallback(
    async (projectId: string, name: string | null) => {
      await window.dashboard?.sessions?.setProjectAlias(projectId, name)
      await refreshMetadata()
    },
    [refreshMetadata]
  )

  const renameSession = useCallback(
    async (sessionId: string, title: string | null) => {
      await window.dashboard?.sessions?.setSessionAlias(platform, sessionId, title)
      await refreshMetadata()
    },
    [platform, refreshMetadata]
  )

  const deleteSession = useCallback(
    async (sessionId: string): Promise<{ trashed: number }> => {
      const result = (await window.dashboard?.sessions?.deleteSession(platform, sessionId)) ?? { trashed: 0 }
      // Only drop the selection if the session actually went away — a failed
      // (locked) delete keeps it selected so the user can retry.
      if (result.trashed > 0 && selectedSessionId === sessionId) onSelectedSessionIdChange(null)
      await Promise.all([refreshSessions(), refreshMetadata()])
      return result
    },
    [onSelectedSessionIdChange, platform, refreshMetadata, refreshSessions, selectedSessionId]
  )

  const deleteProject = useCallback(
    async (projectId: string): Promise<{ trashed: number }> => {
      const result = (await window.dashboard?.sessions?.deleteProject(platform, projectId)) ?? { trashed: 0 }
      // An attached-but-empty project trashes 0 files yet is still removed
      // (detached), so success = trashed something OR it had no sessions.
      const wasEmpty = (projects.find((project) => project.id === projectId)?.sessionCount ?? 0) === 0
      if ((result.trashed > 0 || wasEmpty) && selectedProjectId === projectId) {
        onSelectedProjectIdChange(null)
        onSelectedSessionIdChange(null)
      }
      await Promise.all([refreshSessions(), refreshWorkspaces(), refreshMetadata()])
      return result
    },
    [
      onSelectedProjectIdChange,
      onSelectedSessionIdChange,
      platform,
      projects,
      refreshMetadata,
      refreshSessions,
      refreshWorkspaces,
      selectedProjectId
    ]
  )

  return useMemo(
    () => ({
      platform,
      sessions,
      projects,
      filteredProjects,
      selectedProject,
      selectedSession,
      selectedProjectId,
      selectedSessionId,
      projectSessions,
      loading,
      error,
      titleGenerationStatus,
      query,
      setQuery,
      selectProject,
      selectSession,
      refreshSessions,
      attachWorkspace,
      getGitHubAuthStatus,
      startGitHubDeviceFlow,
      pollGitHubDeviceFlow,
      openGitHubDevicePage,
      signOutGitHub,
      listGitHubRepositories,
      chooseGithubImportDirectory,
      importGithubProject,
      syncProjectContext,
      renameProject,
      renameSession,
      deleteProject,
      deleteSession
    }),
    [
      platform,
      sessions,
      projects,
      filteredProjects,
      selectedProject,
      selectedSession,
      selectedProjectId,
      selectedSessionId,
      projectSessions,
      loading,
      error,
      titleGenerationStatus,
      query,
      setQuery,
      selectProject,
      selectSession,
      refreshSessions,
      attachWorkspace,
      getGitHubAuthStatus,
      startGitHubDeviceFlow,
      pollGitHubDeviceFlow,
      openGitHubDevicePage,
      signOutGitHub,
      listGitHubRepositories,
      chooseGithubImportDirectory,
      importGithubProject,
      syncProjectContext,
      renameProject,
      renameSession,
      deleteProject,
      deleteSession
    ]
  )
}

function useWorkspaces(): { workspaces: Workspace[]; refresh: () => Promise<void> } {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])

  const refresh = useCallback(async () => {
    const list = window.dashboard?.workspaces?.list
    if (!list) return
    try {
      setWorkspaces(await list())
    } catch {
      setWorkspaces([])
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { workspaces, refresh }
}

function useSessionMetadata(): { metadata: SessionMetadata; refresh: () => Promise<void> } {
  const [metadata, setMetadata] = useState<SessionMetadata>(() => emptyMetadata())

  const refresh = useCallback(async () => {
    const load = window.dashboard?.sessions?.getMetadata
    if (!load) return
    try {
      setMetadata(await load())
    } catch {
      setMetadata(emptyMetadata())
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { metadata, refresh }
}

export function useSessionHistory(session: AssistantSession | null): SessionHistoryState {
  const [history, setHistory] = useState<AssistantSessionHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Depend on the session's identity + last-updated time, not its object
  // reference. The session list re-polls every minute and hands back freshly
  // built session objects, so the selection changes reference without changing
  // identity — keying the reload on identity stops a needless re-fetch (and its
  // placeholder flash) on every poll, while still refreshing when the session
  // genuinely gains new activity (updatedAt advances).
  const platform = session?.platform ?? null
  const sessionId = session?.id ?? null
  const updatedAt = session?.updatedAt ?? null

  useEffect(() => {
    if (!platform || !sessionId) {
      setHistory(null)
      setLoading(false)
      setError(null)
      return
    }

    const loader = window.dashboard?.sessions?.getSessionHistory
    if (!loader) {
      setHistory(null)
      setLoading(false)
      setError('History API unavailable')
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    loader(platform, sessionId)
      .then((nextHistory) => {
        if (cancelled) return
        setHistory(nextHistory)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setHistory(null)
        setError(err instanceof Error ? err.message : 'Session history failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [platform, sessionId, updatedAt])

  return { history, loading, error }
}

// Cache each platform's last-known sessions at module scope so switching platforms
// — which unmounts and remounts the workspace — shows the previous list instantly
// instead of flashing an empty "loading" state. A background poll still refreshes
// the data after mount (stale-while-revalidate).
const sessionsCache = new Map<PlatformId, AssistantSession[]>()
const prewarmInFlight = new Set<PlatformId>()

function getSessionsLoader(platform: PlatformId): (() => Promise<AssistantSession[]>) | undefined {
  return platform === 'claude'
    ? window.dashboard?.sessions?.getClaudeSessions
    : window.dashboard?.sessions?.getCodexSessions
}

// Fetch the inactive platform's sessions once in the background to prime its cache,
// so the very first switch to it is instant too. Best-effort: failures are ignored
// and the normal per-mount fetch still runs.
function prewarmOtherPlatform(current: PlatformId): void {
  const other: PlatformId = current === 'claude' ? 'codex' : 'claude'
  if (sessionsCache.has(other) || prewarmInFlight.has(other)) return
  const loader = getSessionsLoader(other)
  if (!loader) return
  prewarmInFlight.add(other)
  loader()
    .then((list) => {
      sessionsCache.set(other, list)
    })
    .catch(() => {})
    .finally(() => {
      prewarmInFlight.delete(other)
    })
}

function usePlatformSessions(platform: PlatformId): {
  sessions: AssistantSession[]
  loading: boolean
  error: string | null
  titleGenerationStatus: SessionTitleGenerationStatus | null
  refresh: () => Promise<void>
} {
  const cachedSessions = sessionsCache.get(platform)
  const [sessions, setSessions] = useState<AssistantSession[]>(cachedSessions ?? [])
  // Only start in a loading state when there is nothing cached to show.
  const [loading, setLoading] = useState(cachedSessions === undefined)
  const [error, setError] = useState<string | null>(null)
  const [titleGenerationStatus, setTitleGenerationStatus] = useState<SessionTitleGenerationStatus | null>(null)

  const fetchSessions = useCallback(async () => {
    const loader = getSessionsLoader(platform)

    if (!loader) {
      setError('Session API unavailable')
      setLoading(false)
      return
    }

    try {
      const next = await loader()
      sessionsCache.set(platform, next)
      setSessions(next)
      setTitleGenerationStatus((await window.dashboard?.sessions?.getTitleGenerationStatus?.()) ?? null)
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Session scan failed')
    } finally {
      setLoading(false)
    }
  }, [platform])

  useEffect(() => {
    // Refresh quietly when we already have cached sessions, so switching platforms
    // doesn't flash a loading state; only show loading on a true cold start.
    if (sessionsCache.get(platform) === undefined) setLoading(true)
    fetchSessions()
    prewarmOtherPlatform(platform)
    const id = setInterval(fetchSessions, SESSION_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchSessions, platform])

  // The main process returns a fast Windows-only list first, then pushes the
  // complete set (including slow WSL origins) once its background scan finishes.
  // Apply pushes for this platform only; the title-generation status refreshes on
  // the next poll.
  useEffect(() => {
    const subscribe = window.dashboard?.sessions?.onSessionsUpdated
    if (!subscribe) return
    return subscribe((payload) => {
      if (payload.platform !== platform) return
      sessionsCache.set(platform, payload.sessions)
      setSessions(payload.sessions)
      setLoading(false)
    })
  }, [platform])

  return { sessions, loading, error, titleGenerationStatus, refresh: fetchSessions }
}

function groupSessionsByProject(
  platform: PlatformId,
  sessions: AssistantSession[],
  projectAliases: Record<string, string>
): ProjectSessionGroup[] {
  const byProject = new Map<string, ProjectSessionGroup>()

  for (const session of sessions) {
    const existing = byProject.get(session.projectId)
    if (existing) {
      existing.sessions.push(session)
      existing.sessionCount += 1
      if (Date.parse(session.updatedAt ?? '0') > Date.parse(existing.latestUpdatedAt ?? '0')) {
        existing.latestUpdatedAt = session.updatedAt
        existing.age = session.age
        existing.branch = session.branch ?? existing.branch
      }
      continue
    }

    byProject.set(session.projectId, {
      id: session.projectId,
      platform,
      name: applyProjectAlias(projectLabel(session), session.projectId, projectAliases),
      path: session.projectPath,
      branch: session.branch,
      origin: session.origin,
      sessionCount: 1,
      latestUpdatedAt: session.updatedAt,
      age: session.age,
      sessions: [session]
    })
  }

  return [...byProject.values()]
    .map((project) => ({
      ...project,
      sessions: project.sessions.sort((a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'))
    }))
    .sort((a, b) => Date.parse(b.latestUpdatedAt ?? '0') - Date.parse(a.latestUpdatedAt ?? '0'))
}

// Mirror of session-service.projectId normalization, usable in the renderer where
// node's path.resolve is unavailable. Stored workspace paths are already resolved
// in the main process, so lowercasing is enough to match a session-backed project.
function workspaceProjectKey(path: string): string {
  return path.toLowerCase()
}

// Surface attached workspaces as projects so a freshly created/attached folder
// appears immediately, even before it has any session history. A workspace whose
// folder already has sessions reuses that existing project entry instead.
function mergeWorkspaceProjects(
  platform: PlatformId,
  projects: ProjectSessionGroup[],
  workspaces: Workspace[],
  projectAliases: Record<string, string>
): ProjectSessionGroup[] {
  const existing = new Set(projects.map((project) => project.id))
  const extras: ProjectSessionGroup[] = []

  for (const workspace of workspaces) {
    const id = `${platform}:${workspaceProjectKey(workspace.path)}`
    if (existing.has(id)) continue
    existing.add(id)
    extras.push({
      id,
      platform,
      name: applyProjectAlias(workspace.name, id, projectAliases),
      path: workspace.path,
      branch: null,
      origin: WINDOWS_ORIGIN,
      sessionCount: 0,
      latestUpdatedAt: new Date(workspace.addedAtMs).toISOString(),
      age: 'attached',
      sessions: []
    })
  }

  return [...extras, ...projects].sort(
    (a, b) => Date.parse(b.latestUpdatedAt ?? '0') - Date.parse(a.latestUpdatedAt ?? '0')
  )
}

function filterProjects(projects: ProjectSessionGroup[], query: string): ProjectSessionGroup[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return projects

  return projects.filter((project) => {
    const projectFields = [project.name, project.path, project.branch]
    const sessionFields = project.sessions.flatMap((session) => [
      session.title,
      session.rawTitle,
      session.inferredTitle,
      session.branch
    ])

    return [...projectFields, ...sessionFields].some((value) => value?.toLowerCase().includes(needle))
  })
}

export function projectLabel(session: AssistantSession): string {
  if (session.project) return session.project
  return session.platform === 'codex' ? 'Unindexed' : 'Unavailable'
}
