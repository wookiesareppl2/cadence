import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  listVaultAreas,
  proposeMemoryHome
} from '../src/main/vault-save/resolve-memory-route.mjs'

// A hardcoded default area silently filed a client project under personal
// projects on its first save, and nothing surfaced the choice. The vault's shape
// also changes over time — areas get added, renamed, reorganised — so any
// constant is wrong eventually. The resolver must therefore enumerate what
// exists and propose nothing.

const AREAS = [
  '00 - Inbox',
  '01 - Daily Notes',
  '03 - On a Digital Note',
  '04 - Personal Projects'
]

function fakeVault(entries: string[]) {
  return {
    readdir: () => entries,
    isDirectory: (path: string) => !path.endsWith('.md')
  }
}

describe('vault area enumeration', () => {
  it('lists the areas that actually exist, sorted', () => {
    expect(listVaultAreas('/vault', fakeVault([...AREAS].reverse()))).toEqual(AREAS)
  })

  it('picks up an area added after the code shipped', () => {
    const areas = listVaultAreas('/vault', fakeVault([...AREAS, '08 - New Client']))
    expect(areas).toContain('08 - New Client')
  })

  it('ignores files and dotfolders', () => {
    const areas = listVaultAreas('/vault', fakeVault([...AREAS, 'VAULT-INDEX.md', '.obsidian']))
    expect(areas).toEqual(AREAS)
  })

  it('returns nothing rather than guessing when the vault is unreadable', () => {
    expect(listVaultAreas('/vault', { readdir: () => { throw new Error('ENOENT') }, isDirectory: () => true })).toEqual([])
    expect(listVaultAreas(null as unknown as string)).toEqual([])
  })
})

describe('memory home composition', () => {
  it('composes a home once an area has been chosen', () => {
    expect(proposeMemoryHome('/vault', 'oadn-project-planner', '03 - On a Digital Note')).toBe(
      join('/vault', '03 - On a Digital Note', 'oadn-project-planner', 'memory')
    )
  })

  // The load-bearing assertion: without an explicit area there is no fallback,
  // so a caller that forgets to ask gets null instead of a plausible wrong path.
  it('refuses to compose a home when no area was chosen', () => {
    expect(proposeMemoryHome('/vault', 'oadn-project-planner', undefined)).toBeNull()
    expect(proposeMemoryHome('/vault', 'oadn-project-planner', '')).toBeNull()
  })

  it('refuses when the vault root or project name is missing', () => {
    expect(proposeMemoryHome(null, 'p', '04 - Personal Projects')).toBeNull()
    expect(proposeMemoryHome('/vault', null, '04 - Personal Projects')).toBeNull()
  })
})
