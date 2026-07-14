import { describe, expect, it } from 'vitest'
import type { PlatformId } from '../src/shared/platform'
import type { AssistantSession, SessionOrigin } from '../src/shared/sessions'
import { WINDOWS_ORIGIN } from '../src/shared/sessions'
import { buildProjectCatalog } from '../src/main/projects/project-catalog'
import { createWorkspace, workspaceProjectId } from '../src/main/workspaces/workspace-utils'

function session(
  platform: PlatformId,
  path: string,
  overrides: Partial<AssistantSession> = {}
): AssistantSession {
  const origin = overrides.origin ?? WINDOWS_ORIGIN
  return {
    id: `${platform}-session`,
    platform,
    projectId: `${platform}:source-id`,
    title: 'Session',
    rawTitle: null,
    inferredTitle: null,
    generatedTitle: null,
    titleSource: 'fallback',
    titleStatus: null,
    titleUpdatedAt: null,
    project: 'cadence',
    projectPath: path,
    branch: 'master',
    origin,
    usageLabel: null,
    status: 'local',
    age: '2m ago',
    updatedAt: '2026-07-14T00:00:00.000Z',
    model: null,
    contextTokens: null,
    contextWindow: null,
    ...overrides
  }
}

describe('buildProjectCatalog', () => {
  it('makes a Windows project known only to Claude available to OpenCode', () => {
    const path = 'C:\\Projects\\cadence'
    const catalog = buildProjectCatalog({
      targetPlatform: 'opencode',
      sessionSets: [
        { platform: 'claude', sessions: [session('claude', path)] },
        { platform: 'opencode', sessions: [] }
      ],
      workspaces: [],
      openCodeDistro: 'Ubuntu'
    })

    expect(catalog).toEqual([
      expect.objectContaining({
        id: workspaceProjectId('opencode', path),
        platform: 'opencode',
        path,
        source: 'provider'
      })
    ])
  })

  it('uses the newest provider session as the catalog display source', () => {
    const path = 'C:\\Projects\\cadence'
    const catalog = buildProjectCatalog({
      targetPlatform: 'opencode',
      sessionSets: [
        {
          platform: 'claude',
          sessions: [session('claude', path, { project: 'old-name', updatedAt: '2026-07-13T00:00:00.000Z' })]
        },
        {
          platform: 'codex',
          sessions: [session('codex', path, { project: 'new-name', updatedAt: '2026-07-14T00:00:00.000Z' })]
        }
      ],
      workspaces: [],
      openCodeDistro: 'Ubuntu'
    })

    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.name).toBe('new-name')
  })

  it('keeps an explicit attachment detachable when providers also know the folder', () => {
    const path = 'C:\\Projects\\cadence'
    const workspace = createWorkspace(path, Date.parse('2026-07-01T00:00:00.000Z'))
    const catalog = buildProjectCatalog({
      targetPlatform: 'opencode',
      sessionSets: [{ platform: 'claude', sessions: [session('claude', workspace.path)] }],
      workspaces: [workspace],
      openCodeDistro: 'Ubuntu'
    })

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toEqual(expect.objectContaining({ source: 'attached', name: workspace.name }))
  })

  it("only offers WSL projects that belong to OpenCode's configured distro", () => {
    const ubuntu: SessionOrigin = {
      id: 'wsl:Ubuntu',
      kind: 'wsl',
      label: 'Ubuntu',
      distro: 'Ubuntu'
    }
    const debian: SessionOrigin = {
      id: 'wsl:Debian',
      kind: 'wsl',
      label: 'Debian',
      distro: 'Debian'
    }
    const catalog = buildProjectCatalog({
      targetPlatform: 'opencode',
      sessionSets: [
        {
          platform: 'claude',
          sessions: [
            session('claude', '/home/user/ubuntu-app', { origin: ubuntu, project: 'ubuntu-app' }),
            session('claude', '/home/user/debian-app', { origin: debian, project: 'debian-app' })
          ]
        }
      ],
      workspaces: [],
      openCodeDistro: 'Ubuntu'
    })

    expect(catalog.map((entry) => entry.name)).toEqual(['ubuntu-app'])
    expect(catalog[0]?.id).toBe('opencode:wsl:Ubuntu:/home/user/ubuntu-app')
  })
})
