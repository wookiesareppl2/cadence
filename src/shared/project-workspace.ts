// Per-project notes and tasks. Anchored to a projectId (never a session) so they
// persist across every session in that project. Stored in the app's userData dir,
// never inside ~/.claude or ~/.codex.

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

export const MAX_NOTES_LENGTH = 100_000
export const MAX_TASKS = 500
export const MAX_TASK_TEXT_LENGTH = 2_000

export function emptyProjectWorkspace(): ProjectWorkspace {
  return { notes: '', tasks: [] }
}

export function isProjectWorkspaceEmpty(workspace: ProjectWorkspace): boolean {
  return workspace.notes.trim().length === 0 && workspace.tasks.length === 0
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
