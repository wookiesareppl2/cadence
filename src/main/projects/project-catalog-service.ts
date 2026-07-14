import type { WebContents } from 'electron'
import { PLATFORM_IDS, type PlatformId } from '@shared/platform'
import type { ProjectCatalogEntry } from '@shared/project-catalog'
import { detectOpenCodeRuntime } from '../opencode/opencode-runtime'
import { scanSessions } from '../sessions/session-scan'
import { listWorkspaces } from '../workspaces/workspace-service'
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
  const [sessionSets, workspaces, openCodeRuntime] = await Promise.all([
    scanAvailableSessions(sender),
    listWorkspaces(),
    targetPlatform === 'opencode' ? detectOpenCodeRuntime().catch(() => null) : Promise.resolve(null)
  ])

  return buildProjectCatalog({
    targetPlatform,
    sessionSets,
    workspaces,
    openCodeDistro: openCodeRuntime?.distro ?? null
  })
}
