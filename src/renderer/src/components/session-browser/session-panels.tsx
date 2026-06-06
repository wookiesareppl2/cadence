import type { JSX } from 'react'
import type {
  AssistantSession,
  AssistantSessionHistoryEntry
} from '@shared/sessions'
import { HistoryMarkdown } from '../history-markdown'
import { ProjectList, SessionList } from './session-rows'
import {
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
          onRenameProject={browser.renameProject}
          onDeleteProject={browser.deleteProject}
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
            onRenameSession={browser.renameSession}
            onDeleteSession={browser.deleteSession}
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
  historyState,
  newSession = false
}: {
  session: AssistantSession | null
  historyState: SessionHistoryState
  newSession?: boolean
}): JSX.Element {
  const { history, loading, error } = historyState
  const entryCount = history?.entries.length ?? 0

  return (
    <section className="panel history-panel" aria-label="Session history">
      <div className="panel-header history-header">
        <div className="history-heading">
          <h2>History</h2>
          <span>{session ? session.title : newSession ? 'New session' : 'No session selected'}</span>
        </div>
        {session ? (
          <span className="status-pill">{loading && !history ? 'loading' : `${entryCount} entries`}</span>
        ) : null}
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
        <div className="history-feed">
          {[...history.entries].reverse().map((entry) => {
            const speaker = historySpeakerLabel(entry)
            const showMeta = Boolean(speaker || entry.timestamp)

            return (
              <article key={entry.id} className="history-entry" data-role={entry.role}>
                <div className="history-entry-rail" aria-hidden="true">
                  {historyRoleCode(entry.role)}
                </div>
                <div className="history-entry-content">
                  {showMeta ? (
                    <div className="history-entry-meta">
                      {speaker ? <span className="history-entry-speaker">{speaker}</span> : null}
                      {entry.timestamp ? <time>{formatEntryTimestamp(entry.timestamp)}</time> : null}
                    </div>
                  ) : null}
                  {entry.role === 'user' || entry.role === 'assistant' ? (
                    <HistoryMarkdown text={entry.text} />
                  ) : (
                    <pre>{entry.text}</pre>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
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
