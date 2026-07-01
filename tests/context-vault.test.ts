import { describe, expect, it } from 'vitest'
import {
  computeVaultStatus,
  detectDivergence,
  emptyVaultIndex,
  generateVaultProjectId,
  gitHubVaultKey,
  localContextChanged,
  resolveVaultProjectId,
  suggestVaultLink,
  upsertVaultIndexEntry,
  vaultEntryLabel,
  type VaultIndex
} from '../src/shared/context-vault'

describe('gitHubVaultKey', () => {
  it('is device-independent and case/`.git`-normalised', () => {
    expect(gitHubVaultKey('WookiesArePpl2', 'Cadence.git')).toBe('github.com__wookiesareppl2__cadence')
    // Same repo, different local anything → identical key on every device.
    expect(gitHubVaultKey('wookiesareppl2', 'cadence')).toBe(gitHubVaultKey('WookiesArePpl2', 'CADENCE'))
  })
})

describe('resolveVaultProjectId', () => {
  it('prefers the GitHub key when a remote exists', () => {
    expect(resolveVaultProjectId({ gitHubKey: 'github.com__me__proj', linkedId: 'local__x' })).toEqual({
      id: 'github.com__me__proj',
      source: 'github'
    })
  })

  it('falls back to a locally-linked id for non-GitHub projects', () => {
    expect(resolveVaultProjectId({ linkedId: 'local__abc' })).toEqual({ id: 'local__abc', source: 'linked' })
  })

  it('reports unlinked when neither is available', () => {
    expect(resolveVaultProjectId({})).toEqual({ id: null, source: 'unlinked' })
    expect(resolveVaultProjectId({ gitHubKey: '  ', linkedId: '' })).toEqual({ id: null, source: 'unlinked' })
  })
})

describe('generateVaultProjectId', () => {
  it('generates unique, namespaced ids', () => {
    const a = generateVaultProjectId()
    const b = generateVaultProjectId()
    expect(a).not.toBe(b)
    expect(a.startsWith('local__')).toBe(true)
  })
})

describe('vault index', () => {
  it('upserts by id and keeps newest-synced first', () => {
    let index: VaultIndex = emptyVaultIndex()
    index = upsertVaultIndexEntry(index, { id: 'a', label: 'A', sourcePathHint: null, lastSyncedAt: '2026-07-01T01:00:00Z' })
    index = upsertVaultIndexEntry(index, { id: 'b', label: 'B', sourcePathHint: null, lastSyncedAt: '2026-07-01T03:00:00Z' })
    // Update 'a' to be the newest — it should move to the front and not duplicate.
    index = upsertVaultIndexEntry(index, { id: 'a', label: 'A', sourcePathHint: null, lastSyncedAt: '2026-07-01T05:00:00Z' })
    expect(index.entries.map((e) => e.id)).toEqual(['a', 'b'])
    expect(index.entries).toHaveLength(2)
  })

  it('suggests a link by id first, then by label', () => {
    let index: VaultIndex = emptyVaultIndex()
    index = upsertVaultIndexEntry(index, { id: 'local__1', label: 'control room', sourcePathHint: null, lastSyncedAt: null })
    expect(suggestVaultLink(index, { id: 'local__1', projectName: 'whatever' })?.id).toBe('local__1')
    expect(suggestVaultLink(index, { projectName: 'Control Room' })?.id).toBe('local__1')
    expect(suggestVaultLink(index, { projectName: 'unrelated' })).toBeNull()
  })
})

describe('detectDivergence (drift safety)', () => {
  const D = (base: string | null, remoteLatest: string | null, localChanged: boolean) =>
    detectDivergence({ base, remoteLatest, localChanged })

  it('reports uninitialized when nothing exists anywhere', () => {
    expect(D(null, null, false)).toBe('uninitialized')
  })

  it('reports in-sync / local-ahead when the base matches the remote', () => {
    expect(D('s1', 's1', false)).toBe('in-sync')
    expect(D('s1', 's1', true)).toBe('local-ahead')
  })

  it('reports remote-ahead only when local is unchanged', () => {
    expect(D('s1', 's2', false)).toBe('remote-ahead')
    expect(D(null, 's2', false)).toBe('remote-ahead')
  })

  it('reports CONFLICT when both diverged — never a silent overwrite', () => {
    expect(D('s1', 's2', true)).toBe('conflict')
    // Never synced on this device, but there is a remote AND unsaved local edits.
    expect(D(null, 's2', true)).toBe('conflict')
  })

  it('treats an empty remote with a local base as local-ahead', () => {
    expect(D('s1', null, false)).toBe('local-ahead')
  })
})

describe('localContextChanged', () => {
  it('counts any local content as changed when there is no base', () => {
    expect(localContextChanged(null, '')).toBe(false)
    expect(localContextChanged(null, 'deadbeef')).toBe(true)
  })
  it('compares fingerprints when a base exists', () => {
    expect(localContextChanged('abc', 'abc')).toBe(false)
    expect(localContextChanged('abc', 'xyz')).toBe(true)
  })
})

describe('computeVaultStatus', () => {
  it('is uninitialized when nothing exists anywhere', () => {
    expect(computeVaultStatus({ base: null, baseFingerprint: null, localFingerprint: '', remoteLatest: null })).toBe(
      'uninitialized'
    )
  })
  it('is in-sync when base matches remote and content is unchanged', () => {
    expect(computeVaultStatus({ base: 's1', baseFingerprint: 'fp', localFingerprint: 'fp', remoteLatest: 's1' })).toBe(
      'in-sync'
    )
  })
  it('is local-ahead when only the local content changed', () => {
    expect(computeVaultStatus({ base: 's1', baseFingerprint: 'fp', localFingerprint: 'fp2', remoteLatest: 's1' })).toBe(
      'local-ahead'
    )
  })
  it('is remote-ahead when the vault advanced and local is unchanged', () => {
    expect(computeVaultStatus({ base: 's1', baseFingerprint: 'fp', localFingerprint: 'fp', remoteLatest: 's2' })).toBe(
      'remote-ahead'
    )
  })
  it('is conflict when both the vault advanced AND local changed', () => {
    expect(computeVaultStatus({ base: 's1', baseFingerprint: 'fp', localFingerprint: 'fp2', remoteLatest: 's2' })).toBe(
      'conflict'
    )
  })
})
