import { describe, expect, it } from 'vitest'
import { applyProjectAlias, applySessionAlias, emptyMetadata, sessionAliasKey } from '../src/shared/session-metadata'
import type { AssistantSession } from '../src/shared/sessions'

function makeSession(overrides: Partial<AssistantSession> = {}): AssistantSession {
  return {
    id: 'sess-1',
    platform: 'claude',
    projectId: 'claude:c:/projects/app',
    title: 'Inferred title',
    rawTitle: null,
    inferredTitle: null,
    project: 'app',
    projectPath: 'C:/projects/app',
    branch: null,
    usageLabel: null,
    status: 'local',
    age: '1m ago',
    updatedAt: '2026-06-07T00:00:00.000Z',
    ...overrides
  }
}

describe('sessionAliasKey', () => {
  it('namespaces the id by platform', () => {
    expect(sessionAliasKey('claude', 'abc')).toBe('claude:abc')
    expect(sessionAliasKey('codex', 'abc')).toBe('codex:abc')
  })
})

describe('emptyMetadata', () => {
  it('returns empty alias maps', () => {
    expect(emptyMetadata()).toEqual({ projectAliases: {}, sessionAliases: {} })
  })
})

describe('applySessionAlias', () => {
  it('overrides the title when an alias exists', () => {
    const session = makeSession()
    const result = applySessionAlias(session, { 'claude:sess-1': 'My name' })
    expect(result.title).toBe('My name')
    expect(result).not.toBe(session) // returns a copy, does not mutate
    expect(session.title).toBe('Inferred title')
  })

  it('passes the session through unchanged when there is no alias', () => {
    const session = makeSession()
    expect(applySessionAlias(session, {})).toBe(session)
  })

  it('ignores a blank alias and falls back to the inferred title', () => {
    const session = makeSession()
    expect(applySessionAlias(session, { 'claude:sess-1': '   ' })).toBe(session)
  })

  it('keys aliases by platform so codex aliases do not leak into claude', () => {
    const session = makeSession({ platform: 'claude', id: 'shared-id' })
    expect(applySessionAlias(session, { 'codex:shared-id': 'Codex name' }).title).toBe('Inferred title')
  })
})

describe('applyProjectAlias', () => {
  it('returns the alias when set', () => {
    expect(applyProjectAlias('app', 'claude:c:/projects/app', { 'claude:c:/projects/app': 'Work App' })).toBe('Work App')
  })

  it('returns the inferred name when no alias exists', () => {
    expect(applyProjectAlias('app', 'claude:c:/projects/app', {})).toBe('app')
  })

  it('falls back to the inferred name for a blank alias', () => {
    expect(applyProjectAlias('app', 'claude:c:/projects/app', { 'claude:c:/projects/app': '  ' })).toBe('app')
  })
})
