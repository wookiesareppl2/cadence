import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionOrigin } from '@shared/sessions'

// A discovered place to scan for Claude/Codex transcripts: the Windows home, or a
// WSL distro home reached over the \\wsl.localhost UNC share. Reading these paths
// auto-starts a stopped distro's 9P file server, which is the accepted trade-off
// for always surfacing WSL sessions (see the "Always auto-scan all" decision).
export type SessionOriginRoot = SessionOrigin & {
  home: string
  claudeProjectsDir: string
  codexSessionsDir: string
  codexIndexFile: string
}

const ORIGINS_TTL_MS = 60_000
const WSL_LIST_TIMEOUT_MS = 8_000

// Internal/system distros that never hold a user's coding sessions.
const SKIP_DISTRO = /^docker-desktop(-data)?$/i

let cache: { value: Promise<SessionOriginRoot[]>; expiresAt: number } | null = null

function windowsOrigin(): SessionOriginRoot {
  const home = app.getPath('home')
  return {
    id: 'windows',
    kind: 'windows',
    label: 'Windows',
    distro: null,
    home,
    claudeProjectsDir: join(home, '.claude', 'projects'),
    codexSessionsDir: join(home, '.codex', 'sessions'),
    codexIndexFile: join(home, '.codex', 'session_index.jsonl')
  }
}

function wslHome(distro: string, posixHome: string): SessionOriginRoot {
  // `\\wsl.localhost\<distro>\<linux path with backslashes>`
  const home = `\\\\wsl.localhost\\${distro}${posixHome.replace(/\//g, '\\')}`
  return {
    id: `wsl:${distro}`,
    kind: 'wsl',
    label: distro,
    distro,
    home,
    claudeProjectsDir: join(home, '.claude', 'projects'),
    codexSessionsDir: join(home, '.codex', 'sessions'),
    codexIndexFile: join(home, '.codex', 'session_index.jsonl')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// `wsl.exe -l -q` prints installed distro names, one per line, encoded UTF-16LE
// with embedded NULs. Decode and clean it up.
function listWslDistros(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-l', '-q'],
      { timeout: WSL_LIST_TIMEOUT_MS, windowsHide: true, encoding: 'buffer', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve([])
          return
        }
        const names = Buffer.from(stdout)
          .toString('utf16le')
          .split(/\r?\n/)
          .map((line) => line.replace(/\0/g, '').trim())
          .filter((line) => line.length > 0 && !SKIP_DISTRO.test(line))
        resolve(names)
      }
    )
  })
}

// For a distro, find the user home(s) that actually hold a Claude/Codex store.
// We probe `/root` plus each `/home/<user>` so we don't have to boot a shell.
async function wslOriginsForDistro(distro: string): Promise<SessionOriginRoot[]> {
  const base = `\\\\wsl.localhost\\${distro}`
  const candidates = new Set<string>(['/root'])

  try {
    const homeEntries = await readdir(join(base, 'home'), { withFileTypes: true })
    for (const entry of homeEntries) {
      if (entry.isDirectory()) candidates.add(`/home/${entry.name}`)
    }
  } catch {
    // No /home or distro not reachable — fall back to /root probe only.
  }

  const origins: SessionOriginRoot[] = []
  await Promise.all(
    [...candidates].map(async (posixHome) => {
      const origin = wslHome(distro, posixHome)
      const [hasClaude, hasCodex] = await Promise.all([
        pathExists(origin.claudeProjectsDir),
        pathExists(origin.codexSessionsDir)
      ])
      if (hasClaude || hasCodex) origins.push(origin)
    })
  )
  return origins
}

async function discoverOrigins(): Promise<SessionOriginRoot[]> {
  const origins: SessionOriginRoot[] = [windowsOrigin()]

  if (process.platform !== 'win32') return origins

  try {
    const distros = await listWslDistros()
    const wslOrigins = await Promise.all(distros.map((distro) => wslOriginsForDistro(distro).catch(() => [])))
    for (const list of wslOrigins) origins.push(...list)
  } catch {
    // WSL discovery is best-effort; never let it break the Windows scan.
  }

  return origins
}

// Cached so the repeated session/usage/history scans (the renderer polls) don't
// re-run wsl.exe and re-enumerate UNC homes every call. Distros rarely change.
export function getSessionOrigins(): Promise<SessionOriginRoot[]> {
  const now = Date.now()
  if (cache && cache.expiresAt > now) return cache.value
  const value = discoverOrigins().catch(() => [windowsOrigin()])
  cache = { value, expiresAt: now + ORIGINS_TTL_MS }
  return value
}

export function toSessionOrigin(origin: SessionOriginRoot): SessionOrigin {
  return { id: origin.id, kind: origin.kind, label: origin.label, distro: origin.distro }
}
