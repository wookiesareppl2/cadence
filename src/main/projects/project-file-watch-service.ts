import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { WebContents } from 'electron'
import {
  confineRelPath,
  isTextLikeProjectFile,
  joinNative,
  toNativeRoot,
  type ProjectFileChangedEvent,
  type ProjectFileWatchMode,
  type ProjectFileWatchRequest,
  type ProjectFileWatchResult
} from '@shared/project-files'

const PROJECT_FILE_CHANGED_CHANNEL = 'project-files:changed'
const WATCH_DEBOUNCE_MS = 90
const POLL_INTERVAL_MS = 1200
const NATIVE_SAFETY_POLL_INTERVAL_MS = 1200
const MAX_POLL_FILES = 3500
const IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.turbo',
  '.vite',
  '.vscode',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release'
])

type SnapshotEntry = {
  size: number
  modifiedMs: number
}

type WatchSession = {
  webContents: WebContents
  rootPath: string
  distro: string | null
  nativeRoot: string
  mode: ProjectFileWatchMode
  watcher: FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  disposed: boolean
  pending: Map<string, NodeJS.Timeout>
  snapshot: Map<string, SnapshotEntry>
}

const sessions = new Map<number, WatchSession>()

function normalizeDistro(distro: unknown): string | null {
  return typeof distro === 'string' && distro.trim() ? distro.trim() : null
}

function watchKey(req: ProjectFileWatchRequest): string {
  return `${normalizeDistro(req.distro) ?? ''}:${req.rootPath}`
}

function shouldIgnoreRelPath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/')
  return parts.some((part) => IGNORED_DIRS.has(part.toLowerCase()))
}

function toRelPath(filename: string): string | null {
  const safe = confineRelPath(filename)
  if (!safe || shouldIgnoreRelPath(safe) || !isTextLikeProjectFile(safe, false)) return null
  return safe
}

function sendChange(session: WatchSession, relPath: string, info: SnapshotEntry): void {
  if (session.disposed || session.webContents.isDestroyed()) return
  const payload: ProjectFileChangedEvent = {
    rootPath: session.rootPath,
    distro: session.distro,
    relPath,
    name: basename(relPath.replace(/\\/g, '/')),
    size: info.size,
    modifiedMs: info.modifiedMs,
    mode: session.mode
  }
  session.webContents.send(PROJECT_FILE_CHANGED_CHANNEL, payload)
}

async function readFileInfo(nativeRoot: string, relPath: string): Promise<SnapshotEntry | null> {
  try {
    const info = await stat(joinNative(nativeRoot, relPath))
    if (!info.isFile()) return null
    return { size: info.size, modifiedMs: info.mtimeMs }
  } catch {
    return null
  }
}

function queueNativeChange(session: WatchSession, relPath: string): void {
  const existing = session.pending.get(relPath)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    session.pending.delete(relPath)
    readFileInfo(session.nativeRoot, relPath)
      .then((info) => {
        if (!info) return
        session.snapshot.set(relPath, info)
        sendChange(session, relPath, info)
      })
      .catch(() => undefined)
  }, WATCH_DEBOUNCE_MS)
  session.pending.set(relPath, timer)
}

async function scanSnapshot(nativeRoot: string): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>()
  const queue: string[] = ['']

  while (queue.length > 0 && snapshot.size < MAX_POLL_FILES) {
    const parentRel = queue.shift() ?? ''
    let entries
    try {
      entries = await readdir(joinNative(nativeRoot, parentRel), { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const relPath = parentRel ? `${parentRel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!shouldIgnoreRelPath(relPath)) queue.push(relPath)
        continue
      }
      if (!entry.isFile() || shouldIgnoreRelPath(relPath) || !isTextLikeProjectFile(relPath, false)) continue
      const info = await readFileInfo(nativeRoot, relPath)
      if (info) snapshot.set(relPath, info)
      if (snapshot.size >= MAX_POLL_FILES) break
    }
  }

  return snapshot
}

async function pollChanges(session: WatchSession): Promise<void> {
  if (session.disposed) return
  const next = await scanSnapshot(session.nativeRoot)
  if (session.disposed) return

  for (const [relPath, info] of next) {
    const prev = session.snapshot.get(relPath)
    if (!prev || prev.size !== info.size || prev.modifiedMs !== info.modifiedMs) {
      sendChange(session, relPath, info)
    }
  }
  session.snapshot = next
}

async function startPolling(session: WatchSession): Promise<void> {
  if (session.pollTimer) {
    clearInterval(session.pollTimer)
    session.pollTimer = null
  }
  session.mode = 'poll'
  session.snapshot = await scanSnapshot(session.nativeRoot)
  if (session.disposed) return
  session.pollTimer = setInterval(() => {
    void pollChanges(session).catch(() => undefined)
  }, POLL_INTERVAL_MS)
}

async function startNativeSafetyPoll(session: WatchSession): Promise<void> {
  session.snapshot = await scanSnapshot(session.nativeRoot)
  if (session.disposed || session.mode !== 'native') return
  session.pollTimer = setInterval(() => {
    void pollChanges(session).catch(() => undefined)
  }, NATIVE_SAFETY_POLL_INTERVAL_MS)
}

function disposeSession(session: WatchSession): void {
  session.disposed = true
  session.watcher?.close()
  if (session.pollTimer) clearInterval(session.pollTimer)
  for (const timer of session.pending.values()) clearTimeout(timer)
  session.pending.clear()
}

export async function watchProjectFiles(
  req: ProjectFileWatchRequest,
  webContents: WebContents
): Promise<ProjectFileWatchResult> {
  if (!req || typeof req.rootPath !== 'string' || !req.rootPath.trim()) {
    return { ok: false, error: 'Invalid project root' }
  }

  const existing = sessions.get(webContents.id)
  if (existing && watchKey(existing) === watchKey(req)) {
    return { ok: true, mode: existing.mode }
  }
  if (existing) {
    disposeSession(existing)
    sessions.delete(webContents.id)
  }

  const distro = normalizeDistro(req.distro)
  const nativeRoot = toNativeRoot(req.rootPath, distro)
  try {
    const rootInfo = await stat(nativeRoot)
    if (!rootInfo.isDirectory()) return { ok: false, error: 'Project root is not a folder' }
  } catch {
    return { ok: false, error: 'Could not watch this project folder' }
  }

  const session: WatchSession = {
    webContents,
    rootPath: req.rootPath,
    distro,
    nativeRoot,
    mode: distro ? 'poll' : 'native',
    watcher: null,
    pollTimer: null,
    disposed: false,
    pending: new Map(),
    snapshot: new Map()
  }

  sessions.set(webContents.id, session)
  webContents.once('destroyed', () => unwatchProjectFiles(webContents))

  if (distro) {
    await startPolling(session)
    return { ok: true, mode: session.mode }
  }

  try {
    session.watcher = watch(nativeRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) return
      const relPath = toRelPath(String(filename))
      if (relPath) queueNativeChange(session, relPath)
    })
    session.watcher.on('error', () => {
      if (session.disposed) return
      session.watcher?.close()
      session.watcher = null
      void startPolling(session).catch(() => undefined)
    })
    await startNativeSafetyPoll(session)
    return { ok: true, mode: session.mode }
  } catch {
    await startPolling(session)
    return { ok: true, mode: session.mode }
  }
}

export function unwatchProjectFiles(webContents: WebContents): void {
  const session = sessions.get(webContents.id)
  if (!session) return
  disposeSession(session)
  sessions.delete(webContents.id)
}
