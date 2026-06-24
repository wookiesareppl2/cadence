import { app, dialog, type BrowserWindow } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Workspace } from '@shared/workspaces'
import { createWorkspace, dedupeWorkspaces, parseWorkspaces } from './workspace-utils'

function storePath(): string {
  return join(app.getPath('userData'), 'workspaces.json')
}

async function readStore(): Promise<Workspace[]> {
  try {
    return parseWorkspaces(await readFile(storePath(), 'utf-8'))
  } catch {
    return []
  }
}

async function writeStore(workspaces: Workspace[]): Promise<void> {
  const path = storePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(workspaces, null, 2), 'utf-8')
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const workspaces = await readStore()
  return workspaces.sort((a, b) => b.addedAtMs - a.addedAtMs)
}

// Detach an attached workspace by id (the lowercased, resolved path). Used when a
// project is deleted so an attached-but-empty project also disappears. A no-op if
// the id isn't an attached workspace (e.g. a pure session-backed project).
export async function removeWorkspace(id: string): Promise<void> {
  const workspaces = await readStore()
  const next = workspaces.filter((workspace) => workspace.id !== id)
  if (next.length !== workspaces.length) await writeStore(next)
}

export async function attachWorkspacePath(path: string): Promise<Workspace> {
  const workspace = createWorkspace(path)
  const existing = await readStore()
  await writeStore(dedupeWorkspaces([workspace, ...existing]))
  return workspace
}

export async function attachWorkspace(window: BrowserWindow | null): Promise<Workspace | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Attach Workspace',
    buttonLabel: 'Attach',
    // `createDirectory` lets the user make a new folder for a brand-new project
    // straight from the picker (macOS shows a button; Windows allows it inline).
    properties: ['openDirectory', 'createDirectory']
  }

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null

  return attachWorkspacePath(result.filePaths[0])
}
