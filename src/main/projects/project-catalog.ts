import { posix, win32 } from 'node:path'
import type { PlatformId } from '@shared/platform'
import type { ProjectCatalogEntry } from '@shared/project-catalog'
import type { AssistantSession, SessionOrigin } from '@shared/sessions'
import type { Workspace } from '@shared/workspaces'
import { workspaceProjectId } from '../workspaces/workspace-utils'

export type ProjectCatalogSessionSet = {
  platform: PlatformId
  sessions: AssistantSession[]
}

type BuildProjectCatalogOptions = {
  targetPlatform: PlatformId
  sessionSets: ProjectCatalogSessionSet[]
  workspaces: Workspace[]
  openCodeDistro?: string | null
}

function catalogProjectId(platform: PlatformId, path: string, origin: SessionOrigin): string {
  if (origin.kind === 'windows') return workspaceProjectId(platform, path)
  return `${platform}:${origin.id}:${path.replace(/\\/g, '/').toLowerCase()}`
}

function projectName(session: AssistantSession): string {
  if (session.project) return session.project
  return session.origin.kind === 'wsl'
    ? posix.basename(session.projectPath ?? '') || session.projectPath || 'Unavailable'
    : win32.basename(session.projectPath ?? '') || session.projectPath || 'Unavailable'
}

function timestamp(value: string | null): number {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function isUsableInTarget(
  targetPlatform: PlatformId,
  origin: SessionOrigin,
  openCodeDistro: string | null | undefined
): boolean {
  // Managed OpenCode always runs in its configured distro. A POSIX folder from a
  // different distro could point at an unrelated or nonexistent path there.
  if (targetPlatform === 'opencode' && origin.kind === 'wsl') {
    return Boolean(openCodeDistro && origin.distro === openCodeDistro)
  }
  return true
}

export function buildProjectCatalog({
  targetPlatform,
  sessionSets,
  workspaces,
  openCodeDistro
}: BuildProjectCatalogOptions): ProjectCatalogEntry[] {
  const byId = new Map<string, ProjectCatalogEntry>()

  for (const { sessions } of sessionSets) {
    for (const session of sessions) {
      const path = session.projectPath?.trim()
      if (!path || !isUsableInTarget(targetPlatform, session.origin, openCodeDistro)) continue

      const id = catalogProjectId(targetPlatform, path, session.origin)
      const existing = byId.get(id)
      if (existing && timestamp(existing.latestUpdatedAt) >= timestamp(session.updatedAt)) continue

      byId.set(id, {
        id,
        platform: targetPlatform,
        name: projectName(session),
        path,
        branch: session.branch,
        origin: session.origin,
        latestUpdatedAt: session.updatedAt,
        age: session.age,
        source: 'provider'
      })
    }
  }

  // A manual attachment wins over a discovered entry for the same Windows
  // folder. That preserves the user's ability to explicitly detach it later.
  for (const workspace of workspaces) {
    const id = workspaceProjectId(targetPlatform, workspace.path)
    const existing = byId.get(id)
    byId.set(id, {
      id,
      platform: targetPlatform,
      name: workspace.name,
      path: workspace.path,
      branch: existing?.branch ?? null,
      origin: { id: 'windows', kind: 'windows', label: 'Windows', distro: null },
      latestUpdatedAt: existing?.latestUpdatedAt ?? new Date(workspace.addedAtMs).toISOString(),
      age: existing?.age ?? 'attached',
      source: 'attached'
    })
  }

  return [...byId.values()].sort(
    (a, b) => timestamp(b.latestUpdatedAt) - timestamp(a.latestUpdatedAt)
  )
}
