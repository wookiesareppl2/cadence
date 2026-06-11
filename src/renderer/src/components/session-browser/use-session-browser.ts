import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { PlatformId } from '@shared/platform'
import type {
  AssistantProject,
  AssistantSession,
  AssistantSessionHistory
} from '@shared/sessions'
import type { Workspace } from '@shared/workspaces'
import type { SessionMetadata } from '@shared/session-metadata'
import { applyProjectAlias, applySessionAlias, emptyMetadata } from '@shared/session-metadata'

const SESSION_POLL_INTERVAL_MS = 60_000

// Sentinel selection for a freshly started session: nothing exists on disk yet,
// so the History panel is intentionally empty and no list row is highlighted
// until the user's first prompt creates a real transcript the poll can pick up.
export const NEW_SESSION_ID = '__new__'

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
  query: string
  setQuery: Dispatch<SetStateAction<string>>
  selectProject: (projectId: string) => void
  selectSession: (sessionId: string) => void
  attachWorkspace: () => Promise<void>
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
  const { sessions: rawSessions, loading, error, refresh: refreshSessions } = usePlatformSessions(platform)
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
  const selectedProject = useMemo(
    () => filteredProjects.find((project) => project.id === selectedProjectId) ?? filteredProjects[0] ?? null,
    [filteredProjects, selectedProjectId]
  )
  const projectSessions = selectedProject?.sessions ?? []
  const selectedSession = useMemo(
    () =>
      selectedSessionId === NEW_SESSION_ID
        ? null
        : projectSessions.find((session) => session.id === selectedSessionId) ?? projectSessions[0] ?? null,
    [projectSessions, selectedSessionId]
  )

  useEffect(() => {
    if (loading) return
    const nextProjectId = selectedProject?.id ?? null
    if (selectedProjectId !== nextProjectId) onSelectedProjectIdChange(nextProjectId)
  }, [loading, onSelectedProjectIdChange, selectedProject, selectedProjectId])

  useEffect(() => {
    if (loading) return
    // A fresh session holds its empty selection until the user picks a real one.
    if (selectedSessionId === NEW_SESSION_ID) return
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
      query,
      setQuery,
      selectProject,
      selectSession,
      attachWorkspace,
      renameProject,
      renameSession,
      deleteProject,
      deleteSession
    }),
    [
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
      query,
      setQuery,
      selectProject,
      selectSession,
      attachWorkspace,
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

function usePlatformSessions(platform: PlatformId): {
  sessions: AssistantSession[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [sessions, setSessions] = useState<AssistantSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = useCallback(async () => {
    const loader =
      platform === 'claude'
        ? window.dashboard?.sessions?.getClaudeSessions
        : window.dashboard?.sessions?.getCodexSessions

    if (!loader) {
      setError('Session API unavailable')
      setLoading(false)
      return
    }

    try {
      setSessions(await loader())
      setError(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Session scan failed')
    } finally {
      setLoading(false)
    }
  }, [platform])

  useEffect(() => {
    setLoading(true)
    fetchSessions()
    const id = setInterval(fetchSessions, SESSION_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchSessions])

  return { sessions, loading, error, refresh: fetchSessions }
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
