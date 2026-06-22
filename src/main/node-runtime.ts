import { existsSync } from 'node:fs'
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

export function nodeExecutable(): string {
  if (cached) return cached
  const bundled = bundledNodePath()
  cached = bundled && existsSync(bundled) ? bundled : 'node'
  return cached
}
