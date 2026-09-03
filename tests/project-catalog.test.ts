import { describe, expect, it } from 'vitest'
import type { PlatformId } from '../src/shared/platform'
import type { AssistantSession, SessionOrigin } from '../src/shared/sessions'
import { WINDOWS_ORIGIN } from '../src/shared/sessions'
import { buildProjectCatalog } from '../src/main/projects/project-catalog'
import { createWorkspace, workspaceProjectId } from '../src/main/workspaces/workspace-utils'
import { makeProjectRoot } from '../src/shared/project-roots'

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
  it('makes a Windows project known only to Claude available to Codex', () => {
    const path = 'C:\\Projects\\cadence'
    const catalog = buildProjectCatalog({
      targetPlatform: 'codex',
      sessionSets: [
        { platform: 'claude', sessions: [session('claude', path)] },
        { platform: 'codex', sessions: [] }
      ],
      workspaces: []
    })

    expect(catalog).toEqual([
      expect.objectContaining({
        id: workspaceProjectId('codex', path),
        platform: 'codex',
        path,
        source: 'provider'
      })
    ])
  })

  it('uses the newest provider session as the catalog display source', () => {
    const path = 'C:\\Projects\\cadence'
    const catalog = buildProjectCatalog({
      targetPlatform: 'claude',
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
      workspaces: []
    })

    expect(catalog).toHaveLength(1)
    expect(catalog[0]?.name).toBe('new-name')
  })

  it('keeps an explicit attachment detachable when providers also know the folder', () => {
    const path = 'C:\\Projects\\cadence'
    const workspace = createWorkspace(path, Date.parse('2026-07-01T00:00:00.000Z'))
    const catalog = buildProjectCatalog({
      targetPlatform: 'codex',
      sessionSets: [{ platform: 'claude', sessions: [session('claude', workspace.path)] }],
      workspaces: [workspace]
    })

    expect(catalog).toHaveLength(1)
    expect(catalog[0]).toEqual(expect.objectContaining({ source: 'attached', name: workspace.name }))
  })

  // A POSIX path is only meaningful inside the distro that produced it, so the
  // catalog id keys on the origin rather than the bare path — two distros can
  // hold the same path and must stay distinct entries.
  it('keys a WSL project by its originating distro', () => {
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
      targetPlatform: 'codex',
      sessionSets: [
        {
          platform: 'claude',
          sessions: [
            session('claude', '/home/user/app', { origin: ubuntu, project: 'ubuntu-app' }),
            session('claude', '/home/user/app', { origin: debian, project: 'debian-app' })
          ]
        }
      ],
      workspaces: []
    })

    expect(catalog.map((entry) => entry.id).sort()).toEqual([
      'codex:wsl:Debian:/home/user/app',
      'codex:wsl:Ubuntu:/home/user/app'
    ])
  })
})

// Project roots are what stop every folder an AI tool has ever run in from becoming
// a permanent entry. The catalog is one of the two places that has to honour them;
// the renderer's session-derived list is the other, and both ask the same shared
// question so they cannot drift apart.
describe('buildProjectCatalog with project roots', () => {
  const SEPARATOR = String.fromCharCode(92)
  const codeRoot = 'C:' + SEPARATOR + 'Code'
  const inside = codeRoot + SEPARATOR + 'cadence'
  const outside = 'C:' + SEPARATOR + 'Users' + SEPARATOR + 'sheldon' + SEPARATOR + 'Downloads'
  const roots = [makeProjectRoot(codeRoot, null)]

  const build = (sessions: AssistantSession[], projectRoots = roots, workspaces = []) =>
    buildProjectCatalog({
      targetPlatform: 'claude',
      sessionSets: [{ platform: 'claude', sessions }],
      workspaces,
      projectRoots
    })

  it('keeps a discovered folder inside a root', () => {
    expect(build([session('claude', inside)].map((entry) => entry)).map((entry) => entry.path)).toEqual([
      inside
    ])
  })

  it('drops a discovered folder outside every root', () => {
    expect(build([session('claude', outside)])).toEqual([])
  })

  // The safe default: an app that has never been configured must behave as before.
  it('keeps everything when no roots are configured', () => {
    const entries = build([session('claude', inside), session('claude', outside)], [])
    expect(entries).toHaveLength(2)
  })

  // Attaching a folder is an explicit act. Hiding it because a root was added later
  // would silently discard a choice the user made by hand, with no way to see it.
  it('always lists a hand-attached folder, even from outside the roots', () => {
    const workspace = createWorkspace(outside)
    const entries = buildProjectCatalog({
      targetPlatform: 'claude',
      sessionSets: [{ platform: 'claude', sessions: [] }],
      workspaces: [workspace],
      projectRoots: roots
    })
    expect(entries.map((entry) => entry.source)).toEqual(['attached'])
  })

  it('does not let a WSL root admit a Windows folder of the same name', () => {
    const wslRoots = [makeProjectRoot('/home/sheldon/code', 'Ubuntu')]
    expect(build([session('claude', inside)], wslRoots)).toEqual([])
  })
})
