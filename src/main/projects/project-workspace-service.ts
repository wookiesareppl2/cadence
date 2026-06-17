import { app } from 'electron'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  emptyProjectWorkspace,
  isProjectWorkspaceEmpty,
  projectWorkspaceKey,
  sanitizeProjectWorkspace,
  type ProjectWorkspace
} from '@shared/project-workspace'

// One JSON file holds every project's notes/tasks, keyed by projectId. Lives in
// userData alongside session-metadata.json — never inside the CLIs' own dirs.
type WorkspaceStore = { version: 1; projects: Record<string, ProjectWorkspace> }

function storePath(): string {
  return join(app.getPath('userData'), 'project-workspace.json')
}

function emptyStore(): WorkspaceStore {
  return { version: 1, projects: {} }
}

// Combine two workspaces that collapsed onto the same directory key (e.g. legacy
// claude:/codex: entries for the same folder): union the tasks (dedupe by id) and
// join the notes. Re-sanitized to keep within caps.
function mergeWorkspaces(a: ProjectWorkspace, b: ProjectWorkspace): ProjectWorkspace {
  const seen = new Set(a.tasks.map((task) => task.id))
  const tasks = [...a.tasks, ...b.tasks.filter((task) => !seen.has(task.id))]
  const notes = a.notes && b.notes ? `${a.notes}\n\n${b.notes}` : a.notes || b.notes
  return sanitizeProjectWorkspace({ notes, tasks })
}

function parseStore(raw: string): WorkspaceStore {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyStore()
  }
  if (!parsed || typeof parsed !== 'object') return emptyStore()

  const projects: Record<string, ProjectWorkspace> = {}
  const rawProjects = (parsed as Record<string, unknown>).projects
  if (rawProjects && typeof rawProjects === 'object') {
    for (const [storedKey, value] of Object.entries(rawProjects as Record<string, unknown>)) {
      const workspace = sanitizeProjectWorkspace(value)
      if (isProjectWorkspaceEmpty(workspace)) continue
      // Migrate legacy platform-prefixed keys (claude:/codex:) onto the shared
      // directory key so data created before notes/tasks were unified across AI
      // models still loads. If both models had data for the same folder, merge.
      const key = projectWorkspaceKey(storedKey)
      projects[key] = projects[key] ? mergeWorkspaces(projects[key], workspace) : workspace
    }
  }
  return { version: 1, projects }
}

async function readStore(): Promise<WorkspaceStore> {
  try {
    return parseStore(await readFile(storePath(), 'utf-8'))
  } catch {
    return emptyStore()
  }
}

async function writeStore(store: WorkspaceStore): Promise<void> {
  const path = storePath()
  await mkdir(dirname(path), { recursive: true })
  // Keep the previous file as a one-step backup before overwriting, so a bad write
  // (e.g. an accidental empty) is always recoverable from project-workspace.json.bak.
  await copyFile(path, `${path}.bak`).catch(() => undefined)
  await writeFile(path, JSON.stringify(store, null, 2), 'utf-8')
}

export async function getProjectWorkspace(projectId: string): Promise<ProjectWorkspace> {
  if (typeof projectId !== 'string' || !projectId) return emptyProjectWorkspace()
  const key = projectWorkspaceKey(projectId)
  const store = await readStore()
  return store.projects[key] ?? emptyProjectWorkspace()
}

// Serialize read-modify-write so rapid saves (e.g. fast task toggles) can't race
// and drop each other's changes.
let writeChain: Promise<unknown> = Promise.resolve()

export async function saveProjectWorkspace(projectId: string, data: unknown): Promise<ProjectWorkspace> {
  if (typeof projectId !== 'string' || !projectId) return emptyProjectWorkspace()
  const key = projectWorkspaceKey(projectId)
  const clean = sanitizeProjectWorkspace(data)

  const result = writeChain.then(async () => {
    const store = await readStore()
    // Drop the entry entirely once a project has no notes and no tasks, so the
    // file doesn't accumulate empty shells.
    if (isProjectWorkspaceEmpty(clean)) delete store.projects[key]
    else store.projects[key] = clean
    await writeStore(store)
    return clean
  })

  writeChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}
