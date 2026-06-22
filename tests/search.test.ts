import { describe, expect, it } from 'vitest'
import { bestScore, buildSnippet, indexOfNeedle, matchScore } from '../src/shared/search'

describe('indexOfNeedle', () => {
  it('finds matches case-insensitively', () => {
    expect(indexOfNeedle('Hello World', 'world')).toBe(6)
    expect(indexOfNeedle('AuthService', 'auth')).toBe(0)
  })

  it('returns -1 for misses and empty needles', () => {
    expect(indexOfNeedle('abc', 'xyz')).toBe(-1)
    expect(indexOfNeedle('abc', '')).toBe(-1)
  })
})

describe('matchScore', () => {
  it('ranks exact, prefix, word-boundary, and substring matches in order', () => {
    expect(matchScore('auth', 'auth')).toBe(100)
    expect(matchScore('authService', 'auth')).toBe(75)
    expect(matchScore('refresh-auth-token', 'auth')).toBe(50)
    expect(matchScore('reauthorize', 'auth')).toBe(25)
  })

  it('returns 0 for misses, blanks, and nullish fields', () => {
    expect(matchScore('login', 'auth')).toBe(0)
    expect(matchScore('auth', '   ')).toBe(0)
    expect(matchScore(null, 'auth')).toBe(0)
    expect(matchScore(undefined, 'auth')).toBe(0)
    expect(matchScore('', 'auth')).toBe(0)
  })
})

describe('bestScore', () => {
  it('returns the strongest score across fields', () => {
    expect(bestScore(['login.ts', 'reauthorize', 'authService'], 'auth')).toBe(75)
    expect(bestScore([null, 'nothing', undefined], 'auth')).toBe(0)
  })
})

describe('buildSnippet', () => {
  it('returns null when there is no match or inputs are blank', () => {
    expect(buildSnippet('the quick brown fox', 'cat')).toBeNull()
    expect(buildSnippet('', 'cat')).toBeNull()
    expect(buildSnippet('text', '   ')).toBeNull()
  })

  it('marks the matched span and reads back the original text', () => {
    const snippet = buildSnippet('refactor the auth flow here', 'auth')
    expect(snippet).not.toBeNull()
    expect(snippet!.text.slice(snippet!.matchStart, snippet!.matchEnd).toLowerCase()).toBe('auth')
  })

  it('collapses whitespace and newlines into a single line', () => {
    const snippet = buildSnippet('line one\n\n  indented   auth   here', 'auth')
    expect(snippet!.text).not.toContain('\n')
    expect(snippet!.text).not.toContain('  ')
  })

  it('adds leading/trailing ellipses when the body is clipped', () => {
    const long = `${'a '.repeat(80)}needle${' b'.repeat(80)}`
    const snippet = buildSnippet(long, 'needle', 20)
    expect(snippet!.text.startsWith('…')).toBe(true)
    expect(snippet!.text.endsWith('…')).toBe(true)
    expect(snippet!.text.slice(snippet!.matchStart, snippet!.matchEnd)).toBe('needle')
  })

  it('keeps offsets correct without leading ellipsis at the start of text', () => {
    const snippet = buildSnippet('needle at the very start of the text body here', 'needle', 10)
    expect(snippet!.matchStart).toBe(0)
    expect(snippet!.text.startsWith('needle')).toBe(true)
  })
})
