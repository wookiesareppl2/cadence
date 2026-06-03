import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, JSX, SetStateAction } from 'react'
import type { PlatformId } from '@shared/platform'
import type { AssistantProject, AssistantSession, AssistantSessionHistory } from '@shared/sessions'
import type { Workspace } from '@shared/workspaces'
import './session-browser.css'

const SESSION_POLL_INTERVAL_MS = 60_000

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
  const { sessions, loading, error } = usePlatformSessions(platform)
  const { workspaces, refresh: refreshWorkspaces } = useWorkspaces()
  const [query, setQuery] = useState('')

  const projects = useMemo(
    () => mergeWorkspaceProjects(platform, groupSessionsByProject(platform, sessions), workspaces),
    [platform, sessions, workspaces]
  )
  const filteredProjects = useMemo(() => filterProjects(projects, query), [projects, query])
  const selectedProject = useMemo(
    () => filteredProjects.find((project) => project.id === selectedProjectId) ?? filteredProjects[0] ?? null,
    [filteredProjects, selectedProjectId]
  )
  const projectSessions = selectedProject?.sessions ?? []
  const selectedSession = useMemo(
    () => projectSessions.find((session) => session.id === selectedSessionId) ?? projectSessions[0] ?? null,
    [projectSessions, selectedSessionId]
  )

  useEffect(() => {
    if (loading) return
    const nextProjectId = selectedProject?.id ?? null
    if (selectedProjectId !== nextProjectId) onSelectedProjectIdChange(nextProjectId)
  }, [loading, onSelectedProjectIdChange, selectedProject, selectedProjectId])

  useEffect(() => {
    if (loading) return
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

  return {
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
    attachWorkspace
  }
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

export function useSessionHistory(session: AssistantSession | null): SessionHistoryState {
  const [history, setHistory] = useState<AssistantSessionHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) {
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

    loader(session.platform, session.id)
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
  }, [session])

  return { history, loading, error }
}

export function ProjectSessionSidebar({
  title,
  ariaLabel,
  emptyLabel,
  browser,
  onStartSession
}: {
  title: string
  ariaLabel: string
  emptyLabel: string
  browser: ProjectSessionBrowserState
  onStartSession: (project: ProjectSessionGroup) => void
}): JSX.Element {
  const projectEmptyMessage =
    browser.projects.length > 0 && browser.filteredProjects.length === 0 ? 'No matching projects' : emptyLabel
  const selectedProject = browser.selectedProject
  const canStartSession = Boolean(selectedProject?.path)

  return (
    <aside className="sidebar project-sidebar" aria-label={ariaLabel}>
      <div className="sidebar-header">
        <h2>{title}</h2>
        <button
          type="button"
          className="sidebar-action"
          onClick={() => browser.attachWorkspace()}
          title="Attach an existing folder or create a new project workspace"
        >
          + New Project
        </button>
      </div>
      <input
        className="sidebar-search"
        placeholder="Search projects"
        aria-label={`Search ${ariaLabel}`}
        value={browser.query}
        onChange={(event) => browser.setQuery(event.target.value)}
      />
      <div className="project-list" aria-label={`${ariaLabel} projects`}>
        <ProjectList
          projects={browser.filteredProjects}
          loading={browser.loading}
          error={browser.error}
          emptyLabel={projectEmptyMessage}
          selectedProjectId={selectedProject?.id ?? null}
          onSelectProject={browser.selectProject}
        />
      </div>
      <div className="session-stack">
        <div className="session-stack-header">
          <span>Sessions</span>
          <button
            type="button"
            className="session-start-action"
            disabled={!canStartSession}
            title={
              canStartSession
                ? `Start a new terminal session in ${selectedProject?.path}`
                : 'Select a project with a folder to start a session'
            }
            onClick={() => selectedProject && onStartSession(selectedProject)}
          >
            + New Session
          </button>
        </div>
        <div className="session-list compact" aria-label={`${ariaLabel} sessions`}>
          <SessionList
            sessions={browser.projectSessions}
            loading={browser.loading}
            error={browser.error}
            emptyLabel={selectedProject ? 'No sessions yet — start one' : 'Select a project'}
            selectedSessionId={browser.selectedSession?.id ?? null}
            onSelectSession={browser.selectSession}
          />
        </div>
      </div>
    </aside>
  )
}

export function SessionDetailDrawer({
  session,
  emptyLabel,
  open,
  onToggle
}: {
  session: AssistantSession | null
  emptyLabel: string
  open: boolean
  onToggle: () => void
}): JSX.Element {
  if (!open) {
    return (
      <button
        type="button"
        className="session-detail-toggle"
        aria-label="Show session details"
        aria-expanded={false}
        onClick={onToggle}
        title="Show session details"
      >
        ‹
      </button>
    )
  }

  return (
    <section className="panel session-detail-panel" aria-label="Session details">
      <div className="panel-header session-detail-header">
        <h2>Session Detail</h2>
        <div className="session-detail-actions">
          {session ? <span className="status-pill">Updated {session.age}</span> : null}
          <button
            type="button"
            className="session-detail-toggle inline"
            aria-label="Hide session details"
            aria-expanded={true}
            onClick={onToggle}
            title="Hide session details"
          >
            ›
          </button>
        </div>
      </div>
      {!session ? (
        <div className="session-detail-empty">{emptyLabel}</div>
      ) : (
        <div className="session-detail-body">
          <div className="session-detail-summary">
            <h3>{session.title}</h3>
            {session.project && session.project !== session.title ? <p>{session.project}</p> : null}
          </div>
          <dl className="fact-list session-facts">
            <Fact label="Project" value={projectLabel(session)} />
            <Fact label="Path" value={session.projectPath ?? 'Unavailable'} />
            <Fact label="Branch" value={branchLabel(session)} />
            <Fact label="Updated" value={formatUpdatedAt(session.updatedAt)} />
            {session.rawTitle && session.rawTitle !== session.title ? (
              <Fact label="Source" value={session.rawTitle} />
            ) : null}
          </dl>
        </div>
      )}
    </section>
  )
}

export function SessionHistoryPanel({
  session,
  historyState
}: {
  session: AssistantSession | null
  historyState: SessionHistoryState
}): JSX.Element {
  const { history, loading, error } = historyState
  const entryCount = history?.entries.length ?? 0

  return (
    <section className="panel history-panel" aria-label="Session history">
      <div className="panel-header history-header">
        <div className="history-heading">
          <h2>History</h2>
          <span>{session ? session.title : 'No session selected'}</span>
        </div>
        {session ? <span className="status-pill">{loading ? 'loading' : `${entryCount} entries`}</span> : null}
      </div>
      {!session ? (
        <div className="history-placeholder">Select a project session to load its transcript.</div>
      ) : error ? (
        <div className="history-placeholder error">{error}</div>
      ) : loading ? (
        <div className="history-placeholder">Loading transcript...</div>
      ) : !history || history.entries.length === 0 ? (
        <div className="history-placeholder">No readable transcript entries found.</div>
      ) : (
        <div className="history-feed">
          {history.entries.map((entry) => (
            <article key={entry.id} className="history-entry" data-role={entry.role}>
              <div className="history-entry-meta">
                <span>{entry.label}</span>
                {entry.timestamp ? <time>{formatEntryTimestamp(entry.timestamp)}</time> : null}
              </div>
              <pre>{entry.text}</pre>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function usePlatformSessions(platform: PlatformId): {
  sessions: AssistantSession[]
  loading: boolean
  error: string | null
} {
  const [sessions, setSessions] = useState<AssistantSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSessions = useCallback(() => {
    const loader =
      platform === 'claude'
        ? window.dashboard?.sessions?.getClaudeSessions
        : window.dashboard?.sessions?.getCodexSessions

    if (!loader) {
      setError('Session API unavailable')
      setLoading(false)
      return
    }

    loader()
      .then((nextSessions) => {
        setSessions(nextSessions)
        setError(null)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Session scan failed'))
      .finally(() => setLoading(false))
  }, [platform])

  useEffect(() => {
    setLoading(true)
    fetchSessions()
    const id = setInterval(fetchSessions, SESSION_POLL_INTERVAL_MS)
    return () => clearInterval(id)
  }, [fetchSessions])

  return { sessions, loading, error }
}

function ProjectList({
  projects,
  loading,
  error,
  emptyLabel,
  selectedProjectId,
  onSelectProject
}: {
  projects: ProjectSessionGroup[]
  loading: boolean
  error: string | null
  emptyLabel: string
  selectedProjectId: string | null
  onSelectProject: (projectId: string) => void
}): JSX.Element {
  if (loading) return <div className="session-placeholder">Scanning projects...</div>
  if (error) return <div className="session-placeholder error">{error}</div>
  if (projects.length === 0) return <div className="session-placeholder">{emptyLabel}</div>

  return (
    <>
      {projects.map((project) => {
        const isActive = project.id === selectedProjectId
        return (
          <button
            key={project.id}
            type="button"
            className={`project-item ${isActive ? 'active' : ''}`}
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onSelectProject(project.id)}
          >
            <span className="project-title">{project.name}</span>
            {project.path ? <span className="project-path">{project.path}</span> : null}
            <span className="project-meta">
              <span>{project.sessionCount === 0 ? 'No sessions yet' : `${project.sessionCount} sessions`}</span>
              <span>{project.sessionCount === 0 ? 'Attached' : `Updated ${project.age}`}</span>
            </span>
          </button>
        )
      })}
    </>
  )
}

function SessionList({
  sessions,
  loading,
  error,
  emptyLabel,
  selectedSessionId,
  onSelectSession
}: {
  sessions: AssistantSession[]
  loading: boolean
  error: string | null
  emptyLabel: string
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
}): JSX.Element {
  if (loading) return <div className="session-placeholder">Scanning sessions...</div>
  if (error) return <div className="session-placeholder error">{error}</div>
  if (sessions.length === 0) return <div className="session-placeholder">{emptyLabel}</div>

  return (
    <>
      {sessions.map((session) => {
        const isActive = session.id === selectedSessionId
        return (
          <button
            key={`${session.platform}:${session.id}`}
            type="button"
            className={`session-item ${isActive ? 'active' : ''}`}
            aria-current={isActive ? 'true' : undefined}
            onClick={() => onSelectSession(session.id)}
          >
            <span className="session-title">{session.title}</span>
            <span className="session-meta">
              <span>{formatShortDate(session.updatedAt)}</span>
              {session.branch && session.branch !== 'HEAD' ? <span>{session.branch}</span> : null}
            </span>
          </button>
        )
      })}
    </>
  )
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
  )
}

function groupSessionsByProject(platform: PlatformId, sessions: AssistantSession[]): ProjectSessionGroup[] {
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
      name: projectLabel(session),
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
  workspaces: Workspace[]
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
      name: workspace.name,
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

function projectLabel(session: AssistantSession): string {
  if (session.project) return session.project
  return session.platform === 'codex' ? 'Unindexed' : 'Unavailable'
}

function branchLabel(session: AssistantSession): string {
  if (!session.branch || session.branch === 'HEAD') return 'Unavailable'
  return session.branch
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unavailable'

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatShortDate(value: string | null): string {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

function formatEntryTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}
