import { basename, resolve } from 'node:path'
import type { Workspace } from '@shared/workspaces'
import { canonicalProjectPath } from '../projects/project-identity'

// Pure helpers for the workspace store, kept free of electron imports so they can
// be unit tested. The project id scheme MUST match session-service.projectId
// (`<platform>:<resolved-lowercased-cwd>`) so an attached folder dedupes against a
// project that already has session history in the same directory.
export function normalizeWorkspacePath(path: string): string {
  return resolve(canonicalProjectPath(path))
}

export function workspaceKey(path: string): string {
  return normalizeWorkspacePath(path).toLowerCase()
}

export function workspaceProjectId(platform: string, path: string): string {
  return `${platform}:${workspaceKey(path)}`
}

export function createWorkspace(path: string, addedAtMs: number = Date.now()): Workspace {
  const normalized = normalizeWorkspacePath(path)
  return {
    id: workspaceKey(normalized),
    path: normalized,
    name: basename(normalized) || normalized,
    addedAtMs
  }
}

// Collapse duplicates by id, keeping the earliest attachment so re-attaching an
// existing folder never resets its position or loses its original timestamp.
export function dedupeWorkspaces(workspaces: Workspace[]): Workspace[] {
  const byId = new Map<string, Workspace>()
  for (const workspace of workspaces) {
    const existing = byId.get(workspace.id)
    if (!existing || workspace.addedAtMs < existing.addedAtMs) byId.set(workspace.id, workspace)
  }
  return [...byId.values()]
}

export function parseWorkspaces(raw: string): Workspace[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const workspaces: Workspace[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const path = (item as { path?: unknown }).path
    if (typeof path !== 'string' || !path.trim()) continue
    const rawAddedAt = (item as { addedAtMs?: unknown }).addedAtMs
    const addedAtMs = typeof rawAddedAt === 'number' && Number.isFinite(rawAddedAt) ? rawAddedAt : Date.now()
    workspaces.push(createWorkspace(path, addedAtMs))
  }
  return dedupeWorkspaces(workspaces)
}
