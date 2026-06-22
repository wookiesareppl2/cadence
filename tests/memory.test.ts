import { describe, expect, it } from 'vitest'
import { centralSlug, makeMemoryId, memoryIdFromProjectRelPath, parseMemoryId } from '../src/shared/memory'

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

describe('memoryIdFromProjectRelPath', () => {
  it('maps working memory and pins files from .claude', () => {
    expect(memoryIdFromProjectRelPath('.claude/HANDOFF.md')).toBe('working:HANDOFF.md')
    expect(memoryIdFromProjectRelPath('.claude/patterns.md')).toBe('working:patterns.md')
    expect(memoryIdFromProjectRelPath('.claude/context-pins.md')).toBe('pins:context-pins.md')
  })

  it('maps project remembered facts and project instructions', () => {
    expect(memoryIdFromProjectRelPath('.claude/memory/product.md')).toBe('remembered-project:product.md')
    expect(memoryIdFromProjectRelPath('CLAUDE.md')).toBe('instructions:CLAUDE.md')
  })

  it('maps other direct .claude markdown files', () => {
    expect(memoryIdFromProjectRelPath('.claude/notes.md')).toBe('other:notes.md')
    expect(memoryIdFromProjectRelPath('.claude\\notes.md')).toBe('other:notes.md')
  })

  it('rejects files outside the Memory viewer surface', () => {
    expect(memoryIdFromProjectRelPath('docs/DESIGN.md')).toBeNull()
    expect(memoryIdFromProjectRelPath('.codex/config.md')).toBeNull()
    expect(memoryIdFromProjectRelPath('.claude/not-markdown.txt')).toBeNull()
    expect(memoryIdFromProjectRelPath('.claude/memory/nested/file.md')).toBeNull()
    expect(memoryIdFromProjectRelPath('../.claude/HANDOFF.md')).toBeNull()
  })
})
