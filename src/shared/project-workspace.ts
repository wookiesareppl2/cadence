// Per-project notes and tasks. Anchored to a project DIRECTORY (never a session)
// so they persist across every session in that project — and across AI models:
// the same folder opened in Claude or Codex shares one set of notes/tasks.
// Stored in the app's userData dir, never inside a provider's own config directory.

export type ProjectTask = {
  id: string
  text: string
  done: boolean
  createdAt: number
}

export type ProjectWorkspace = {
  notes: string
  tasks: ProjectTask[]
}

export type TaskDropEdge = 'before' | 'after'

export const MAX_NOTES_LENGTH = 100_000
export const MAX_TASKS = 500
export const MAX_TASK_TEXT_LENGTH = 2_000

export function emptyProjectWorkspace(): ProjectWorkspace {
  return { notes: '', tasks: [] }
}

// Notes/tasks are shared across AI models for the same directory, so the store is
// keyed by the platform-independent part of the projectId. A projectId is always
// `<platform>:<rest>` (e.g. `claude:c:\…`); dropping the leading provider yields
// one key for the same folder. Other (already-platform-independent) ids pass
// through unchanged. `opencode:` stays in the strip list even though OpenCode was
// removed as a provider: entries stored under it must still fold onto the same
// directory key, or a folder previously opened there would orphan its notes.
export function projectWorkspaceKey(projectId: string): string {
  return projectId.replace(/^(claude|codex|opencode):/, '')
}

export function isProjectWorkspaceEmpty(workspace: ProjectWorkspace): boolean {
  return workspace.notes.trim().length === 0 && workspace.tasks.length === 0
}

// Reorder one task relative to another task in the same status list. Open and
// completed tasks share one persisted array, so the status guard prevents a drag
// from silently moving a task across the Open / Done boundary.
export function reorderProjectTasks(
  tasks: ProjectTask[],
  sourceId: string,
  targetId: string,
  edge: TaskDropEdge
): ProjectTask[] {
  const sourceIndex = tasks.findIndex((task) => task.id === sourceId)
  const targetIndex = tasks.findIndex((task) => task.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return tasks

  const source = tasks[sourceIndex]
  const target = tasks[targetIndex]
  if (!source || !target || source.done !== target.done) return tasks

  const sameStatusTasks = tasks.filter((task) => task.done === source.done)
  const sameStatusSourceIndex = sameStatusTasks.findIndex((task) => task.id === sourceId)
  const [moved] = sameStatusTasks.splice(sameStatusSourceIndex, 1)
  if (!moved) return tasks

  const adjustedTargetIndex = sameStatusTasks.findIndex((task) => task.id === targetId)
  const insertionIndex = adjustedTargetIndex + (edge === 'after' ? 1 : 0)
  sameStatusTasks.splice(insertionIndex, 0, moved)

  let statusIndex = 0
  const reordered = tasks.map((task) =>
    task.done === source.done ? (sameStatusTasks[statusIndex++] ?? task) : task
  )

  return reordered.every((task, index) => task.id === tasks[index]?.id) ? tasks : reordered
}

// Trust boundary: clamp and coerce anything coming off disk or over IPC before it
// is stored or rendered, so a malformed/oversized payload can never corrupt state.
export function sanitizeProjectWorkspace(value: unknown): ProjectWorkspace {
  if (!value || typeof value !== 'object') return emptyProjectWorkspace()
  const record = value as Record<string, unknown>
  const notes = typeof record.notes === 'string' ? record.notes.slice(0, MAX_NOTES_LENGTH) : ''

  const rawTasks = Array.isArray(record.tasks) ? record.tasks : []
  const tasks: ProjectTask[] = []
  for (const entry of rawTasks) {
    if (tasks.length >= MAX_TASKS) break
    if (!entry || typeof entry !== 'object') continue
    const task = entry as Record<string, unknown>
    if (typeof task.id !== 'string' || typeof task.text !== 'string') continue
    tasks.push({
      id: task.id,
      text: task.text.slice(0, MAX_TASK_TEXT_LENGTH),
      done: task.done === true,
      createdAt: typeof task.createdAt === 'number' ? task.createdAt : Date.now()
    })
  }

  return { notes, tasks }
}
