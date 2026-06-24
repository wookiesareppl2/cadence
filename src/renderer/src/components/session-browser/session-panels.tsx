import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type {
  AssistantSession,
  AssistantSessionHistoryEntry
} from '@shared/sessions'
import { HistoryMarkdown } from '../history-markdown'
import { GitHubImportModal } from './github-import-modal'
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
  const [githubImportOpen, setGithubImportOpen] = useState(false)
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
    <>
      <aside className="sidebar project-sidebar" aria-label={ariaLabel}>
        <div className="sidebar-header">
          <h2>{title}</h2>
          <div className="sidebar-actions">
            <button
              type="button"
              className="sidebar-action"
              onClick={() => browser.attachWorkspace()}
              title="Attach an existing folder or create a new project workspace"
            >
              + New
            </button>
            <button
              type="button"
              className="sidebar-action"
              onClick={() => setGithubImportOpen(true)}
              title="Import from GitHub"
              aria-haspopup="dialog"
            >
              <GitHubImportIcon />
              GitHub
            </button>
          </div>
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
      {githubImportOpen ? <GitHubImportModal browser={browser} onClose={() => setGithubImportOpen(false)} /> : null}
    </>
  )
})

function GitHubImportIcon(): JSX.Element {
  return (
    <svg className="sidebar-action-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.25 6.5V4.4a1.4 1.4 0 0 1 1.4-1.4h6.7a1.4 1.4 0 0 1 1.4 1.4v2.1" />
      <path d="M8 5.2v6.3" />
      <path d="M5.55 9.05 8 11.5l2.45-2.45" />
      <path d="M3.25 12.75h9.5" />
    </svg>
  )
}

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

// Info icon for the Session details pill (stroked currentColor SVG per the design
// system line-icon recipe).
function InfoIcon(): JSX.Element {
  return (
    <svg className="session-detail-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.4v3.4" />
      <path d="M8 5.15h.01" />
    </svg>
  )
}

// Modal popup with the selected session's facts. Reuses the design-system overlay
// pattern (fixed backdrop below the titlebar, dialog on --surface-1, close on
// backdrop click / Escape) and the shared `.session-detail-body`/`.session-facts`
// styles the accordion used.
export function SessionDetailModal({
  session,
  onClose
}: {
  session: AssistantSession
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Portal to <body> so the fixed overlay is never positioned relative to a
  // transformed ancestor (the history-sidebar animation transforms `.main-stack`).
  return createPortal(
    <div className="session-detail-modal-backdrop" onMouseDown={onClose}>
      <div
        className="session-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="session-detail-modal-header">
          <h2>Session details</h2>
          <button
            type="button"
            className="session-detail-modal-close"
            onClick={onClose}
            aria-label="Close session details"
          >
            ✕
          </button>
        </div>
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
            {titleSourceLabel(session) ? (
              <Fact label="Title source" value={titleSourceLabel(session) as string} />
            ) : null}
            {session.rawTitle && session.rawTitle !== session.title ? (
              <Fact label="Source" value={session.rawTitle} />
            ) : null}
          </dl>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function SessionHistorySidebar({
  session,
  historyState,
  newSession = false,
  open,
  onToggle,
  onShowDetails
}: {
  session: AssistantSession | null
  historyState: SessionHistoryState
  newSession?: boolean
  open: boolean
  onToggle: () => void
  onShowDetails: () => void
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
          <button
            type="button"
            className="history-details-button"
            onClick={onShowDetails}
            disabled={!session}
            aria-haspopup="dialog"
            aria-label="Session details"
            title="Session details"
          >
            <InfoIcon />
          </button>
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

// The "Title source" row only speaks up when the title isn't a plain, settled
// AI-generated one. A clean AI title is the expected default, so it returns null
// (the row is hidden) — the field is for the noteworthy cases: a manual rename, a
// non-AI heuristic/provider title, or an AI title that's mid-update or failed.
function titleSourceLabel(session: AssistantSession): string | null {
  if (session.titleSource === 'manual') return 'Manual override'
  if (session.titleSource === 'generated') {
    if (session.titleStatus === 'stale') return 'AI generated, updating'
    if (session.titleStatus === 'failed') return 'AI generated, update failed'
    return null
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
