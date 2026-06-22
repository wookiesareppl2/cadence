import { describe, expect, it } from 'vitest'
import { centralSlug, makeMemoryId, parseMemoryId } from '../src/shared/memory'

describe('centralSlug', () => {
  it('matches Claude Code folder naming for a Windows path', () => {
    expect(centralSlug('C:\\IDE Platforms\\Visual Studio Code\\Projects\\In Progress\\cadence')).toBe(
      'C--IDE-Platforms-Visual-Studio-Code-Projects-In-Progress-cadence'
    )
  })

  it('replaces every non-alphanumeric character (dots, slashes, spaces)', () => {
    expect(centralSlug('/home/user/my.app')).toBe('-home-user-my-app')
    expect(centralSlug('D:/Work/site')).toBe('D--Work-site')
  })
})

describe('makeMemoryId / parseMemoryId', () => {
  it('round-trips a group and filename', () => {
    const id = makeMemoryId('working', 'HANDOFF.md')
    expect(id).toBe('working:HANDOFF.md')
    expect(parseMemoryId(id)).toEqual({ group: 'working', name: 'HANDOFF.md' })
  })

  it('keeps dots in the filename intact', () => {
    expect(parseMemoryId('remembered-central:user.platform.md')).toEqual({
      group: 'remembered-central',
      name: 'user.platform.md'
    })
  })

  it('rejects malformed or unknown ids', () => {
    expect(parseMemoryId('HANDOFF.md')).toBeNull() // no group
    expect(parseMemoryId(':HANDOFF.md')).toBeNull() // empty group
    expect(parseMemoryId('working:')).toBeNull() // empty name
    expect(parseMemoryId('bogus:file.md')).toBeNull() // unknown group
  })
})
