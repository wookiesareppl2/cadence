// Types and pure helpers for global search. Dependency-free (no node:*, no
// electron) so it is safe to import from both the renderer and the main process,
// and trivially unit-testable. The main-process service layers fs/sessions on top.

import type { PlatformId } from './platform'
import type { FileRequest } from './project-files'

type SearchKind = 'project' | 'session' | 'file' | 'history'

// One contiguous match window pulled out of a larger body of text, with the
// matched span marked so the renderer can highlight it. Offsets index into `text`.
export type SearchSnippet = {
  text: string
  matchStart: number
  matchEnd: number
}

export type SearchResultItem = {
  kind: SearchKind
  id: string // stable per row, unique within its section
  title: string // primary label (alias-applied where relevant)
  subtitle: string | null // path / project / role context
  projectId: string
  sessionId?: string // session + history results
  file?: FileRequest // file results — feeds the existing file preview
  entryId?: string // history results — for scroll-to
  snippet?: SearchSnippet // content (file body / history message) matches
}

export type SearchResults = {
  query: string
  projects: SearchResultItem[]
  sessions: SearchResultItem[]
  files: SearchResultItem[]
  history: SearchResultItem[]
  truncated: boolean // any category hit a cap / time budget
}

// What the renderer sends to the main process. `projectId` scopes the deep
// (file-content + history-content) search to the currently selected project;
// project/session matches still span the whole active platform.
export type SearchQuery = {
  platform: PlatformId
  projectId: string | null
  query: string
}

export function emptyResults(query = ''): SearchResults {
  return { query, projects: [], sessions: [], files: [], history: [], truncated: false }
}

// Case-insensitive substring index. Returns -1 when `needle` is empty or absent.
export function indexOfNeedle(haystack: string, needle: string): number {
  if (!needle) return -1
  return haystack.toLowerCase().indexOf(needle.toLowerCase())
}

// Score a single field against the needle. Higher = better:
//   100 exact · 75 whole-string prefix · 50 word-boundary prefix · 25 substring.
// 0 means no match. Used to rank project/session rows.
export function matchScore(haystack: string | null | undefined, needle: string): number {
  const n = needle.trim().toLowerCase()
  if (!haystack || !n) return 0
  const h = haystack.toLowerCase()
  if (h === n) return 100
  const idx = h.indexOf(n)
  if (idx === -1) return 0
  if (idx === 0) return 75
  const prev = h[idx - 1] ?? ''
  if (/[^a-z0-9]/.test(prev)) return 50
  return 25
}

// Best score across several fields (e.g. a session's title + branch).
export function bestScore(fields: Array<string | null | undefined>, needle: string): number {
  let best = 0
  for (const field of fields) {
    const score = matchScore(field, needle)
    if (score > best) best = score
  }
  return best
}

// Build a single-line snippet around the first occurrence of `needle`, with up to
// `radius` characters of context on each side and ellipses where the text was cut.
// Whitespace (incl. newlines) is collapsed first so the snippet reads as one line;
// offsets are computed against that normalized form. Returns null when there is no
// match.
export function buildSnippet(text: string, needle: string, radius = 48): SearchSnippet | null {
  const n = needle.trim()
  if (!text || !n) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  const found = normalized.toLowerCase().indexOf(n.toLowerCase())
  if (found === -1) return null

  const start = Math.max(0, found - radius)
  const end = Math.min(normalized.length, found + n.length + radius)
  let snippet = normalized.slice(start, end)
  let matchStart = found - start
  let matchEnd = matchStart + n.length

  if (start > 0) {
    snippet = `…${snippet}`
    matchStart += 1
    matchEnd += 1
  }
  if (end < normalized.length) snippet = `${snippet}…`

  return { text: snippet, matchStart, matchEnd }
}
