// Types and pure helpers for the project file manager. Everything here is
// dependency-free (no node:*, no electron) so it is safe to import from both the
// renderer and the main process, and trivially unit-testable. The main-process
// service layers fs/electron on top.

export type FileKind = 'file' | 'dir'

export type FileEntry = {
  name: string
  kind: FileKind
  size: number
  modifiedMs: number
}

export type DirListing = {
  relPath: string
  entries: FileEntry[]
  truncated: boolean
  error?: string
}

export type FilePreviewKind = 'text' | 'image' | 'binary' | 'too-large' | 'error'

export type FilePreview = {
  kind: FilePreviewKind
  name: string
  size: number
  text?: string
  dataUrl?: string
  error?: string
}

export type FileOpResult = { ok: boolean; error?: string }

// A request always identifies the project root (POSIX path + distro for WSL, or a
// native Windows path) plus a forward-slash path relative to that root.
export type FileRequest = { rootPath: string; distro: string | null; relPath: string }

export const MAX_DIR_ENTRIES = 2000
export const MAX_TEXT_PREVIEW_BYTES = 262_144 // 256 KiB
export const MAX_IMAGE_PREVIEW_BYTES = 2_097_152 // 2 MiB

// Reduce a caller-supplied relative path to a safe, forward-slash path that can
// never escape the root: any `..` segment rejects the whole path, and leading
// slashes / drive letters collapse into harmless name segments. Returns the
// cleaned path (`''` for the root) or null if it tried to traverse upward.
export function confineRelPath(relPath: unknown): string | null {
  if (typeof relPath !== 'string') return null
  const cleaned: string[] = []
  for (const raw of relPath.replace(/\\/g, '/').split('/')) {
    if (raw === '' || raw === '.') continue
    if (raw === '..') return null
    cleaned.push(raw)
  }
  return cleaned.join('/')
}

// A name used for create/rename must be a single, separator-free segment.
export function isValidEntryName(name: unknown): name is string {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..') return false
  return !/[\\/]/.test(trimmed)
}

// Translate a project root into a Windows-native path. WSL roots become the
// `\\wsl.localhost\<distro>\…` 9P share (the transform used across the sessions
// code); Windows roots are returned with normalized separators.
export function toNativeRoot(rootPath: string, distro: string | null): string {
  if (distro) {
    const tail = rootPath
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .replace(/^\/+/, '')
      .replace(/\//g, '\\')
    return `\\\\wsl.localhost\\${distro}\\${tail}`
  }
  return rootPath.replace(/\//g, '\\').replace(/[\\]+$/, '')
}

// Join a confined relative path onto a native root. `safeRel` must already have
// passed confineRelPath, so this is a pure concatenation.
export function joinNative(nativeRoot: string, safeRel: string): string {
  if (!safeRel) return nativeRoot
  return `${nativeRoot}\\${safeRel.replace(/\//g, '\\')}`
}
