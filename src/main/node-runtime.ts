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

function bundledNodePath(): string | null {
  // process.resourcesPath is the packaged app's resources dir. It is undefined
  // under plain Node (e.g. vitest); in dev it points at Electron's own resources,
  // where our bundled node isn't present — both correctly fall back to `node`.
  const resources = process.resourcesPath
  if (!resources) return null
  const exe = process.platform === 'win32' ? 'node.exe' : 'node'
  return join(resources, 'node', exe)
}

// Detect WSL by checking /proc/version for "Microsoft" or "WSL". In WSL, the
// PATH inherits WSL's Node (which may have a TLS fingerprint rejected by
// Cloudflare), so we prefer the Windows Node at the standard install path.
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
  // Standard Windows Node.js install path, accessible from WSL
  const winNode = '/mnt/c/Program Files/nodejs/node.exe'
  return existsSync(winNode) ? winNode : null
}

export function nodeExecutable(): string {
  if (cached) return cached
  const bundled = bundledNodePath()
  if (bundled && existsSync(bundled)) {
    cached = bundled
  } else {
    // In WSL, prefer Windows Node over WSL's own (different TLS fingerprint),
    // falling back to whatever `node` PATH resolves to.
    cached = windowsNodePath() ?? 'node'
  }
  return cached
}
