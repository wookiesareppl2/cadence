import type { WebContents } from 'electron'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlatformId } from '@shared/platform'
import {
  centralSlug,
  makeMemoryId,
  parseMemoryId,
  type MemoryFileContent,
  type MemoryFileMeta,
  type MemoryGroup,
  type MemoryGroupId,
  type MemoryWriteResult,
  type ProjectMemory
} from '@shared/memory'
import { MEMORY_GROUP_LABELS, MEMORY_GROUP_ORDER } from '@shared/memory'
import { isValidEntryName, joinNative, toNativeRoot } from '@shared/project-files'
import { getDefaultClaudeProjectsRoot } from '../usage/claude-jsonl'
import { resolveProjectLocation, type ProjectLocation } from '../projects/project-locator'

// The working-memory bank files (lowercased for matching). Anything else directly
// in `.claude/` that ends in .md falls into the "other context" group.
const WORKING_NAMES = new Set(['handoff.md', 'decisions.md', 'patterns.md', 'troubleshooting.md'])
const PINS_NAME = 'context-pins.md'
const INSTRUCTIONS_NAME = 'CLAUDE.md'

type FoundFile = { name: string; sizeBytes: number; modifiedMs: number }

// List the markdown files directly inside a directory (no recursion). Returns []
// for a missing/unreadable directory so absent groups simply show up empty.
async function listMarkdown(dir: string): Promise<FoundFile[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: FoundFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    try {
      const info = await stat(join(dir, entry.name))
      files.push({ name: entry.name, sizeBytes: info.size, modifiedMs: info.mtimeMs })
    } catch {
      // Unreadable file — skip it.
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

function meta(group: MemoryGroupId, file: FoundFile): MemoryFileMeta {
  return { id: makeMemoryId(group, file.name), group, label: file.name, sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs }
}

// The native (Windows) directory that holds a group's files for a given project.
// Central lives outside the project (and only for native-Windows projects); the
// rest live inside the project folder, WSL-aware via toNativeRoot/joinNative.
function groupDir(location: ProjectLocation, group: MemoryGroupId): string | null {
  const root = toNativeRoot(location.path, location.distro)
  switch (group) {
    case 'working':
    case 'pins':
    case 'other':
      return joinNative(root, '.claude')
    case 'remembered-project':
      return joinNative(root, '.claude/memory')
    case 'instructions':
      return root
    case 'remembered-central':
      if (location.distro !== null) return null
      return join(getDefaultClaudeProjectsRoot(), centralSlug(location.path), 'memory')
  }
}

// Re-derive a file's absolute path from its (validated) group + name. The renderer
// never supplies a path; this is the only place ids become real locations, so a
// bad name or out-of-scope instructions write can't escape.
function resolveFilePath(location: ProjectLocation, group: MemoryGroupId, name: string): string | null {
  if (!isValidEntryName(name)) return null
  if (group === 'instructions' && name !== INSTRUCTIONS_NAME) return null
  const dir = groupDir(location, group)
  if (!dir) return null
  return join(dir, name)
}

export async function getProjectMemory(
  platform: PlatformId,
  projectId: string | null,
  sender: WebContents
): Promise<ProjectMemory> {
  const location = await resolveProjectLocation(platform, projectId, sender)
  if (!location) {
    return { projectId: projectId ?? '', projectName: '', projectPath: null, available: false, groups: [] }
  }

  const byGroup = new Map<MemoryGroupId, MemoryFileMeta[]>()
  const push = (file: MemoryFileMeta): void => {
    const list = byGroup.get(file.group) ?? []
    list.push(file)
    byGroup.set(file.group, list)
  }

  // `.claude/*.md` → working / pins / other.
  for (const file of await listMarkdown(groupDir(location, 'working') as string)) {
    const lower = file.name.toLowerCase()
    if (WORKING_NAMES.has(lower)) push(meta('working', file))
    else if (lower === PINS_NAME) push(meta('pins', file))
    else push(meta('other', file))
  }
  // `.claude/memory/*.md`
  for (const file of await listMarkdown(groupDir(location, 'remembered-project') as string)) {
    push(meta('remembered-project', file))
  }
  // root CLAUDE.md
  try {
    const info = await stat(join(toNativeRoot(location.path, location.distro), INSTRUCTIONS_NAME))
    if (info.isFile()) {
      push(meta('instructions', { name: INSTRUCTIONS_NAME, sizeBytes: info.size, modifiedMs: info.mtimeMs }))
    }
  } catch {
    // No project instructions file — fine.
  }
  // central memory store (native-Windows projects only)
  const centralDir = groupDir(location, 'remembered-central')
  if (centralDir) {
    for (const file of await listMarkdown(centralDir)) push(meta('remembered-central', file))
  }

  const groups: MemoryGroup[] = MEMORY_GROUP_ORDER.filter((id) => (byGroup.get(id)?.length ?? 0) > 0).map((id) => ({
    id,
    label: MEMORY_GROUP_LABELS[id],
    files: byGroup.get(id) as MemoryFileMeta[]
  }))

  return { projectId: location.id, projectName: location.name, projectPath: location.path, available: true, groups }
}

export async function readMemoryFile(
  platform: PlatformId,
  projectId: string | null,
  id: string,
  sender: WebContents
): Promise<MemoryFileContent> {
  const parsed = parseMemoryId(id)
  if (!parsed) return { id, label: id, text: '', error: 'Invalid file reference' }

  const location = await resolveProjectLocation(platform, projectId, sender)
  if (!location) return { id, label: parsed.name, text: '', error: 'Project folder not found' }

  const path = resolveFilePath(location, parsed.group, parsed.name)
  if (!path) return { id, label: parsed.name, text: '', error: 'Invalid file reference' }

  try {
    const text = await readFile(path, 'utf-8')
    return { id, label: parsed.name, text }
  } catch {
    return { id, label: parsed.name, text: '', error: 'Could not read this file' }
  }
}

export async function writeMemoryFile(
  platform: PlatformId,
  projectId: string | null,
  id: string,
  text: unknown,
  sender: WebContents
): Promise<MemoryWriteResult> {
  if (typeof text !== 'string') return { ok: false, error: 'Invalid content' }
  const parsed = parseMemoryId(id)
  if (!parsed) return { ok: false, error: 'Invalid file reference' }

  const location = await resolveProjectLocation(platform, projectId, sender)
  if (!location) return { ok: false, error: 'Project folder not found' }

  const path = resolveFilePath(location, parsed.group, parsed.name)
  if (!path) return { ok: false, error: 'Invalid file reference' }

  try {
    await writeFile(path, text, 'utf-8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save this file' }
  }
}
