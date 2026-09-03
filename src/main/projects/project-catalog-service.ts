import type { WebContents } from 'electron'
import { PLATFORM_IDS, type PlatformId } from '@shared/platform'
import type { ProjectCatalogEntry } from '@shared/project-catalog'
import { scanSessions } from '../sessions/session-scan'
import { listWorkspaces } from '../workspaces/workspace-service'
import { getProjectRoots } from './project-identity'
import { buildProjectCatalog, type ProjectCatalogSessionSet } from './project-catalog'

async function scanAvailableSessions(sender: WebContents): Promise<ProjectCatalogSessionSet[]> {
  return Promise.all(
    PLATFORM_IDS.map(async (platform): Promise<ProjectCatalogSessionSet> => {
      try {
        return { platform, sessions: await scanSessions(platform, sender) }
      } catch {
        // One unavailable provider must not hide folders discovered through the
        // other providers.
        return { platform, sessions: [] }
      }
    })
  )
}

export async function listProjectCatalog(
  targetPlatform: PlatformId,
  sender: WebContents
): Promise<ProjectCatalogEntry[]> {
  const [sessionSets, workspaces] = await Promise.all([scanAvailableSessions(sender), listWorkspaces()])

  return buildProjectCatalog({
    targetPlatform,
    sessionSets,
    workspaces,
    projectRoots: getProjectRoots()
  })
}
