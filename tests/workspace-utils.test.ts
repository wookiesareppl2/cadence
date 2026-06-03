import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createWorkspace,
  dedupeWorkspaces,
  parseWorkspaces,
  workspaceProjectId
} from '../src/main/workspaces/workspace-utils'

describe('createWorkspace', () => {
  it('normalizes the path and derives a name and case-insensitive id', () => {
    const ws = createWorkspace('C:/Projects/ai-dashboard/', 1000)
    expect(ws.path).toBe(resolve('C:/Projects/ai-dashboard/'))
    expect(ws.name).toBe('ai-dashboard')
    expect(ws.id).toBe(ws.path.toLowerCase())
    expect(ws.addedAtMs).toBe(1000)
  })
})

describe('workspaceProjectId', () => {
  it('matches the <platform>:<resolved-lowercased-cwd> scheme used for sessions', () => {
    const id = workspaceProjectId('codex', 'C:/Projects/ai-dashboard')
    expect(id).toBe(`codex:${resolve('C:/Projects/ai-dashboard').toLowerCase()}`)
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
})
