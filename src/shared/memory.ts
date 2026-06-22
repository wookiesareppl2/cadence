// Types and pure helpers for the project memory & context viewer. Dependency-free
// (no node:*, no electron) so it is safe to import from both the renderer and the
// main process, and trivially unit-testable. The main-process service layers fs on
// top and is the only place that turns these ids into real file paths.

export type MemoryGroupId =
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
  working: 'Working memory',
  pins: 'Pinned rules & context',
  'remembered-project': 'Remembered facts (this project)',
  'remembered-central': 'Remembered facts (central)',
  instructions: 'Project instructions',
  other: 'Other context'
}

export const MEMORY_GROUP_ORDER: MemoryGroupId[] = [
  'working',
  'pins',
  'remembered-project',
  'remembered-central',
  'instructions',
  'other'
]

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
