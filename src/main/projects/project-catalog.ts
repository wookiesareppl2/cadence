import { posix, win32 } from 'node:path'
import type { PlatformId } from '@shared/platform'
import type { ProjectCatalogEntry } from '@shared/project-catalog'
import type { AssistantSession, SessionOrigin } from '@shared/sessions'
import type { Workspace } from '@shared/workspaces'
import { isInsideProjectRoots, type ProjectRoot } from '@shared/project-roots'
import { workspaceProjectId } from '../workspaces/workspace-utils'

export type ProjectCatalogSessionSet = {
  platform: PlatformId
  sessions: AssistantSession[]
}

type BuildProjectCatalogOptions = {
  targetPlatform: PlatformId
  sessionSets: ProjectCatalogSessionSet[]
  workspaces: Workspace[]
  // The folders the user's projects live in. Empty means unconfigured, and nothing
  // is filtered — passed in rather than read from a module so this stays pure.
  projectRoots?: ProjectRoot[]
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

export function buildProjectCatalog({
  targetPlatform,
  sessionSets,
  workspaces,
  projectRoots = []
}: BuildProjectCatalogOptions): ProjectCatalogEntry[] {
  const byId = new Map<string, ProjectCatalogEntry>()

  for (const { sessions } of sessionSets) {
    for (const session of sessions) {
      const path = session.projectPath?.trim()
      if (!path) continue
      // Discovered folders outside the configured roots are not projects the user
      // wants listed — that is the whole point of naming the roots.
      if (!isInsideProjectRoots(path, session.origin.distro, projectRoots)) continue

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

  // A manual attachment wins over a discovered entry for the same Windows folder.
  // That preserves the user's ability to explicitly detach it later.
  //
  // Attachments are deliberately NOT filtered by the roots. Attaching a folder is an
  // explicit act; hiding it because it sits outside a root would silently discard a
  // choice the user made by hand, and leave them no way to see it again.
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
