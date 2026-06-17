import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { ProjectTask } from '@shared/project-workspace'
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
            {projectId ? (
              <>
                <TasksPanel workspace={workspace} openCount={openCount} />
                <NotesPanel notes={notes} onChange={workspace.setNotes} />
              </>
            ) : (
              <div className="workspace-dock-empty">Select a project to add notes and tasks.</div>
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
  const doneCount = tasks.length - openCount

  // Open tasks float to the top; done sink to the bottom. Array.sort is stable, so
  // insertion order is preserved within each group.
  const sorted = useMemo(() => [...tasks].sort((a, b) => Number(a.done) - Number(b.done)), [tasks])

  const submit = (): void => {
    workspace.addTask(draft)
    setDraft('')
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

      <div className="workspace-task-list">
        {sorted.length === 0 ? (
          <div className="workspace-task-empty">No tasks yet.</div>
        ) : (
          sorted.map((task) => (
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

      <div className="workspace-task-footer">
        <span>{openCount} open</span>
        {doneCount > 0 ? (
          <button type="button" className="workspace-task-clear" onClick={workspace.clearCompleted}>
            Clear {doneCount} done
          </button>
        ) : null}
      </div>
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
      <button
        type="button"
        className="workspace-task-remove"
        onClick={onRemove}
        aria-label="Delete task"
        title="Delete task"
      >
        ✕
      </button>
    </div>
  )
}

function NotesPanel({ notes, onChange }: { notes: string; onChange: (notes: string) => void }): JSX.Element {
  return (
    <div className="workspace-notes">
      <textarea
        className="workspace-notes-area"
        value={notes}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Project notes — references, reminders, snippets to keep handy while you work…"
        aria-label="Project notes"
        spellCheck={false}
      />
    </div>
  )
}
