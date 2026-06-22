import { memo, useMemo } from 'react'
import type { JSX } from 'react'
import type {
  AssistantSession,
  AssistantSessionHistoryEntry
} from '@shared/sessions'
import { HistoryMarkdown } from '../history-markdown'
import { ProjectList, SessionList } from './session-rows'
import {
  isPendingSessionId,
  projectLabel,
  type ProjectSessionBrowserState,
  type ProjectSessionGroup,
  type SessionHistoryState
} from './use-session-browser'
import './session-browser.css'

// Only tool rows carry detail beyond the rail badge (which tool ran). User,
// assistant, and context rows are fully identified by the rail, so showing a
// speaker label there would just duplicate it.
function historySpeakerLabel(entry: AssistantSessionHistoryEntry): string | null {
  if (entry.role !== 'tool') return null
  return entry.label || 'Tool'
}

function historyRoleCode(role: AssistantSessionHistoryEntry['role']): string {
  if (role === 'user') return 'YOU'
  if (role === 'assistant') return 'AGT'
  if (role === 'tool') return 'RUN'
  return 'CTX'
}

export const ProjectSessionSidebar = memo(function ProjectSessionSidebar({
  title,
  ariaLabel,
  emptyLabel,
  browser,
  pendingSessions,
  onStartSession,
  onAbandonPendingSession,
  onRenamePendingSession
}: {
  title: string
  ariaLabel: string
  emptyLabel: string
  browser: ProjectSessionBrowserState
  // Started-but-unsaved sessions, shown as rows immediately so a freshly started
  // session is reselectable before its transcript exists.
  pendingSessions: AssistantSession[]
  onStartSession: (project: ProjectSessionGroup) => void
  onAbandonPendingSession: (id: string) => Promise<{ trashed: number }>
  onRenamePendingSession: (id: string, title: string | null) => Promise<void>
}): JSX.Element {
  const projectEmptyMessage =
    browser.projects.length > 0 && browser.filteredProjects.length === 0 ? 'No matching projects' : emptyLabel
  const selectedProject = browser.selectedProject
  const canStartSession = Boolean(selectedProject?.path)

  // Pending sessions for the open project sit on top of its real sessions. The
  // highlight follows the resolved real session, or the raw id when the selection
  // is a pending session (which intentionally resolves to no transcript).
  const pendingForProject = pendingSessions.filter((session) => session.projectId === selectedProject?.id)
  const sessionRows = [...pendingForProject, ...browser.projectSessions]
  const highlightSessionId =
    browser.selectedSession?.id ?? (isPendingSessionId(browser.selectedSessionId) ? browser.selectedSessionId : null)

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
          onRenameProject={browser.renameProject}
          onDeleteProject={browser.deleteProject}
        />
      </div>
      <div className="session-stack">
        <div className="session-stack-header">
          <span className="session-stack-title">
            Sessions
            <TitleGenerationStatus browser={browser} />
          </span>
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
            sessions={sessionRows}
            loading={browser.loading}
            error={browser.error}
            emptyLabel={selectedProject ? 'No sessions yet — start one' : 'Select a project'}
            selectedSessionId={highlightSessionId}
            onSelectSession={browser.selectSession}
            onRenameSession={(id, titleValue) =>
              isPendingSessionId(id) ? onRenamePendingSession(id, titleValue) : browser.renameSession(id, titleValue)
            }
            onDeleteSession={(id) =>
              isPendingSessionId(id) ? onAbandonPendingSession(id) : browser.deleteSession(id)
            }
          />
        </div>
      </div>
    </aside>
  )
})

function TitleGenerationStatus({ browser }: { browser: ProjectSessionBrowserState }): JSX.Element | null {
  const status = browser.titleGenerationStatus
  if (!status) return null
  if (status.running || status.pending > 0) {
    return (
      <span
        className="title-generation-dot updating"
        role="status"
        aria-label="Updating titles"
        title="Updating titles"
      />
    )
  }
  if (status.lastError) {
    return (
      <span
        className="title-generation-dot error"
        role="status"
        aria-label={`Title update failed: ${status.lastError}`}
        title={`Title update failed: ${status.lastError}`}
      />
    )
  }
  return null
}

export const SessionDetailAccordion = memo(function SessionDetailAccordion({
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
  return (
    <section
      className={`panel session-detail-accordion ${open ? 'expanded' : 'collapsed'}`}
      aria-label="Session details"
    >
      <div className="panel-header session-detail-header" onClick={onToggle}>
        <div className="session-detail-heading">
          <h2>Session Detail</h2>
          {open ? <span>{session ? session.title : emptyLabel}</span> : null}
        </div>
        <button
          type="button"
          className="panel-collapse-toggle"
          aria-label={open ? 'Collapse session details' : 'Expand session details'}
          aria-expanded={open}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          title={open ? 'Collapse session details' : 'Expand session details'}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>
      <div className="session-detail-content" aria-hidden={!open}>
        <div className="session-detail-content-inner">
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
                <Fact label="Title" value={titleSourceLabel(session)} />
                {session.rawTitle && session.rawTitle !== session.title ? (
                  <Fact label="Source" value={session.rawTitle} />
                ) : null}
              </dl>
            </div>
          )}
        </div>
      </div>
    </section>
  )
})

export function SessionHistorySidebar({
  session,
  historyState,
  newSession = false,
  open,
  onToggle
}: {
  session: AssistantSession | null
  historyState: SessionHistoryState
  newSession?: boolean
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const { history, loading, error } = historyState
  const entryCount = history?.entries.length ?? 0
  const historyEntries = useMemo(() => {
    if (!history || history.entries.length === 0) return null

    return [...history.entries].reverse().map((entry) => {
      const speaker = historySpeakerLabel(entry)

      return (
        <article key={entry.id} className="history-entry" data-role={entry.role}>
          <div className="history-entry-content">
            <div className="history-entry-meta">
              <span className="history-entry-marker">
                <span className="history-entry-tag">{historyRoleCode(entry.role)}</span>
                {entry.timestamp ? <time>{formatEntryTimestamp(entry.timestamp)}</time> : null}
              </span>
              {speaker ? <span className="history-entry-speaker">{speaker}</span> : null}
            </div>
            {entry.role === 'user' || entry.role === 'assistant' ? (
              <HistoryMarkdown text={entry.text} />
            ) : (
              <pre>{entry.text}</pre>
            )}
          </div>
        </article>
      )
    })
  }, [history])

  return (
    <aside className={`history-sidebar-shell ${open ? 'open' : 'closed'}`} aria-label="Session history">
      <button
        type="button"
        className="history-sidebar-toggle"
        aria-label="Show history"
        aria-expanded={open}
        onClick={onToggle}
        tabIndex={open ? -1 : 0}
        title="Show history"
      >
        <span className="history-sidebar-toggle-icon" aria-hidden="true">
          ◂
        </span>
        <span className="history-sidebar-toggle-label">History</span>
        <span className="history-sidebar-toggle-count">{loading && !history ? '...' : entryCount}</span>
      </button>
      <section className="panel history-panel history-sidebar-panel" aria-hidden={!open}>
      <div className="panel-header history-header">
        <div className="history-heading">
          <h2>History</h2>
          <span>{session ? session.title : newSession ? 'New session' : 'No session selected'}</span>
        </div>
        <div className="history-actions">
          {session ? (
            <span className="status-pill">{loading && !history ? 'loading' : `${entryCount} entries`}</span>
          ) : null}
          <button
            type="button"
            className="panel-collapse-toggle"
            aria-label="Hide history"
            aria-expanded={true}
            onClick={onToggle}
            tabIndex={open ? 0 : -1}
            title="Hide history"
          >
            ▸
          </button>
        </div>
      </div>
      {newSession && !session ? (
        <div className="history-placeholder">
          Fresh session — run your CLI in the terminal to begin. The transcript appears here, and the session joins the
          list, once your first prompt is recorded.
        </div>
      ) : !session ? (
        <div className="history-placeholder">Select a project session to load its transcript.</div>
      ) : error && !history ? (
        <div className="history-placeholder error">{error}</div>
      ) : loading && !history ? (
        <div className="history-placeholder">Loading transcript...</div>
      ) : !history || history.entries.length === 0 ? (
        <div className="history-placeholder">No readable transcript entries found.</div>
      ) : (
        <div className="history-feed">{historyEntries}</div>
      )}
    </section>
    </aside>
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

function branchLabel(session: AssistantSession): string {
  if (!session.branch || session.branch === 'HEAD') return 'Unavailable'
  return session.branch
}

function titleSourceLabel(session: AssistantSession): string {
  if (session.titleSource === 'manual') return 'Manual override'
  if (session.titleSource === 'generated') {
    if (session.titleStatus === 'stale') return 'AI generated, updating'
    if (session.titleStatus === 'failed') return 'AI generated, update failed'
    return 'AI generated'
  }
  if (session.titleStatus === 'pending') return 'Heuristic, AI pending'
  if (session.titleStatus === 'disabled') return 'Heuristic, AI disabled'
  if (session.titleSource === 'raw') return 'Provider title'
  return 'Heuristic'
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
