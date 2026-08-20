import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The Node executable used to run our helper workers (the terminal pty host and
// the Codex usage fetch). Packaged builds bundle a real Node runtime so the app
// works on a clean PC with no system Node installed. Two hard reasons it must be a
// real Node and not Electron's own runtime:
//   - the Codex usage request needs OpenSSL TLS — Electron's bundled BoringSSL is
//     rejected by the backend edge with 403 (see codex-plan-usage-service.ts);
//   - the terminal native module (node-pty) loads against a fixed Node ABI, so a
//     bundled Node makes that ABI deterministic across machines.
// In dev (unpackaged) and as a safety net, fall back to a system `node`.

let cached: string | null = null
let cachedTlsCapable: string | null = null

function bundledNodePath(): string | null {
  // process.resourcesPath is the packaged app's resources dir. It is undefined
  // under plain Node (e.g. vitest); in dev it points at Electron's own resources,
  // where our bundled node isn't present — both correctly fall back to `node`.
  const resources = process.resourcesPath
  if (!resources) return null
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  return join(resources, 'node', exe)
}

// Detect WSL by checking /proc/version for "Microsoft" or "WSL".
function isWSL(): boolean {
  if (process.platform !== 'linux') return false
  try {
    const version = readFileSync('/proc/version', 'utf-8')
    return /microsoft|wsl/i.test(version)
  } catch {
    return false
  }
}

function windowsNodePath(): string | null {
  if (!isWSL()) return null
  // Standard Windows Node.js install path, reachable from WSL. Guarded by
  // existsSync, so installs elsewhere (nvm-windows, Scoop, a non-C: drive)
  // simply fall through to PATH rather than failing.
  const winNode = '/mnt/c/Program Files/nodejs/node.exe'
  return existsSync(winNode) ? winNode : null
}

// The general-purpose worker Node. MUST stay ABI-compatible with the host
// platform: the terminal pty host loads `node-pty`, a native module built for
// this platform. Never return a Windows node.exe from a Linux/WSL process — it
// cannot dlopen a Linux-built native module, and it cannot read /mnt-style
// worker paths.
export function nodeExecutable(): string {
  if (cached) return cached
  const bundled = bundledNodePath()
  cached = bundled && existsSync(bundled) ? bundled : 'node'
  return cached
}

// The Node used ONLY for the Codex usage fetch, which has a constraint the
// other consumers do not: the backend edge rejects some TLS fingerprints. Under
// WSL, WSL's own Node is rejected, so prefer the Windows Node — safe here
// precisely because this worker is plain JS with no native module, unlike the
// pty host. Callers must convert /mnt-style paths to Windows form when the
// resolved executable is a .exe (see codex-plan-usage-service.ts).
export function tlsCapableNodeExecutable(): string {
  if (cachedTlsCapable) return cachedTlsCapable
  const bundled = bundledNodePath()
  if (bundled && existsSync(bundled)) {
    cachedTlsCapable = bundled
  } else {
    cachedTlsCapable = windowsNodePath() ?? 'node'
  }
  return cachedTlsCapable
}
