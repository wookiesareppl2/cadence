// Types and pure helpers for the project memory & context viewer. Dependency-free
// (no node:*, no electron) so it is safe to import from both the renderer and the
// main process, and trivially unit-testable. The main-process service layers fs on
// top and is the only place that turns these ids into real file paths.

export type MemoryGroupId =
  | 'vault-hot' // vault memory home: _Index / HANDOFF / Pins
  | 'vault-ondemand' // vault memory home: Pins-Reference / Decisions / Patterns / Troubleshooting
  | 'vault-archive' // vault memory home: Archive/*.md
  | 'working' // HANDOFF / decisions / patterns / troubleshooting
  | 'pins' // context-pins
  | 'remembered-project' // .claude/memory/*.md
  | 'remembered-central' // <home>/.claude/projects/<slug>/memory/*.md
  | 'instructions' // CLAUDE.md
  | 'other' // any other *.md directly in .claude/

export type MemoryFileMeta = {
  id: string // `${group}:${name}` — stable, opaque to the renderer
  group: MemoryGroupId
  label: string // display name, e.g. "HANDOFF.md"
  sizeBytes: number
  modifiedMs: number
}

export type MemoryGroup = {
  id: MemoryGroupId
  label: string
  files: MemoryFileMeta[]
  // Whether this group can be edited in-app, and why not when it cannot. Both are
  // decided in the main process: a group is read-only because of what the file IS,
  // not because of what the renderer believes, and writeMemoryFile enforces the
  // same rule independently. The renderer uses these only to shape the UI.
  readOnly: boolean
  readOnlyReason?: string
}

export type ProjectMemory = {
  projectId: string
  projectName: string
  projectPath: string | null
  available: boolean // false when the project has no resolvable folder
  groups: MemoryGroup[]
}

export type MemoryFileContent = { id: string; label: string; text: string; error?: string }
export type MemoryWriteResult = { ok: boolean; error?: string }

// Human-readable section headings, in display order.
export const MEMORY_GROUP_LABELS: Record<MemoryGroupId, string> = {
  'vault-hot': 'Hot layer (read at every session)',
  'vault-ondemand': 'Deeper memory (read on demand)',
  'vault-archive': 'Archive',
  working: 'Working memory',
  pins: 'Pinned rules & context',
  'remembered-project': 'Remembered facts (this project)',
  'remembered-central': 'Remembered facts (central)',
  instructions: 'Project instructions',
  other: 'Other context'
}

// When a project routes to the vault, its in-repo `.claude/` bank is the frozen
// transition artifact: still worth reading, never authoritative, never edited.
// The ids stay the same so existing search deep-links keep resolving; only the
// heading changes, and the service marks the group read-only.
export const FROZEN_BANK_LABELS: Partial<Record<MemoryGroupId, string>> = {
  working: 'Frozen old bank — working memory',
  pins: 'Frozen old bank — pinned rules',
  'remembered-project': 'Frozen old bank — remembered facts',
  other: 'Frozen old bank — other context'
}

export const MEMORY_GROUP_ORDER: MemoryGroupId[] = [
  'vault-hot',
  'vault-ondemand',
  'vault-archive',
  'working',
  'pins',
  'remembered-project',
  'remembered-central',
  'instructions',
  'other'
]

// The vault memory home's own files, split into the two layers the save/start
// workflow already distinguishes. Anything else in the home that ends in .md
// falls into the deeper layer rather than being hidden.
export const VAULT_HOT_NAMES = ['_Index.md', 'HANDOFF.md', 'Pins.md']
export const VAULT_ARCHIVE_DIR = 'Archive'

const WORKING_MEMORY_NAMES = new Set(['handoff.md', 'decisions.md', 'patterns.md', 'troubleshooting.md'])
const PINS_MEMORY_NAME = 'context-pins.md'
const INSTRUCTIONS_MEMORY_NAME = 'claude.md'

function isMarkdownName(name: string): boolean {
  return Boolean(name) && name !== '.' && name !== '..' && name.toLowerCase().endsWith('.md')
}

// Claude Code names its per-project central folder by replacing every character
// that isn't a letter or digit with a dash. Verified against the real store:
// `C:\IDE Platforms\…\cadence` → `C--IDE-Platforms-…-cadence`.
export function centralSlug(nativePath: string): string {
  return nativePath.replace(/[^a-zA-Z0-9]/g, '-')
}

// A file id is "<group>:<name>". The group never contains a colon, so split on the
// first one; the remainder is the filename (which may itself contain dots).
export function makeMemoryId(group: MemoryGroupId, name: string): string {
  return `${group}:${name}`
}

export function parseMemoryId(id: string): { group: MemoryGroupId; name: string } | null {
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  const group = id.slice(0, idx) as MemoryGroupId
  const name = id.slice(idx + 1)
  if (!name || !MEMORY_GROUP_ORDER.includes(group)) return null
  return { group, name }
}

// Convert a project-relative search/file path into the Memory viewer's opaque id
// when that path belongs to a file the Memory service already surfaces.
export function memoryIdFromProjectRelPath(relPath: string): string | null {
  const parts = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part.length > 0)

  if (parts.some((part) => part === '.' || part === '..')) return null

  if (parts.length === 1 && parts[0].toLowerCase() === INSTRUCTIONS_MEMORY_NAME) {
    return makeMemoryId('instructions', 'CLAUDE.md')
  }

  if (parts[0]?.toLowerCase() !== '.claude') return null

  if (parts.length === 2 && isMarkdownName(parts[1])) {
    const name = parts[1]
    const lower = name.toLowerCase()
    if (WORKING_MEMORY_NAMES.has(lower)) return makeMemoryId('working', name)
    if (lower === PINS_MEMORY_NAME) return makeMemoryId('pins', name)
    return makeMemoryId('other', name)
  }

  if (
    parts.length === 3 &&
    parts[1].toLowerCase() === 'memory' &&
    isMarkdownName(parts[2])
  ) {
    return makeMemoryId('remembered-project', parts[2])
  }

  return null
}
