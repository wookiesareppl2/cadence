import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { AssistantSession } from '@shared/sessions'
import type { ProjectSessionGroup } from './use-session-browser'

// Inline rename input. A done-guard stops the unmount-triggered blur from
// double-firing after Enter (commit) or Esc (cancel).
function RenameField({
  initialValue,
  ariaLabel,
  onCommit,
  onCancel
}: {
  initialValue: string
  ariaLabel: string
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(value)
  }
  const cancel = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      className="row-rename-input"
      aria-label={ariaLabel}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
      onBlur={commit}
    />
  )
}

// Hover/focus-revealed rename + delete controls. Delete is a lightweight two-step
// inline confirm rather than a blocking native dialog. onDelete resolves to
// whether the item actually went away; a false result surfaces a transient
// inline error (e.g. the file was locked by a running CLI).
function RowActions({
  label,
  confirmText = 'Delete?',
  onRename,
  onDelete
}: {
  label: string
  confirmText?: string
  onRename: () => void
  onDelete: () => Promise<boolean>
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(null), 4000)
    return () => clearTimeout(id)
  }, [error])

  return (
    <>
      {error ? (
        <span className="row-error" role="alert">
          {error}
        </span>
      ) : null}
      {confirming ? (
        <div className="row-actions row-confirm" role="group" aria-label={`Confirm delete ${label}`}>
          <span className="row-confirm-label">{confirmText}</span>
          <button
            type="button"
            className="row-action danger"
            aria-label={`Confirm delete ${label}`}
            title="Move to Recycle Bin"
            onClick={async () => {
              setConfirming(false)
              const ok = await onDelete()
              setError(ok ? null : 'Couldn’t delete — file may be in use')
            }}
          >
            ✓
          </button>
          <button
            type="button"
            className="row-action"
            aria-label="Cancel delete"
            title="Cancel"
            onClick={() => setConfirming(false)}
          >
            ✕
          </button>
        </div>
      ) : (
        <div className="row-actions">
          <button
            type="button"
            className="row-action"
            aria-label={`Rename ${label}`}
            title={`Rename ${label}`}
            onClick={() => {
              setError(null)
              onRename()
            }}
          >
            ✎
          </button>
          <button
            type="button"
            className="row-action"
            aria-label={`Delete ${label}`}
            title={`Delete ${label}`}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
          >
            🗑
          </button>
        </div>
      )}
    </>
  )
}

function ProjectRow({
  project,
  isActive,
  onSelect,
  onRename,
  onDelete
}: {
  project: ProjectSessionGroup
  isActive: boolean
  onSelect: () => void
  onRename: (name: string | null) => void
  onDelete: () => Promise<boolean>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const confirmText =
    project.sessionCount > 0
      ? `Delete ${project.sessionCount} session${project.sessionCount === 1 ? '' : 's'}?`
      : 'Remove project?'

  return (
    <div className={`project-row ${isActive ? 'active' : ''}`}>
      {editing ? (
        <div className="project-item editing">
          <RenameField
            initialValue={project.name}
            ariaLabel={`Rename project ${project.name}`}
            onCommit={(value) => {
              setEditing(false)
              onRename(value.trim() ? value.trim() : null)
            }}
            onCancel={() => setEditing(false)}
          />
          {project.path ? <span className="project-path">{project.path}</span> : null}
        </div>
      ) : (
        <button
          type="button"
          className={`project-item ${isActive ? 'active' : ''}`}
          aria-current={isActive ? 'true' : undefined}
          onClick={onSelect}
        >
          <span className="project-title">{project.name}</span>
          {project.path ? <span className="project-path">{project.path}</span> : null}
          <span className="project-meta">
            <span>{project.sessionCount === 0 ? 'No sessions yet' : `${project.sessionCount} sessions`}</span>
            <span>{project.sessionCount === 0 ? 'Attached' : `Updated ${project.age}`}</span>
          </span>
        </button>
      )}
      {editing ? null : (
        <RowActions
          label={`project ${project.name}`}
          confirmText={confirmText}
          onRename={() => setEditing(true)}
          onDelete={onDelete}
        />
      )}
    </div>
  )
}

function SessionRow({
  session,
  isActive,
  onSelect,
  onRename,
  onDelete
}: {
  session: AssistantSession
  isActive: boolean
  onSelect: () => void
  onRename: (title: string | null) => void
  onDelete: () => Promise<boolean>
}): JSX.Element {
  const [editing, setEditing] = useState(false)

  return (
    <div className={`session-row ${isActive ? 'active' : ''}`}>
      {editing ? (
        <div className="session-item editing">
          <RenameField
            initialValue={session.title}
            ariaLabel={`Rename session ${session.title}`}
            onCommit={(value) => {
              setEditing(false)
              onRename(value.trim() ? value.trim() : null)
            }}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          className={`session-item ${isActive ? 'active' : ''}`}
          aria-current={isActive ? 'true' : undefined}
          onClick={onSelect}
        >
          <span className="session-title">{session.title}</span>
          <span className="session-meta">
            <span>{formatShortDate(session.updatedAt)}</span>
            {session.branch && session.branch !== 'HEAD' ? <span>{session.branch}</span> : null}
          </span>
        </button>
      )}
      {editing ? null : (
        <RowActions label={`session ${session.title}`} onRename={() => setEditing(true)} onDelete={onDelete} />
      )}
    </div>
  )
}

export function ProjectList({
  projects,
  loading,
  error,
  emptyLabel,
  selectedProjectId,
  onSelectProject,
  onRenameProject,
  onDeleteProject
}: {
  projects: ProjectSessionGroup[]
  loading: boolean
  error: string | null
  emptyLabel: string
  selectedProjectId: string | null
  onSelectProject: (projectId: string) => void
  onRenameProject: (projectId: string, name: string | null) => Promise<void>
  onDeleteProject: (projectId: string) => Promise<{ trashed: number }>
}): JSX.Element {
  if (loading) return <div className="session-placeholder">Scanning projects...</div>
  if (error) return <div className="session-placeholder error">{error}</div>
  if (projects.length === 0) return <div className="session-placeholder">{emptyLabel}</div>

  return (
    <>
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          isActive={project.id === selectedProjectId}
          onSelect={() => onSelectProject(project.id)}
          onRename={(name) => onRenameProject(project.id, name)}
          onDelete={async () => {
            const result = await onDeleteProject(project.id)
            // Empty (attached-only) projects detach with nothing trashed.
            return project.sessionCount === 0 || result.trashed > 0
          }}
        />
      ))}
    </>
  )
}

export function SessionList({
  sessions,
  loading,
  error,
  emptyLabel,
  selectedSessionId,
  onSelectSession,
  onRenameSession,
  onDeleteSession
}: {
  sessions: AssistantSession[]
  loading: boolean
  error: string | null
  emptyLabel: string
  selectedSessionId: string | null
  onSelectSession: (sessionId: string) => void
  onRenameSession: (sessionId: string, title: string | null) => Promise<void>
  onDeleteSession: (sessionId: string) => Promise<{ trashed: number }>
}): JSX.Element {
  if (loading) return <div className="session-placeholder">Scanning sessions...</div>
  if (error) return <div className="session-placeholder error">{error}</div>
  if (sessions.length === 0) return <div className="session-placeholder">{emptyLabel}</div>

  return (
    <>
      {sessions.map((session) => (
        <SessionRow
          key={`${session.platform}:${session.id}`}
          session={session}
          isActive={session.id === selectedSessionId}
          onSelect={() => onSelectSession(session.id)}
          onRename={(title) => onRenameSession(session.id, title)}
          onDelete={async () => {
            const result = await onDeleteSession(session.id)
            return result.trashed > 0
          }}
        />
      ))}
    </>
  )
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
