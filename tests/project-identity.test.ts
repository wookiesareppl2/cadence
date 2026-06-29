import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalProjectPath,
  legacyCadenceSiblingPath,
  stripAgentMetadataDir
} from '../src/main/projects/project-identity'

const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cadence-project-identity-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('legacyCadenceSiblingPath', () => {
  it('points legacy ai-dashboard folders at a sibling cadence folder', () => {
    const legacy = join('C:/Projects', 'ai-dashboard')
    const sibling = legacyCadenceSiblingPath(legacy)

    expect(sibling).not.toBeNull()
    expect(basename(sibling ?? '')).toBe('cadence')
  })

  it('ignores non-legacy project folders', () => {
    expect(legacyCadenceSiblingPath(join('C:/Projects', 'other-app'))).toBeNull()
  })
})

describe('canonicalProjectPath', () => {
  it('folds legacy ai-dashboard paths into a sibling Cadence repo', () => {
    const root = tempRoot()
    const legacy = join(root, 'ai-dashboard')
    const cadence = join(root, 'cadence')
    mkdirSync(cadence)
    writeFileSync(join(cadence, 'package.json'), JSON.stringify({ name: 'cadence' }), 'utf-8')

    expect(canonicalProjectPath(legacy)).toBe(cadence)
  })

  it('does not rewrite unrelated ai-dashboard folders', () => {
    const root = tempRoot()
    const legacy = join(root, 'ai-dashboard')

    expect(canonicalProjectPath(legacy)).toBe(legacy)
  })
})

describe('stripAgentMetadataDir', () => {
  const project = 'C:\\IDE Platforms\\Visual Studio Code\\Projects\\In Progress\\cadence'

  it('attributes a Windows .claude cwd to the parent project folder', () => {
    expect(stripAgentMetadataDir(`${project}\\.claude`)).toBe(project)
  })

  it('strips a deeper path inside .claude back to the project folder', () => {
    expect(stripAgentMetadataDir(`${project}\\.claude\\skills\\start`)).toBe(project)
  })

  it('also handles .codex', () => {
    expect(stripAgentMetadataDir(`${project}\\.codex`)).toBe(project)
  })

  it('handles POSIX (WSL) paths', () => {
    expect(stripAgentMetadataDir('/home/user/app/.claude')).toBe('/home/user/app')
    expect(stripAgentMetadataDir('/home/user/app/.codex/config')).toBe('/home/user/app')
  })

  it('leaves a normal project cwd untouched', () => {
    expect(stripAgentMetadataDir(project)).toBe(project)
    expect(stripAgentMetadataDir('/home/user/app')).toBe('/home/user/app')
  })

  it('does not strip a folder whose name merely contains "claude"', () => {
    const p = `${project}\\claude-tools`
    expect(stripAgentMetadataDir(p)).toBe(p)
  })
})
