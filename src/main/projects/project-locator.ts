import type { PlatformId } from '@shared/platform'
import type { AssistantSession } from '@shared/sessions'
import { applyProjectAlias } from '@shared/session-metadata'
import { scanSessions } from '../sessions/session-scan'
import { getSessionMetadata } from '../sessions/session-metadata-service'
import { listWorkspaces } from '../workspaces/workspace-service'
import type { WebContents } from 'electron'

// A project grouped from its sessions: display name + the folder it lives in
// (POSIX path + WSL distro, or a native Windows path) + its sessions.
export type ProjectGroup = {
  id: string
  name: string
  path: string | null
  distro: string | null
  sessions: AssistantSession[]
}

// A resolved on-disk location for a project (path guaranteed non-null).
export type ProjectLocation = {
  id: string
  name: string
  path: string
  distro: string | null
  sessions: AssistantSession[]
}

// The session's resolved project name, with a platform-specific fallback when it
// has none. Mirrors the renderer's projectLabel (use-session-browser.ts).
function projectLabel(session: AssistantSession): string {
  if (session.project) return session.project
  return session.platform === 'codex' ? 'Unindexed' : 'Unavailable'
}

export function groupProjects(
  sessions: AssistantSession[],
  projectAliases: Record<string, string>
): Map<string, ProjectGroup> {
  const byProject = new Map<string, ProjectGroup>()
  for (const session of sessions) {
    let group = byProject.get(session.projectId)
    if (!group) {
      group = {
        id: session.projectId,
        name: applyProjectAlias(projectLabel(session), session.projectId, projectAliases),
        path: session.projectPath,
        distro: session.origin.distro,
        sessions: []
      }
      byProject.set(session.projectId, group)
    }
    group.sessions.push(session)
    if (!group.path && session.projectPath) {
      group.path = session.projectPath
      group.distro = session.origin.distro
    }
  }
  return byProject
}

// Resolve a projectId to a concrete folder. Prefer a session-backed group (it
// carries the path + WSL distro); fall back to an attached-but-empty workspace,
// which is always a native Windows path. Returns null when nothing resolves.
export async function resolveLocation(
  projectId: string | null,
  groups: Map<string, ProjectGroup>,
  platform: PlatformId,
  projectAliases: Record<string, string> = {}
): Promise<ProjectLocation | null> {
  if (!projectId) return null
  const group = groups.get(projectId)
  if (group?.path) {
    return { id: group.id, name: group.name, path: group.path, distro: group.distro, sessions: group.sessions }
  }

  for (const workspace of await listWorkspaces()) {
    if (`${platform}:${workspace.path.toLowerCase()}` === projectId) {
      return {
        id: projectId,
        name: applyProjectAlias(workspace.name, projectId, projectAliases),
        path: workspace.path,
        distro: null,
        sessions: group?.sessions ?? []
      }
    }
  }
  return null
}

// Convenience one-shot used by callers that don't already have a session scan in
// hand (e.g. the memory viewer). Scans (warm cache), groups, and resolves.
export async function resolveProjectLocation(
  platform: PlatformId,
  projectId: string | null,
  sender: WebContents
): Promise<ProjectLocation | null> {
  if (!projectId) return null
  const [sessions, metadata] = await Promise.all([scanSessions(platform, sender), getSessionMetadata()])
  const groups = groupProjects(sessions, metadata.projectAliases)
  return resolveLocation(projectId, groups, platform, metadata.projectAliases)
}
