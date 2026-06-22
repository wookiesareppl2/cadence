import { describe, expect, it } from 'vitest'
import { findFilePathCandidates, offsetToCell } from '../src/shared/terminal-links'

describe('findFilePathCandidates', () => {
  it('detects a relative path mention', () => {
    const line = 'Edited src/main/index.ts to add the handler'
    const matches = findFilePathCandidates(line)
    expect(matches).toHaveLength(1)
    expect(matches[0].relPath).toBe('src/main/index.ts')
    expect(matches[0].line).toBeNull()
    expect(line.slice(matches[0].start, matches[0].end)).toBe('src/main/index.ts')
  })

  it('parses a trailing line number suffix', () => {
    const matches = findFilePathCandidates('see src/app.tsx:42 for details')
    expect(matches).toHaveLength(1)
    expect(matches[0].relPath).toBe('src/app.tsx')
    expect(matches[0].line).toBe(42)
  })

  it('parses a line:col suffix', () => {
    const [match] = findFilePathCandidates('error at lib/util.ts:12:5')
    expect(match.relPath).toBe('lib/util.ts')
    expect(match.line).toBe(12)
  })

  it('accepts a bare filename with an extension', () => {
    const [match] = findFilePathCandidates('updated package.json just now')
    expect(match.relPath).toBe('package.json')
  })

  it('normalizes Windows-style backslashes', () => {
    const [match] = findFilePathCandidates('wrote src\\main\\index.ts')
    expect(match.relPath).toBe('src/main/index.ts')
  })

  it('trims a trailing sentence period but keeps the extension', () => {
    const line = 'Done with src/app.tsx.'
    const [match] = findFilePathCandidates(line)
    expect(match.relPath).toBe('src/app.tsx')
    expect(line.slice(match.start, match.end)).toBe('src/app.tsx')
  })

  it('ignores prose without any file mention', () => {
    expect(findFilePathCandidates('Run the tests and report back')).toHaveLength(0)
  })

  it('ignores URLs', () => {
    expect(findFilePathCandidates('open https://example.com/docs/index.html')).toHaveLength(0)
  })

  it('rejects upward traversal', () => {
    expect(findFilePathCandidates('peek at ../../etc/passwd')).toHaveLength(0)
  })

  it('ignores bare version numbers', () => {
    expect(findFilePathCandidates('bumped to 1.2.3 today')).toHaveLength(0)
  })

  it('finds multiple candidates on one line', () => {
    const matches = findFilePathCandidates('moved src/a.ts to src/b.ts')
    expect(matches.map((m) => m.relPath)).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('offsetToCell', () => {
  it('maps offsets within the first row (1-based x/y)', () => {
    expect(offsetToCell(0, 80, 5)).toEqual({ x: 1, y: 6 })
    expect(offsetToCell(79, 80, 5)).toEqual({ x: 80, y: 6 })
  })

  it('wraps to the next row at the column boundary', () => {
    expect(offsetToCell(80, 80, 5)).toEqual({ x: 1, y: 7 })
    expect(offsetToCell(85, 80, 5)).toEqual({ x: 6, y: 7 })
  })

  it('maps a wrapped path mention onto a multi-row range', () => {
    // A narrow (20-col) terminal: a long path starting at offset 4 must span
    // more than one buffer row, so the link range crosses rows.
    const cols = 20
    const startRow = 3
    const path = 'src/components/file-preview-modal.tsx'
    const line = `see ${path}`
    const [match] = findFilePathCandidates(line)
    expect(match.relPath).toBe(path)

    const start = offsetToCell(match.start, cols, startRow)
    const end = offsetToCell(match.end - 1, cols, startRow)
    expect(line.slice(match.start, match.end)).toBe(path)
    // The mention is longer than one 20-col row, so the range must span rows.
    expect(end.y).toBeGreaterThan(start.y)
    expect(start).toEqual({ x: 5, y: 4 })
  })
})
