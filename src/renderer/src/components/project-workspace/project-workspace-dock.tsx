import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import { reorderProjectTasks, type ProjectTask, type TaskDropEdge } from '@shared/project-workspace'
// Lazy-loaded so TipTap/ProseMirror (~900 kB) is only fetched when the user opens
// the Notes dock, instead of being parsed at every startup. The dock is collapsed
// by default, so most sessions never load it.
const NotesEditor = lazy(() => import('./notes-editor').then((module) => ({ default: module.NotesEditor })))
import { useProjectWorkspace, type ProjectWorkspaceState } from './use-project-workspace'
import './project-workspace-dock.css'

type CSSVars = CSSProperties & Record<`--${string}`, string | number>

function measuredDockBodyHeight(event: ReactPointerEvent<HTMLElement>, fallback: number): number {
  const dock = event.currentTarget.closest('.workspace-dock')
  const body = dock?.querySelector<HTMLElement>('.workspace-dock-body')
  return body?.getBoundingClientRect().height ?? fallback
}

export function ProjectWorkspaceDock({
  projectId,
  projectName,
  open,
  onToggle,
  height,
  onResizeStart
}: {
  projectId: string | null
  projectName: string | null
  open: boolean
  onToggle: () => void
  height: number | null
  onResizeStart: (event: ReactPointerEvent<HTMLElement>, startSize: number) => void
}): JSX.Element {
  const workspace = useProjectWorkspace(projectId)
  const { tasks, notes } = workspace.workspace
  const openCount = tasks.filter((task) => !task.done).length
  const hasNotes = notes.trim().length > 0
  const summary = projectId
    ? `${openCount} open · ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}${hasNotes ? ' · notes' : ''}`
    : 'Select a project'

  return (
    <section
      className={`panel workspace-dock ${open ? 'expanded' : 'collapsed'}`}
      aria-label="Project notes and tasks"
      style={
        height === null
          ? undefined
          : ({
              '--workspace-dock-height': `${height}px`
            } as CSSVars)
      }
    >
      {open ? (
        <div
          className="panel-resize-handle panel-resize-handle-top workspace-dock-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize notes and tasks"
          onPointerDown={(event) => onResizeStart(event, measuredDockBodyHeight(event, height ?? 280))}
        />
      ) : null}
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
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ taskId: string; edge: TaskDropEdge } | null>(null)
  const [reorderAnnouncement, setReorderAnnouncement] = useState('')
  const reorderHelpId = useId()
  const doneCount = tasks.length - openCount

  // Tabs split open from done; each preserves its order from the persisted task array.
  const visible = useMemo(() => tasks.filter((task) => (tab === 'open' ? !task.done : task.done)), [tasks, tab])

  const reorderTask = useCallback(
    (sourceId: string, targetId: string, edge: TaskDropEdge) => {
      const reordered = reorderProjectTasks(tasks, sourceId, targetId, edge)
      if (reordered === tasks) return

      workspace.reorderTask(sourceId, targetId, edge)
      const moved = reordered.find((task) => task.id === sourceId)
      if (!moved) return
      const reorderedVisible = reordered.filter((task) => task.done === moved.done)
      const position = reorderedVisible.findIndex((task) => task.id === sourceId) + 1
      setReorderAnnouncement(`${moved.text} moved to position ${position} of ${reorderedVisible.length}.`)
    },
    [tasks, workspace]
  )

  const moveTaskBy = useCallback(
    (taskId: string, offset: -1 | 1) => {
      const index = visible.findIndex((task) => task.id === taskId)
      const target = visible[index + offset]
      if (!target) return
      reorderTask(taskId, target.id, offset < 0 ? 'before' : 'after')
    },
    [reorderTask, visible]
  )

  const clearDragState = useCallback(() => {
    setDraggedTaskId(null)
    setDropTarget(null)
  }, [])

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
          <span className="workspace-task-tab-label">Open</span>
          <span className="workspace-task-tab-count">{openCount}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'done'}
          className={tab === 'done' ? 'active' : ''}
          onClick={() => setTab('done')}
        >
          <span className="workspace-task-tab-label">Done</span>
          <span className="workspace-task-tab-count">{doneCount}</span>
        </button>
      </div>

      <p id={reorderHelpId} className="workspace-task-reorder-help">
        Drag the reorder handle, or focus it and press the Up or Down arrow key.
      </p>
      <div className="workspace-task-list" role="list">
        {visible.length === 0 ? (
          <div className="workspace-task-empty">{tab === 'open' ? 'No open tasks.' : 'No completed tasks.'}</div>
        ) : (
          visible.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              reorderHelpId={reorderHelpId}
              dragActive={draggedTaskId !== null}
              dragging={draggedTaskId === task.id}
              dropEdge={dropTarget?.taskId === task.id ? dropTarget.edge : null}
              onToggle={() => workspace.toggleTask(task.id)}
              onEdit={(text) => workspace.editTask(task.id, text)}
              onMove={(offset) => moveTaskBy(task.id, offset)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', task.id)
                const row = event.currentTarget.closest('.workspace-task')
                if (row instanceof HTMLElement) event.dataTransfer.setDragImage(row, 12, 12)
                setDraggedTaskId(task.id)
                setDropTarget(null)
              }}
              onDragOver={(edge) => {
                if (!draggedTaskId || draggedTaskId === task.id) {
                  setDropTarget(null)
                  return
                }
                setDropTarget({ taskId: task.id, edge })
              }}
              onDragLeave={() => {
                setDropTarget((current) => (current?.taskId === task.id ? null : current))
              }}
              onDrop={(edge) => {
                if (draggedTaskId) reorderTask(draggedTaskId, task.id, edge)
                clearDragState()
              }}
              onDragEnd={clearDragState}
              onRemove={() => workspace.removeTask(task.id)}
            />
          ))
        )}
      </div>
      <p className="workspace-task-reorder-help" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

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
  reorderHelpId,
  dragActive,
  dragging,
  dropEdge,
  onToggle,
  onEdit,
  onMove,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onRemove
}: {
  task: ProjectTask
  reorderHelpId: string
  dragActive: boolean
  dragging: boolean
  dropEdge: TaskDropEdge | null
  onToggle: () => void
  onEdit: (text: string) => void
  onMove: (offset: -1 | 1) => void
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void
  onDragOver: (edge: TaskDropEdge) => void
  onDragLeave: () => void
  onDrop: (edge: TaskDropEdge) => void
  onDragEnd: () => void
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

  const dropEdgeFromEvent = (event: ReactDragEvent<HTMLDivElement>): TaskDropEdge => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }

  const moveWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    onMove(event.key === 'ArrowUp' ? -1 : 1)
  }

  return (
    <div
      className={`workspace-task ${task.done ? 'done' : ''} ${dragging ? 'dragging' : ''} ${dropEdge ? `drop-${dropEdge}` : ''}`}
      role="listitem"
      onDragOver={(event) => {
        if (!dragActive || dragging) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onDragOver(dropEdgeFromEvent(event))
      }}
      onDragLeave={(event) => {
        const nextTarget = event.relatedTarget
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
        onDragLeave()
      }}
      onDrop={(event) => {
        if (!dragActive) return
        event.preventDefault()
        onDrop(dropEdgeFromEvent(event))
      }}
    >
      <button
        type="button"
        className="workspace-task-reorder"
        draggable
        aria-label={`Reorder task: ${task.text}`}
        aria-describedby={reorderHelpId}
        aria-keyshortcuts="ArrowUp ArrowDown"
        title="Drag to reorder; use Up or Down when focused"
        onKeyDown={moveWithKeyboard}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <TaskReorderIcon />
      </button>
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
          🗑
        </button>
      )}
    </div>
  )
}

function TaskReorderIcon(): JSX.Element {
  return (
    <svg className="workspace-task-reorder-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5 4h.01M11 4h.01M5 8h.01M11 8h.01M5 12h.01M11 12h.01" />
    </svg>
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
      <Suspense fallback={<div className="workspace-notes-loading">Loading editor…</div>}>
        <NotesEditor key={projectId ?? 'none'} initialHtml={notes} onChange={onChange} />
      </Suspense>
    </div>
  )
}
