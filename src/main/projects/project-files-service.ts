import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import {
  confineRelPath,
  isValidEntryName,
  joinNative,
  toNativeRoot,
  MAX_DIR_ENTRIES,
  MAX_IMAGE_PREVIEW_BYTES,
  MAX_TEXT_PREVIEW_BYTES,
  type DirListing,
  type FileEntry,
  type FileKind,
  type FileOpResult,
  type FilePreview,
  type FileRequest,
  type ProjectFileStat
} from '@shared/project-files'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\.localhost|\$)\\/i.test(path)
}

type Resolved = { root: string; native: string }
type ExternalOpenResult = 'opened' | 'failed'

// Validate a request and resolve it to a native Windows path confined to the
// project root. Returns null for anything that can't be confined.
function resolveRequest(req: FileRequest): Resolved | null {
  if (!req || typeof req.rootPath !== 'string' || !req.rootPath) return null
  const safe = confineRelPath(req.relPath ?? '')
  if (safe === null) return null
  const root = toNativeRoot(req.rootPath, req.distro ?? null)
  const native = joinNative(root, safe)
  // Defense in depth: the joined path must stay within the root.
  const rootLc = root.toLowerCase()
  const nativeLc = native.toLowerCase()
  if (nativeLc !== rootLc && !nativeLc.startsWith(`${rootLc}\\`)) return null
  return { root, native }
}

async function openViaExplorer(nativePath: string): Promise<ExternalOpenResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: ExternalOpenResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => finish('failed'), 3000)

    try {
      // Use Explorer as the Windows shell broker. Launching Code.exe/code.cmd
      // directly from an Electron app can create a black VS Code window whose
      // renderer exits with `launch-failed`; Explorer owns the file association
      // launch and avoids inheriting this process tree's Electron state.
      const child = spawn('explorer.exe', [nativePath], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true
      })
      child.once('spawn', () => {
        child.unref()
        finish('opened')
      })
      child.once('error', () => finish('failed'))
    } catch {
      finish('failed')
    }
  })
}

export async function listDirectory(req: FileRequest): Promise<DirListing> {
  const relPath = confineRelPath(req?.relPath ?? '') ?? ''
  const resolved = resolveRequest(req)
  if (!resolved) return { relPath, entries: [], truncated: false, error: 'Invalid path' }

  let dirents
  try {
    dirents = await readdir(resolved.native, { withFileTypes: true })
  } catch {
    return { relPath, entries: [], truncated: false, error: 'Could not read this folder' }
  }

  const truncated = dirents.length > MAX_DIR_ENTRIES
  const entries: FileEntry[] = []
  for (const dirent of dirents.slice(0, MAX_DIR_ENTRIES)) {
    const full = `${resolved.native}\\${dirent.name}`
    let kind: FileKind = dirent.isDirectory() ? 'dir' : 'file'
    let size = 0
    let modifiedMs = 0
    try {
      const info = await stat(full)
      if (dirent.isSymbolicLink()) kind = info.isDirectory() ? 'dir' : 'file'
      size = info.size
      modifiedMs = info.mtimeMs
    } catch {
      // Broken symlink / permission denied — keep the name with zeroed stats.
    }
    entries.push({ name: dirent.name, kind, size, modifiedMs })
  }

  entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.kind === 'dir'
        ? -1
        : 1
  )
  return { relPath, entries, truncated }
}

// Cheap existence/kind probe (no file read) used to validate terminal file-link
// candidates on hover before they become clickable links.
export async function statProjectFile(req: FileRequest): Promise<ProjectFileStat> {
  const resolved = resolveRequest(req)
  if (!resolved) return { exists: false }
  try {
    const info = await stat(resolved.native)
    return { exists: true, kind: info.isDirectory() ? 'dir' : 'file' }
  } catch {
    return { exists: false }
  }
}

export async function readFilePreview(req: FileRequest): Promise<FilePreview> {
  const name = basename((confineRelPath(req?.relPath ?? '') || req?.relPath) ?? '')
  const resolved = resolveRequest(req)
  if (!resolved) return { kind: 'error', name, size: 0, error: 'Invalid path' }

  let info
  try {
    info = await stat(resolved.native)
  } catch {
    return { kind: 'error', name, size: 0, error: 'Could not open this file' }
  }
  if (info.isDirectory()) return { kind: 'error', name, size: info.size, error: 'This is a folder' }

  const mime = IMAGE_MIME[extname(name).toLowerCase()]
  if (mime) {
    if (info.size > MAX_IMAGE_PREVIEW_BYTES) return { kind: 'too-large', name, size: info.size }
    try {
      const buffer = await readFile(resolved.native)
      return { kind: 'image', name, size: info.size, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` }
    } catch {
      return { kind: 'error', name, size: info.size, error: 'Could not read this file' }
    }
  }

  if (info.size > MAX_TEXT_PREVIEW_BYTES) return { kind: 'too-large', name, size: info.size }
  try {
    const buffer = await readFile(resolved.native)
    if (buffer.includes(0)) return { kind: 'binary', name, size: info.size }
    return { kind: 'text', name, size: info.size, text: buffer.toString('utf-8') }
  } catch {
    return { kind: 'error', name, size: info.size, error: 'Could not read this file' }
  }
}

export async function renameEntry(req: FileRequest, newName: unknown): Promise<FileOpResult> {
  const resolved = resolveRequest(req)
  if (!resolved) return { ok: false, error: 'Invalid path' }
  if (resolved.native.toLowerCase() === resolved.root.toLowerCase()) {
    return { ok: false, error: 'Cannot rename the project root' }
  }
  if (!isValidEntryName(newName)) return { ok: false, error: 'Invalid name' }
  const dest = `${dirname(resolved.native)}\\${newName.trim()}`
  try {
    await rename(resolved.native, dest)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Rename failed' }
  }
}

export async function createEntry(req: FileRequest, name: unknown, kind: FileKind): Promise<FileOpResult> {
  const resolved = resolveRequest(req)
  if (!resolved) return { ok: false, error: 'Invalid path' }
  if (!isValidEntryName(name)) return { ok: false, error: 'Invalid name' }
  const dest = `${resolved.native}\\${name.trim()}`
  try {
    if (kind === 'dir') await mkdir(dest)
    else await writeFile(dest, '', { flag: 'wx' })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not create' }
  }
}

export async function deleteEntry(req: FileRequest): Promise<FileOpResult> {
  const resolved = resolveRequest(req)
  if (!resolved) return { ok: false, error: 'Invalid path' }
  if (resolved.native.toLowerCase() === resolved.root.toLowerCase()) {
    return { ok: false, error: 'Cannot delete the project root' }
  }
  try {
    await shell.trashItem(resolved.native)
    return { ok: true }
  } catch {
    // The Recycle Bin doesn't cover WSL's 9P share, so trashItem throws there.
    // Fall back to a permanent delete for WSL items only (the UI warns about it).
    if (isWslUncPath(resolved.native)) {
      try {
        await rm(resolved.native, { recursive: true, force: true })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Delete failed' }
      }
    }
    return { ok: false, error: 'Delete failed' }
  }
}

export async function revealInExplorer(req: FileRequest): Promise<FileOpResult> {
  const resolved = resolveRequest(req)
  if (!resolved) return { ok: false, error: 'Invalid path' }
  shell.showItemInFolder(resolved.native)
  return { ok: true }
}

export async function openExternally(req: FileRequest): Promise<FileOpResult> {
  const resolved = resolveRequest(req)
  if (!resolved) return { ok: false, error: 'Invalid path' }
  if (process.platform === 'win32') {
    const explorerResult = await openViaExplorer(resolved.native)
    if (explorerResult === 'opened') return { ok: true }
    console.warn('[project-files:open] Explorer failed to open path', { relPath: confineRelPath(req.relPath ?? '') ?? '' })
    return { ok: false, error: 'Windows could not open this file externally' }
  }
  const error = await shell.openPath(resolved.native)
  return error ? { ok: false, error } : { ok: true }
}
