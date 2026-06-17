import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  emptyProjectWorkspace,
  isProjectWorkspaceEmpty,
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
    for (const [projectId, value] of Object.entries(rawProjects as Record<string, unknown>)) {
      const workspace = sanitizeProjectWorkspace(value)
      if (!isProjectWorkspaceEmpty(workspace)) projects[projectId] = workspace
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
  await writeFile(path, JSON.stringify(store, null, 2), 'utf-8')
}

export async function getProjectWorkspace(projectId: string): Promise<ProjectWorkspace> {
  if (typeof projectId !== 'string' || !projectId) return emptyProjectWorkspace()
  const store = await readStore()
  return store.projects[projectId] ?? emptyProjectWorkspace()
}

// Serialize read-modify-write so rapid saves (e.g. fast task toggles) can't race
// and drop each other's changes.
let writeChain: Promise<unknown> = Promise.resolve()

export async function saveProjectWorkspace(projectId: string, data: unknown): Promise<ProjectWorkspace> {
  if (typeof projectId !== 'string' || !projectId) return emptyProjectWorkspace()
  const clean = sanitizeProjectWorkspace(data)

  const result = writeChain.then(async () => {
    const store = await readStore()
    // Drop the entry entirely once a project has no notes and no tasks, so the
    // file doesn't accumulate empty shells.
    if (isProjectWorkspaceEmpty(clean)) delete store.projects[projectId]
    else store.projects[projectId] = clean
    await writeStore(store)
    return clean
  })

  writeChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}
