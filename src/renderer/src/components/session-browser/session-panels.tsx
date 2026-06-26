import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, JSX, PointerEvent as ReactPointerEvent } from 'react'
import type {
  AssistantSession,
  AssistantSessionHistoryEntry
} from '@shared/sessions'
import { CopyableCodeBlock, HistoryMarkdown } from '../history-markdown'
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

type CSSVars = CSSProperties & Record<`--${string}`, string | number>

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

function historyRawCodeLanguage(text: string): string | null {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : null
}

function measuredPanelSize(
  event: ReactPointerEvent<HTMLElement>,
  selector: string,
  axis: 'width' | 'height',
  fallback: number
): number {
  const element = event.currentTarget.closest(selector)
  const rect = element?.getBoundingClientRect()
  return rect ? rect[axis] : fallback
}

export const ProjectSessionSidebar = memo(function ProjectSessionSidebar({
  title,
  ariaLabel,
  emptyLabel,
  browser,
  pendingSessions,
  open,
  onToggle,
  width,
  onResizeStart,
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
  open: boolean
  onToggle: () => void
  width: number | null
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
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
  const sidebarStyle =
    width === null
      ? undefined
      : ({
          '--project-sidebar-width': `${width}px`
        } as CSSVars)

  return (
    <>
      <aside className={`sidebar project-sidebar ${open ? 'open' : 'closed'}`} aria-label={ariaLabel} style={sidebarStyle}>
        <button
          type="button"
          className="project-sidebar-rail"
          aria-label="Show projects and sessions"
          aria-expanded={false}
          onClick={onToggle}
          tabIndex={open ? -1 : 0}
          title="Show projects and sessions"
        >
          <span className="project-sidebar-rail-icon" aria-hidden="true">
            ▸
          </span>
          <span className="project-sidebar-rail-label">Projects</span>
        </button>
        <div className="project-sidebar-content" aria-hidden={!open}>
          <div className="sidebar-header">
            <h2>{title}</h2>
            <div className="sidebar-actions">
              <button
                type="button"
                className="sidebar-action"
                onClick={() => browser.attachWorkspace()}
                title="Attach an existing folder or create a new project workspace"
                tabIndex={open ? 0 : -1}
              >
                + New
              </button>
              <button
                type="button"
                className="sidebar-action"
                onClick={() => setGithubImportOpen(true)}
                title="Import from GitHub"
                aria-haspopup="dialog"
                tabIndex={open ? 0 : -1}
              >
                <GitHubImportIcon />
                GitHub
              </button>
              <button
                type="button"
                className="panel-collapse-toggle project-sidebar-collapse"
                aria-label="Hide projects and sessions"
                aria-expanded={true}
                onClick={onToggle}
                tabIndex={open ? 0 : -1}
                title="Hide projects and sessions"
              >
                ◂
              </button>
            </div>
          </div>
          <input
            className="sidebar-search"
            placeholder="Search projects"
            aria-label={`Search ${ariaLabel}`}
            value={browser.query}
            onChange={(event) => browser.setQuery(event.target.value)}
            tabIndex={open ? 0 : -1}
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
                tabIndex={open ? 0 : -1}
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
        </div>
        {open ? (
          <div
            className="panel-resize-handle panel-resize-handle-right project-sidebar-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize projects and sessions"
            onPointerDown={(event) =>
              onResizeStart(event, measuredPanelSize(event, '.project-sidebar', 'width', width ?? 310))
            }
          />
        ) : null}
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

// Play/resume triangle — same stroked currentColor line-icon recipe.
function ResumeIcon(): JSX.Element {
  return (
    <svg className="history-resume-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.5 3.75l6.25 4.25-6.25 4.25z" />
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

// CSS Custom Highlight API accessors. Typed locally (these are newer than the TS
// lib) and feature-detected, though this Electron's Chromium supports them. The
// API paints ranges over existing text without touching the DOM, so it highlights
// the searched word inside already-rendered markdown/code without re-parsing it.
type HighlightLike = { priority: number }
type HighlightConstructor = new (...ranges: Range[]) => HighlightLike
const HighlightCtor = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight
const highlightRegistry = (
  CSS as unknown as { highlights?: { set(name: string, highlight: HighlightLike): void; delete(name: string): void } }
).highlights
const HIGHLIGHTS_SUPPORTED = Boolean(HighlightCtor && highlightRegistry)
const SEARCH_HIGHLIGHT = 'history-search'
const SEARCH_HIGHLIGHT_ACTIVE = 'history-search-active'

// Collect ranges for every case-insensitive occurrence of `needle` in the rendered
// transcript text, skipping the role/timestamp meta and code toolbars (so a search
// for e.g. "copy" doesn't light up every code block's Copy button). Ranges come
// back in document order, which is the on-screen order (newest entry first).
function collectSearchRanges(root: HTMLElement, needle: string): Range[] {
  const ranges: Range[] = []
  const lower = needle.toLowerCase()
  if (!lower) return ranges

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT
      if (node.parentElement?.closest('.history-entry-meta, .md-code-toolbar')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const haystack = (node.nodeValue ?? '').toLowerCase()
    for (let from = haystack.indexOf(lower); from !== -1; from = haystack.indexOf(lower, from + lower.length)) {
      const range = document.createRange()
      range.setStart(node, from)
      range.setEnd(node, from + lower.length)
      ranges.push(range)
    }
  }

  return ranges
}

export function SessionHistorySidebar({
  session,
  historyState,
  newSession = false,
  open,
  onToggle,
  width,
  onResizeStart,
  onShowDetails,
  onResume
}: {
  session: AssistantSession | null
  historyState: SessionHistoryState
  newSession?: boolean
  open: boolean
  onToggle: () => void
  width: number | null
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
  onShowDetails: () => void
  onResume?: () => void
}): JSX.Element {
  const { history, loading, error } = historyState
  const entryCount = history?.entries.length ?? 0
  const entrySummary =
    loading && !history
      ? 'Loading entries...'
      : `${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}`

  // In-panel search keeps the whole transcript visible (Ctrl+F style) and highlights
  // the matched word in place, stepping through occurrences with prev/next. Matches
  // are painted with the CSS Custom Highlight API — it highlights ranges over the
  // already-rendered markdown/code without mutating the DOM (React is untouched and
  // the markdown is never re-parsed on a keystroke). Reset on session change.
  const [query, setQuery] = useState('')
  const [activeMatch, setActiveMatch] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  const trimmedQuery = query.trim().toLowerCase()
  const feedRef = useRef<HTMLDivElement>(null)
  const rangesRef = useRef<Range[]>([])

  useEffect(() => {
    setQuery('')
    setActiveMatch(0)
  }, [session?.id])

  const displayedEntries = useMemo(() => (history ? [...history.entries].reverse() : []), [history])

  // (Re)collect matched ranges whenever the query or transcript changes, and paint
  // them all with the base highlight. The active occurrence is handled separately.
  useEffect(() => {
    const feed = feedRef.current
    const ranges = feed && trimmedQuery ? collectSearchRanges(feed, trimmedQuery) : []
    rangesRef.current = ranges
    if (HIGHLIGHTS_SUPPORTED && ranges.length > 0) {
      highlightRegistry!.set(SEARCH_HIGHLIGHT, new HighlightCtor!(...ranges))
    } else {
      highlightRegistry?.delete(SEARCH_HIGHLIGHT)
    }
    setMatchCount(ranges.length)
    setActiveMatch(0)
    return () => {
      highlightRegistry?.delete(SEARCH_HIGHLIGHT)
      highlightRegistry?.delete(SEARCH_HIGHLIGHT_ACTIVE)
    }
  }, [trimmedQuery, displayedEntries])

  // Paint the active match more strongly (higher priority) and scroll it into view.
  useEffect(() => {
    const active = rangesRef.current[activeMatch]
    if (!HIGHLIGHTS_SUPPORTED || !active) {
      highlightRegistry?.delete(SEARCH_HIGHLIGHT_ACTIVE)
      return
    }
    const highlight = new HighlightCtor!(active)
    highlight.priority = 1
    highlightRegistry!.set(SEARCH_HIGHLIGHT_ACTIVE, highlight)
    const feed = feedRef.current
    if (feed) {
      const rect = active.getBoundingClientRect()
      const feedRect = feed.getBoundingClientRect()
      if (rect.width || rect.height) {
        feed.scrollTo({
          top: feed.scrollTop + (rect.top - feedRect.top) - feedRect.height / 2 + rect.height / 2,
          behavior: 'smooth'
        })
      }
    }
  }, [activeMatch, matchCount])

  const stepMatch = (delta: number): void =>
    setActiveMatch((current) => (matchCount === 0 ? 0 : (current + delta + matchCount) % matchCount))

  const historyEntries = useMemo(() => {
    if (displayedEntries.length === 0) return null

    return displayedEntries.map((entry) => {
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
              <HistoryMarkdown text={entry.text} copyCodeBlocks />
            ) : (
              <CopyableCodeBlock
                code={entry.text}
                language={historyRawCodeLanguage(entry.text)}
                className="history-raw-code"
              />
            )}
          </div>
        </article>
      )
    })
  }, [displayedEntries])
  const sidebarStyle =
    width === null
      ? undefined
      : ({
          '--history-sidebar-open-width': `${width}px`
        } as CSSVars)

  return (
    <aside className={`history-sidebar-shell ${open ? 'open' : 'closed'}`} aria-label="Session history" style={sidebarStyle}>
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
            className="history-resume-button"
            onClick={onResume}
            disabled={!session || newSession || !onResume}
            aria-label="Resume this session in a terminal"
            title="Resume this session in a terminal"
          >
            <ResumeIcon />
            <span>Resume</span>
          </button>
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
      {session && history && history.entries.length > 0 ? (
        <div className="history-search-bar">
          <span className="history-search-glyph" aria-hidden="true">
            ⌕
          </span>
          <input
            type="search"
            className="history-search-input"
            placeholder="Search this session"
            aria-label="Search this session's history"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                stepMatch(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setQuery('')
              }
            }}
          />
          {trimmedQuery ? (
            <>
              <span className="history-search-count">
                {matchCount > 0 ? `${activeMatch + 1} / ${matchCount}` : 'No matches'}
              </span>
              <button
                type="button"
                className="history-search-nav"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                disabled={matchCount === 0}
                onClick={() => stepMatch(-1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="history-search-nav"
                aria-label="Next match"
                title="Next match (Enter)"
                disabled={matchCount === 0}
                onClick={() => stepMatch(1)}
              >
                ▼
              </button>
            </>
          ) : null}
        </div>
      ) : null}
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
        <div className="history-feed" ref={feedRef}>
          {historyEntries}
        </div>
      )}
      {session ? <div className="history-entry-summary">{entrySummary}</div> : null}
    </section>
    {open ? (
      <div
        className="panel-resize-handle panel-resize-handle-left history-sidebar-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize history"
        onPointerDown={(event) =>
          onResizeStart(event, measuredPanelSize(event, '.history-sidebar-shell', 'width', width ?? 410))
        }
      />
    ) : null}
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
