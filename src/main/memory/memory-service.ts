import type { WebContents } from 'electron'
import { readFileSync, readdirSync, statSync } from 'node:fs'
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
import {
  FROZEN_BANK_LABELS,
  MEMORY_GROUP_LABELS,
  MEMORY_GROUP_ORDER,
  VAULT_ARCHIVE_DIR,
  VAULT_HOT_NAMES
} from '@shared/memory'
import { isValidEntryName, joinNative, toNativeRoot } from '@shared/project-files'
import { getDefaultClaudeProjectsRoot } from '../usage/claude-jsonl'
import { resolveProjectLocation, type ProjectLocation } from '../projects/project-locator'
import { resolveRoute } from '../vault-save/resolve-memory-route.mjs'

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

// Where this project's memory actually lives, resolved once per request.
//
// The marker logic is NOT restated here. `resolveRoute` is the same function the
// /start and /save workflows use to answer this question, and re-implementing it
// in TypeScript is precisely the "derive, never restate" defect that shipped five
// times in this codebase: the viewer would drift from the engine and start showing
// a different memory home than the one being written to. This is the first app-code
// import of the shared engine; see docs/DESIGN.md.
type MemoryLayout = {
  location: ProjectLocation
  vaultHome: string | null // the vault memory home, when this project routes there
}

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileExistsSync(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function listDirectorySync(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true }).map((entry) => entry.name)
  } catch {
    return []
  }
}

function resolveLayout(location: ProjectLocation): MemoryLayout {
  const root = toNativeRoot(location.path, location.distro)
  // An `abort` route means a marker exists but its home could not be resolved.
  // Treating that as "no vault" would quietly show the frozen bank as if it were
  // live memory, which is the failure this whole change exists to end — so the
  // vault side simply comes back empty and the frozen bank stays labelled frozen.
  const resolved = resolveRoute({
    root,
    readFileSafe,
    isDirectory: isDirectorySync,
    fileExists: fileExistsSync,
    env: process.env,
    listDirectory: listDirectorySync
  })
  const vaultHome = resolved.route === 'vault' && resolved.home ? resolved.home : null
  return { location, vaultHome }
}

// Groups the viewer will never write to, and the plain-language reason shown when
// the user asks why. Vault memory is governed by the save engine — required
// frontmatter, unique entry ids, no dangling references, index counts that match —
// and a hand edit here would satisfy none of it, only to fail the next save with an
// error pointing nowhere near this window. The frozen bank is read-only because the
// project baseline says it is not authoritative and must not be edited.
const READ_ONLY_REASONS: Partial<Record<MemoryGroupId, string>> = {
  'vault-hot': 'Vault memory is written by /save, which validates it. Edit it there.',
  'vault-ondemand': 'Vault memory is written by /save, which validates it. Edit it there.',
  'vault-archive': 'Archived memory is kept as a record and is not edited in place.'
}

const FROZEN_BANK_REASON = 'The old in-repo memory bank is frozen: kept for reference, no longer read.'

function readOnlyFor(group: MemoryGroupId, layout: MemoryLayout): string | undefined {
  if (READ_ONLY_REASONS[group]) return READ_ONLY_REASONS[group]
  if (layout.vaultHome && FROZEN_BANK_LABELS[group]) return FROZEN_BANK_REASON
  return undefined
}

// The native (Windows) directory that holds a group's files for a given project.
// Vault groups live outside the project entirely, at the resolved memory home;
// central lives outside too (and only for native-Windows projects); the rest live
// inside the project folder, WSL-aware via toNativeRoot/joinNative.
function groupDir(layout: MemoryLayout, group: MemoryGroupId): string | null {
  const { location, vaultHome } = layout
  const root = toNativeRoot(location.path, location.distro)
  switch (group) {
    case 'vault-hot':
    case 'vault-ondemand':
      return vaultHome
    case 'vault-archive':
      return vaultHome ? join(vaultHome, VAULT_ARCHIVE_DIR) : null
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
function resolveFilePath(layout: MemoryLayout, group: MemoryGroupId, name: string): string | null {
  if (!isValidEntryName(name)) return null
  if (group === 'instructions' && name !== INSTRUCTIONS_NAME) return null
  const dir = groupDir(layout, group)
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
  const layout = resolveLayout(location)

  const byGroup = new Map<MemoryGroupId, MemoryFileMeta[]>()
  const push = (file: MemoryFileMeta): void => {
    const list = byGroup.get(file.group) ?? []
    list.push(file)
    byGroup.set(file.group, list)
  }

  // The vault memory home: hot layer, deeper layer, then Archive/.
  const vaultDir = groupDir(layout, 'vault-hot')
  if (vaultDir) {
    for (const file of await listMarkdown(vaultDir)) {
      push(meta(VAULT_HOT_NAMES.includes(file.name) ? 'vault-hot' : 'vault-ondemand', file))
    }
    for (const file of await listMarkdown(groupDir(layout, 'vault-archive') as string)) {
      push(meta('vault-archive', file))
    }
  }

  // `.claude/*.md` → working / pins / other. Still listed when the project routes
  // to the vault, because the frozen bank holds the pre-migration history and
  // reading it is often exactly what the user wants; it is relabelled and locked
  // rather than hidden.
  for (const file of await listMarkdown(groupDir(layout, 'working') as string)) {
    const lower = file.name.toLowerCase()
    if (WORKING_NAMES.has(lower)) push(meta('working', file))
    else if (lower === PINS_NAME) push(meta('pins', file))
    else push(meta('other', file))
  }
  // `.claude/memory/*.md`
  for (const file of await listMarkdown(groupDir(layout, 'remembered-project') as string)) {
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
  const centralDir = groupDir(layout, 'remembered-central')
  if (centralDir) {
    for (const file of await listMarkdown(centralDir)) push(meta('remembered-central', file))
  }

  const groups: MemoryGroup[] = MEMORY_GROUP_ORDER.filter((id) => (byGroup.get(id)?.length ?? 0) > 0).map((id) => {
    const reason = readOnlyFor(id, layout)
    return {
      id,
      label: (layout.vaultHome ? FROZEN_BANK_LABELS[id] : undefined) ?? MEMORY_GROUP_LABELS[id],
      files: byGroup.get(id) as MemoryFileMeta[],
      readOnly: Boolean(reason),
      readOnlyReason: reason
    }
  })

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

  const path = resolveFilePath(resolveLayout(location), parsed.group, parsed.name)
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

  const layout = resolveLayout(location)
  // Refuse here, not only in the UI. The renderer's readOnly flag shapes what the
  // user sees; this is what makes it true. A hidden Edit button is a suggestion,
  // and the write path must not depend on the renderer having honoured it.
  const readOnly = readOnlyFor(parsed.group, layout)
  if (readOnly) return { ok: false, error: readOnly }

  const path = resolveFilePath(layout, parsed.group, parsed.name)
  if (!path) return { ok: false, error: 'Invalid file reference' }

  try {
    await writeFile(path, text, 'utf-8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not save this file' }
  }
}
