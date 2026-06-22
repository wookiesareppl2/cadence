// Pure detection of file-path mentions inside a single line of terminal text.
// Dependency-free (no node:*, no electron) so it is safe to import from the
// renderer's xterm link provider and is trivially unit-testable. The provider
// layers existence checks + preview opening on top of these candidates.

import { confineRelPath } from './project-files'

export type FilePathMatch = {
  // Character offsets into the supplied line (0-based, end exclusive) so the
  // caller can map them onto xterm buffer columns for the link range.
  start: number
  end: number
  // Forward-slash path confined under the project root (no `..`, no line suffix).
  relPath: string
  // Optional 1-based line number parsed from a trailing `:42` / `:42:7` suffix.
  line: number | null
}

// A token is a run of path-ish characters. `:` is included so a `file.ts:42`
// line suffix (and a `scheme://` URL) stay a single token; wrappers (quotes,
// backticks, parens, spaces) sit outside this class and so delimit a candidate.
const TOKEN_RE = /[A-Za-z0-9._:\\/-]+/g
// Trailing sentence punctuation that should never be part of a real path. A file
// extension always ends in an alphanumeric, so trimming these is safe.
const TRAILING_PUNCT_RE = /[.,;:)\]}]+$/
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]+$/
const MAX_CANDIDATES_PER_LINE = 24

// Map a character offset within a joined logical line back to an xterm buffer
// cell. Wrapped continuation rows are each exactly `cols` wide, so the offset
// divides into a row delta + column. Returns 1-based x (column) and y (buffer
// row), matching xterm's IBufferRange coordinates. `cols` must be >= 1.
export function offsetToCell(offset: number, cols: number, startRow: number): { x: number; y: number } {
  return { x: (offset % cols) + 1, y: startRow + Math.floor(offset / cols) + 1 }
}

// Extract clickable file-path candidates from one rendered terminal line. Only
// shape is validated here (path-like + confinable); the caller verifies the file
// actually exists before turning a candidate into a link.
export function findFilePathCandidates(line: string): FilePathMatch[] {
  const matches: FilePathMatch[] = []
  for (const match of line.matchAll(TOKEN_RE)) {
    if (matches.length >= MAX_CANDIDATES_PER_LINE) break
    const raw = match[0]
    const startIndex = match.index ?? 0
    // URLs (http://, file://, …) are not project files — skip the whole token.
    if (raw.includes('://')) continue

    // Peel off a trailing `:line` / `:line:col`, but only when the head still
    // looks like a path (avoids eating the `:` in things like `key:value`).
    let core = raw
    let line_: number | null = null
    const lineSuffix = core.match(/^(.+?):(\d+)(?::\d+)?$/)
    if (lineSuffix && /[./\\]/.test(lineSuffix[1])) {
      core = lineSuffix[1]
      line_ = Number.parseInt(lineSuffix[2], 10)
    }

    // Drop trailing punctuation (e.g. a sentence-ending period after a filename).
    core = core.replace(TRAILING_PUNCT_RE, '')
    if (!core) continue

    const normalized = core.replace(/\\/g, '/')
    const safe = confineRelPath(normalized)
    // Reject upward traversal / empty, anything without a letter (version numbers
    // like 1.2.3), and bare words that are neither a path nor an extensioned file.
    if (!safe) continue
    if (!/[A-Za-z]/.test(safe)) continue
    if (!safe.includes('/') && !HAS_EXTENSION_RE.test(safe)) continue

    matches.push({ start: startIndex, end: startIndex + core.length, relPath: safe, line: line_ })
  }
  return matches
}
