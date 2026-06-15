import { shell } from 'electron'
import { open, readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PlatformId } from '@shared/platform'
import {
  findJsonlFiles,
  isClaudeTranscriptPath,
  projectId as makeProjectId,
  readCodexSessionDetails
} from './session-service'
import { getSessionOrigins, type SessionOriginRoot } from './session-origins'
import { clearProjectAlias, clearSessionAlias } from './session-metadata-service'
import { removeWorkspace } from '../workspaces/workspace-service'

export type DeleteResult = { trashed: number }

const CWD_HEAD_BYTES = 64 * 1024

function isWslUncPath(path: string): boolean {
  return /^\\\\wsl(\.localhost|\$)\\/i.test(path)
}

// Send each path to the OS Recycle Bin (recoverable). Failures are swallowed
// per-item so one locked file can't abort the whole delete; the count reflects
// what actually moved.
async function trashAll(paths: Iterable<string>): Promise<number> {
  let trashed = 0
  for (const path of paths) {
    try {
      await shell.trashItem(path)
      trashed += 1
    } catch {
      // The Recycle Bin doesn't cover WSL's 9P share, so trashItem throws there.
      // Fall back to a permanent delete for WSL items only — otherwise "delete"
      // would silently no-op for them. Native Windows paths keep the safe
      // skip-on-failure behavior (a locked file is left alone).
      if (isWslUncPath(path)) {
        try {
          await rm(path, { recursive: true, force: true })
          trashed += 1
        } catch {
          // Item may already be gone or locked; skip it.
        }
      }
    }
  }
  return trashed
}

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

// The cwd sits on the first rows of a Claude transcript, so a head read is enough
// to identify which project (directory) a file belongs to.
async function readClaudeCwd(path: string): Promise<string | null> {
  try {
    const head = await readHead(path, CWD_HEAD_BYTES)
    for (const line of head.split(/\r?\n/)) {
      if (!line) continue
      try {
        const row = JSON.parse(line)
        if (typeof row.cwd === 'string') return row.cwd
      } catch {
        // Partial last line in the head sample — ignore.
      }
    }
  } catch {
    // Unreadable file — treat as no cwd.
  }
  return null
}

// Transcript files that belong to a Claude sessionId: matched by filename
// (`<sessionId>.jsonl`) or because the file's rows carry the sessionId (Claude
// reuses one id across resumed files). Mirrors getClaudeSessionFiles matching.
async function claudeSessionFiles(sessionId: string): Promise<string[]> {
  const origins = await getSessionOrigins()

  for (const origin of origins) {
    const root = origin.claudeProjectsDir
    const files = (await findJsonlFiles(root)).filter((path) => isClaudeTranscriptPath(root, path))
    const matches: string[] = []

    for (const path of files) {
      if (basename(path, '.jsonl') === sessionId) {
        matches.push(path)
        continue
      }
      try {
        const raw = await readFile(path, 'utf-8')
        if (raw.includes(`"sessionId":"${sessionId}"`)) matches.push(path)
      } catch {
        // Unreadable file — skip.
      }
    }

    if (matches.length > 0) return matches
  }

  return []
}

async function codexSessionFiles(sessionId: string): Promise<string[]> {
  const origins = await getSessionOrigins()

  for (const origin of origins) {
    const files = (await findJsonlFiles(origin.codexSessionsDir)).filter((path) =>
      basename(path).includes(sessionId)
    )
    if (files.length > 0) return files
  }

  return []
}

// Resolve the project directory (or directories) under ~/.claude/projects whose
// derived projectId matches. Trashing the whole dir removes every session it
// holds — including any beyond the list's display cap — which is the intended
// semantic for "delete project".
async function claudeProjectDirsForOrigin(origin: SessionOriginRoot, targetProjectId: string): Promise<string[]> {
  const root = origin.claudeProjectsDir
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)

    let dirFiles
    try {
      dirFiles = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    if (dirFiles.length === 0) continue

    const representative = join(dir, dirFiles[0])
    const cwd = await readClaudeCwd(representative)
    if (makeProjectId('claude', cwd, dir, origin) === targetProjectId) dirs.push(dir)
  }

  return dirs
}

async function claudeProjectDirs(targetProjectId: string): Promise<string[]> {
  const origins = await getSessionOrigins()
  const perOrigin = await Promise.all(origins.map((origin) => claudeProjectDirsForOrigin(origin, targetProjectId)))
  return perOrigin.flat()
}

// Codex has no project folder — sessions are scattered by date. Resolve every
// rollout file whose session_meta.cwd maps to the target project.
async function codexProjectFiles(targetProjectId: string): Promise<string[]> {
  const origins = await getSessionOrigins()
  const matches: string[] = []

  for (const origin of origins) {
    const files = await findJsonlFiles(origin.codexSessionsDir)
    for (const path of files) {
      const { cwd } = await readCodexSessionDetails(path)
      if (makeProjectId('codex', cwd, undefined, origin) === targetProjectId) matches.push(path)
    }
  }

  return matches
}

export async function deleteSession(platform: PlatformId, sessionId: string): Promise<DeleteResult> {
  const files = platform === 'claude' ? await claudeSessionFiles(sessionId) : await codexSessionFiles(sessionId)
  const trashed = await trashAll(files)
  await clearSessionAlias(platform, sessionId)
  return { trashed }
}

export async function deleteProject(platform: PlatformId, targetProjectId: string): Promise<DeleteResult> {
  const targets =
    platform === 'claude' ? await claudeProjectDirs(targetProjectId) : await codexProjectFiles(targetProjectId)
  const trashed = await trashAll(targets)

  await clearProjectAlias(targetProjectId)
  // A projectId is `<platform>:<workspace-id>`; strip the platform prefix to get
  // the attached-workspace id so an empty attached project also detaches.
  const workspaceId = targetProjectId.slice(platform.length + 1)
  if (workspaceId) await removeWorkspace(workspaceId)

  return { trashed }
}
