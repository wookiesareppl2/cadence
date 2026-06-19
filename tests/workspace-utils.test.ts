import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createWorkspace,
  dedupeWorkspaces,
  parseWorkspaces,
  workspaceProjectId
} from '../src/main/workspaces/workspace-utils'

const tempRoots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'cadence-workspace-utils-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe('createWorkspace', () => {
  it('normalizes the path and derives a name and case-insensitive id', () => {
    const ws = createWorkspace('C:/Projects/cadence/', 1000)
    expect(ws.path).toBe(resolve('C:/Projects/cadence/'))
    expect(ws.name).toBe('cadence')
    expect(ws.id).toBe(ws.path.toLowerCase())
    expect(ws.addedAtMs).toBe(1000)
  })
})

describe('workspaceProjectId', () => {
  it('matches the <platform>:<resolved-lowercased-cwd> scheme used for sessions', () => {
    const id = workspaceProjectId('codex', 'C:/Projects/cadence')
    expect(id).toBe(`codex:${resolve('C:/Projects/cadence').toLowerCase()}`)
  })
})

describe('dedupeWorkspaces', () => {
  it('collapses duplicates by id, keeping the earliest attachment', () => {
    const early = createWorkspace('C:/Projects/app', 100)
    const late = createWorkspace('C:/Projects/app', 500)
    const other = createWorkspace('C:/Projects/other', 200)

    const result = dedupeWorkspaces([late, early, other])
    expect(result).toHaveLength(2)
    expect(result.find((w) => w.id === early.id)?.addedAtMs).toBe(100)
  })
})

describe('parseWorkspaces', () => {
  it('reads valid entries and ignores malformed ones', () => {
    const raw = JSON.stringify([
      { path: 'C:/Projects/a', addedAtMs: 10 },
      { path: '   ' },
      { notAPath: true },
      'garbage',
      { path: 'C:/Projects/b' }
    ])
    const result = parseWorkspaces(raw)
    expect(result.map((w) => w.name).sort()).toEqual(['a', 'b'])
  })

  it('returns an empty list for non-array or invalid JSON', () => {
    expect(parseWorkspaces('not json')).toEqual([])
    expect(parseWorkspaces('{"path":"x"}')).toEqual([])
  })

  it('dedupes persisted entries pointing at the same folder', () => {
    const raw = JSON.stringify([
      { path: 'C:/Projects/app', addedAtMs: 100 },
      { path: 'C:/Projects/APP', addedAtMs: 200 }
    ])
    expect(parseWorkspaces(raw)).toHaveLength(1)
  })

  it('canonicalizes attached legacy ai-dashboard workspaces to Cadence when a sibling repo exists', () => {
    const root = tempRoot()
    const cadence = resolve(root, 'cadence')
    mkdirSync(cadence)
    writeFileSync(resolve(cadence, 'package.json'), JSON.stringify({ name: 'cadence' }), 'utf-8')

    const result = parseWorkspaces(JSON.stringify([{ path: resolve(root, 'ai-dashboard'), addedAtMs: 100 }]))

    expect(result).toHaveLength(1)
    expect(result[0]?.path).toBe(cadence)
    expect(result[0]?.name).toBe('cadence')
  })
})
