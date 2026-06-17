import { useCallback, useEffect, useRef, useState } from 'react'
import {
  emptyProjectWorkspace,
  MAX_TASK_TEXT_LENGTH,
  type ProjectTask,
  type ProjectWorkspace
} from '@shared/project-workspace'

// Tasks update state instantly (responsive UI) but disk writes are debounced so a
// burst of edits (or notes typing) collapses into one save.
const SAVE_DEBOUNCE_MS = 400

export type ProjectWorkspaceState = {
  workspace: ProjectWorkspace
  loading: boolean
  ready: boolean
  setNotes: (notes: string) => void
  addTask: (text: string) => void
  toggleTask: (id: string) => void
  editTask: (id: string, text: string) => void
  removeTask: (id: string) => void
  clearCompleted: () => void
}

function makeTaskId(): string {
  return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function useProjectWorkspace(projectId: string | null): ProjectWorkspaceState {
  const [workspace, setWorkspace] = useState<ProjectWorkspace>(() => emptyProjectWorkspace())
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)

  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace

  // A pending (debounced) save remembers the projectId it belongs to, so switching
  // projects flushes the previous project's edits to the right place.
  const pendingRef = useRef<{ projectId: string; data: ProjectWorkspace } | null>(null)
  const timerRef = useRef<number | null>(null)

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    if (pending) {
      pendingRef.current = null
      window.dashboard?.projectWorkspace?.save(pending.projectId, pending.data).catch(() => undefined)
    }
  }, [])

  const scheduleSave = useCallback(
    (data: ProjectWorkspace) => {
      if (!projectId) return
      pendingRef.current = { projectId, data }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
    },
    [flush, projectId]
  )

  // Load the selected project's workspace; flush any pending edits for the previous
  // project first (cleanup runs before the next effect body).
  useEffect(() => {
    if (!projectId) {
      setWorkspace(emptyProjectWorkspace())
      setReady(true)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    setReady(false)
    window.dashboard?.projectWorkspace
      ?.get(projectId)
      .then((data) => {
        if (cancelled) return
        setWorkspace(data ?? emptyProjectWorkspace())
      })
      .catch(() => {
        if (!cancelled) setWorkspace(emptyProjectWorkspace())
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setReady(true)
      })

    return () => {
      cancelled = true
      flush()
    }
  }, [projectId, flush])

  // Flush on unmount so the last edit isn't lost when leaving the view.
  useEffect(() => flush, [flush])

  const apply = useCallback(
    (next: ProjectWorkspace) => {
      setWorkspace(next)
      workspaceRef.current = next
      scheduleSave(next)
    },
    [scheduleSave]
  )

  const setNotes = useCallback((notes: string) => apply({ ...workspaceRef.current, notes }), [apply])

  const addTask = useCallback(
    (text: string) => {
      const trimmed = text.trim().slice(0, MAX_TASK_TEXT_LENGTH)
      if (!trimmed) return
      const task: ProjectTask = { id: makeTaskId(), text: trimmed, done: false, createdAt: Date.now() }
      apply({ ...workspaceRef.current, tasks: [task, ...workspaceRef.current.tasks] })
    },
    [apply]
  )

  const toggleTask = useCallback(
    (id: string) => {
      apply({
        ...workspaceRef.current,
        tasks: workspaceRef.current.tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task))
      })
    },
    [apply]
  )

  const editTask = useCallback(
    (id: string, text: string) => {
      const trimmed = text.trim().slice(0, MAX_TASK_TEXT_LENGTH)
      if (!trimmed) {
        apply({ ...workspaceRef.current, tasks: workspaceRef.current.tasks.filter((task) => task.id !== id) })
        return
      }
      apply({
        ...workspaceRef.current,
        tasks: workspaceRef.current.tasks.map((task) => (task.id === id ? { ...task, text: trimmed } : task))
      })
    },
    [apply]
  )

  const removeTask = useCallback(
    (id: string) => {
      apply({ ...workspaceRef.current, tasks: workspaceRef.current.tasks.filter((task) => task.id !== id) })
    },
    [apply]
  )

  const clearCompleted = useCallback(() => {
    apply({ ...workspaceRef.current, tasks: workspaceRef.current.tasks.filter((task) => !task.done) })
  }, [apply])

  return { workspace, loading, ready, setNotes, addTask, toggleTask, editTask, removeTask, clearCompleted }
}
