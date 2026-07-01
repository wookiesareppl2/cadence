import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getVaultLink, readLinkStore, resolveProjectVaultId, setVaultLink } from '../src/main/context-vault/link-store'

describe('context vault link store', () => {
  let dir: string
  let storePath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cadence-vault-links-'))
    storePath = join(dir, 'context-vault-links.json')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads an empty store when the file is missing', async () => {
    expect(await readLinkStore(storePath)).toEqual({ version: 1, links: {} })
    expect(await getVaultLink(storePath, 'anything')).toBeNull()
  })

  it('round-trips a link', async () => {
    await setVaultLink(storePath, 'claude:c\\proj', {
      vaultId: 'local__abc',
      label: 'Proj',
      source: 'local',
      createdAt: '2026-07-01T00:00:00Z'
    })
    expect((await getVaultLink(storePath, 'claude:c\\proj'))?.vaultId).toBe('local__abc')
  })

  it('uses the GitHub key as the id when a remote exists', async () => {
    const r = await resolveProjectVaultId(storePath, {
      projectId: 'claude:c\\cadence',
      projectName: 'cadence',
      gitHubKey: 'github.com__me__cadence'
    })
    expect(r).toMatchObject({ id: 'github.com__me__cadence', source: 'github', created: false })
  })

  it('mints and persists a stable local id for a non-GitHub project', async () => {
    const first = await resolveProjectVaultId(storePath, { projectId: 'codex:c\\control-room', projectName: 'Control Room' })
    expect(first.source).toBe('local')
    expect(first.created).toBe(true)
    expect(first.id.startsWith('local__')).toBe(true)

    // Second resolution on the same device returns the SAME id (stable identity).
    const second = await resolveProjectVaultId(storePath, { projectId: 'codex:c\\control-room', projectName: 'Control Room' })
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
  })

  it('persists a readable JSON store', async () => {
    await resolveProjectVaultId(storePath, { projectId: 'p1', projectName: 'One' })
    const raw = JSON.parse(await readFile(storePath, 'utf-8'))
    expect(raw.version).toBe(1)
    expect(Object.keys(raw.links)).toContain('p1')
  })
})
