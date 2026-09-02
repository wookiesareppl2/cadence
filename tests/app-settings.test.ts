import { describe, expect, it } from 'vitest'
import {
  APP_SETTINGS_VERSION,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  normalizeAppSettingsUpdate
} from '../src/shared/app-settings'

describe('Cadence application settings', () => {
  it('ships merge review on, and falls back to that default for missing or malformed settings', () => {
    expect(DEFAULT_APP_SETTINGS.mergeReviewEnabled).toBe(true)
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS)
    expect(normalizeAppSettings({ mergeReviewEnabled: 'yes' })).toEqual(DEFAULT_APP_SETTINGS)
  })

  it('keeps an install that deliberately turned merge review off', () => {
    expect(normalizeAppSettings({ mergeReviewEnabled: false }).mergeReviewEnabled).toBe(false)
  })

  it('preserves a valid merge-review preference while normalizing the schema version', () => {
    expect(normalizeAppSettings({ version: 99, mergeReviewEnabled: true })).toEqual({
      version: APP_SETTINGS_VERSION,
      mergeReviewEnabled: true,
      projectRoots: []
    })
  })

  it('accepts only boolean setting updates', () => {
    expect(normalizeAppSettingsUpdate({ mergeReviewEnabled: true })).toEqual({ mergeReviewEnabled: true })
    expect(normalizeAppSettingsUpdate({ mergeReviewEnabled: 'true' })).toEqual({})
    expect(normalizeAppSettingsUpdate(null)).toEqual({})
  })
})

// Project roots narrow the Projects list to the folders a user's projects live in.
// An empty list means "not configured" and must keep showing everything, so the
// distinction between absent and empty is load-bearing rather than cosmetic.
describe('project roots', () => {
  const SEPARATOR = String.fromCharCode(92)
  const winPath = 'C:' + SEPARATOR + 'Code'

  it('defaults to none, which means no narrowing at all', () => {
    expect(normalizeAppSettings(null).projectRoots).toEqual([])
    expect(normalizeAppSettings({ projectRoots: 'nope' }).projectRoots).toEqual([])
  })

  it('rebuilds a stored root rather than trusting its id', () => {
    const [root] = normalizeAppSettings({
      projectRoots: [{ path: winPath, distro: null, label: 'Work', id: 'stale-nonsense' }]
    }).projectRoots
    expect(root.path).toBe(winPath)
    expect(root.label).toBe('Work')
    expect(root.id).not.toBe('stale-nonsense')
  })

  it('keeps a WSL root distinct from a Windows one', () => {
    const roots = normalizeAppSettings({
      projectRoots: [
        { path: '/home/a/code', distro: 'Ubuntu' },
        { path: '/home/a/code', distro: null }
      ]
    }).projectRoots
    expect(roots).toHaveLength(2)
    expect(roots[0].distro).toBe('Ubuntu')
  })

  // Two spellings of one folder must not become two roots that both claim the same
  // projects, so they collapse on the normalized id.
  it('collapses duplicate spellings of the same folder', () => {
    const roots = normalizeAppSettings({
      projectRoots: [{ path: winPath }, { path: 'c:' + SEPARATOR + 'code' + SEPARATOR }]
    }).projectRoots
    expect(roots).toHaveLength(1)
  })

  // A bare Windows separator is drive-relative; storing it would silently collapse
  // every Windows project onto one working-directory-dependent id.
  it('drops a Windows root that names no real location, but keeps a distro root', () => {
    const roots = normalizeAppSettings({
      projectRoots: [{ path: SEPARATOR }, { path: '/', distro: 'Ubuntu' }]
    }).projectRoots
    expect(roots).toHaveLength(1)
    expect(roots[0].distro).toBe('Ubuntu')
  })

  it('drops entries with no usable path', () => {
    const roots = normalizeAppSettings({
      projectRoots: [{ path: '   ' }, { distro: 'Ubuntu' }, null, 'nope', { path: winPath }]
    }).projectRoots
    expect(roots).toHaveLength(1)
  })

  // "Stop narrowing the list" is a real instruction and has to survive the update
  // path; treating an empty array as nothing to do would strand the user.
  it('carries an explicit empty list through an update', () => {
    expect(normalizeAppSettingsUpdate({ projectRoots: [] })).toEqual({ projectRoots: [] })
    expect(normalizeAppSettingsUpdate({ projectRoots: 'nope' })).toEqual({})
    expect(normalizeAppSettingsUpdate({ mergeReviewEnabled: false })).toEqual({ mergeReviewEnabled: false })
  })
})
