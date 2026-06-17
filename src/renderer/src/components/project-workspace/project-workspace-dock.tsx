import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ProjectTask } from '@shared/project-workspace'
import { NotesEditor } from './notes-editor'
import { useProjectWorkspace, type ProjectWorkspaceState } from './use-project-workspace'
import './project-workspace-dock.css'

export function ProjectWorkspaceDock({
  projectId,
  projectName,
  open,
  onToggle
}: {
  projectId: string | null
  projectName: string | null
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const workspace = useProjectWorkspace(projectId)
  const { tasks, notes } = workspace.workspace
  const openCount = tasks.filter((task) => !task.done).length
  const hasNotes = notes.trim().length > 0
  const summary = projectId
    ? `${openCount} open · ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}${hasNotes ? ' · notes' : ''}`
    : 'Select a project'

  return (
    <section className="panel workspace-dock" aria-label="Project notes and tasks">
      <button
        type="button"
        className="workspace-dock-header"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Hide notes & tasks' : 'Show notes & tasks'}
      >
        <span className="workspace-dock-title">Notes &amp; Tasks</span>
        <span className="workspace-dock-sub">{open ? (projectName ?? '') : summary}</span>
        <span className="workspace-dock-chevron" aria-hidden="true">
          {open ? '▾' : '▴'}
        </span>
      </button>
      <div className="collapsible-content workspace-dock-content" data-open={open} aria-hidden={!open}>
        <div className="collapsible-inner">
          <div className="workspace-dock-body">
            {!projectId ? (
              <div className="workspace-dock-empty">Select a project to add notes and tasks.</div>
            ) : !workspace.ready ? (
              // Don't render an editable empty state before the project's data loads —
              // editing the placeholder could otherwise overwrite stored notes/tasks.
              <div className="workspace-dock-empty">Loading…</div>
            ) : (
              <>
                <TasksPanel workspace={workspace} openCount={openCount} />
                <NotesPanel projectId={projectId} notes={notes} onChange={workspace.setNotes} />
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function TasksPanel({ workspace, openCount }: { workspace: ProjectWorkspaceState; openCount: number }): JSX.Element {
  const { tasks } = workspace.workspace
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<'open' | 'done'>('open')
  const doneCount = tasks.length - openCount

  // Tabs split open from done; each keeps insertion order (new open tasks at bottom).
  const visible = useMemo(() => tasks.filter((task) => (tab === 'open' ? !task.done : task.done)), [tasks, tab])

  const submit = (): void => {
    workspace.addTask(draft)
    setDraft('')
    // A new task is open, so surface the Open tab if we're viewing Done.
    setTab('open')
  }

  return (
    <div className="workspace-tasks">
      <form
        className="workspace-task-add"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a task…"
          aria-label="Add a task"
        />
        <button type="submit" disabled={!draft.trim()}>
          Add
        </button>
      </form>

      <div className="workspace-task-tabs" role="tablist" aria-label="Task status">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'open'}
          className={tab === 'open' ? 'active' : ''}
          onClick={() => setTab('open')}
        >
          Open <span className="workspace-task-tab-count">{openCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'done'}
          className={tab === 'done' ? 'active' : ''}
          onClick={() => setTab('done')}
        >
          Done <span className="workspace-task-tab-count">{doneCount}</span>
        </button>
      </div>

      <div className="workspace-task-list">
        {visible.length === 0 ? (
          <div className="workspace-task-empty">{tab === 'open' ? 'No open tasks.' : 'No completed tasks.'}</div>
        ) : (
          visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={() => workspace.toggleTask(task.id)}
              onEdit={(text) => workspace.editTask(task.id, text)}
              onRemove={() => workspace.removeTask(task.id)}
            />
          ))
        )}
      </div>

      {tab === 'done' && doneCount > 0 ? (
        <div className="workspace-task-footer">
          <button type="button" className="workspace-task-clear" onClick={workspace.clearCompleted}>
            Clear all done
          </button>
        </div>
      ) : null}
    </div>
  )
}

function TaskRow({
  task,
  onToggle,
  onEdit,
  onRemove
}: {
  task: ProjectTask
  onToggle: () => void
  onEdit: (text: string) => void
  onRemove: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [value, setValue] = useState(task.text)
  const inputRef = useRef<HTMLInputElement>(null)
  const committedRef = useRef(false)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const startEdit = (): void => {
    setValue(task.text)
    committedRef.current = false
    setEditing(true)
  }
  const commit = (): void => {
    if (committedRef.current) return
    committedRef.current = true
    setEditing(false)
    if (value.trim() !== task.text) onEdit(value)
  }
  const cancel = (): void => {
    committedRef.current = true
    setEditing(false)
  }

  return (
    <div className={`workspace-task ${task.done ? 'done' : ''}`}>
      <button
        type="button"
        className="workspace-task-check"
        role="checkbox"
        aria-checked={task.done}
        aria-label={task.done ? 'Mark task not done' : 'Mark task done'}
        onClick={onToggle}
      >
        {task.done ? '✓' : ''}
      </button>
      {editing ? (
        <input
          ref={inputRef}
          className="workspace-task-edit"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancel()
            }
          }}
          aria-label="Edit task"
        />
      ) : (
        <button type="button" className="workspace-task-text" onClick={startEdit} title="Click to edit">
          {task.text}
        </button>
      )}
      {confirming ? (
        <div className="workspace-task-confirm" role="group" aria-label="Confirm delete task">
          <span className="workspace-task-confirm-label">Delete?</span>
          <button
            type="button"
            className="workspace-task-confirm-yes"
            onClick={() => {
              setConfirming(false)
              onRemove()
            }}
            aria-label="Confirm delete task"
            title="Delete"
          >
            ✓
          </button>
          <button
            type="button"
            className="workspace-task-confirm-no"
            onClick={() => setConfirming(false)}
            aria-label="Cancel delete"
            title="Cancel"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="workspace-task-remove"
          onClick={() => setConfirming(true)}
          aria-label="Delete task"
          title="Delete task"
        >
          ✕
        </button>
      )}
    </div>
  )
}

function NotesPanel({
  projectId,
  notes,
  onChange
}: {
  projectId: string | null
  notes: string
  onChange: (notes: string) => void
}): JSX.Element {
  return (
    <div className="workspace-notes">
      {/* Re-key per project so the editor re-initializes with that project's notes. */}
      <NotesEditor key={projectId ?? 'none'} initialHtml={notes} onChange={onChange} />
    </div>
  )
}
