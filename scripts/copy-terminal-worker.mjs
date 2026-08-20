import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Standalone worker scripts that run in system Node (not bundled by electron-vite)
// and are copied alongside the compiled main process.
const workers = [
  ['src/main/terminal/terminal-worker.cjs', 'out/main/terminal-worker.cjs'],
  ['src/main/usage/codex-usage-worker.mjs', 'out/main/codex-usage-worker.mjs']
]

for (const [from, to] of workers) {
  const target = resolve(to)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(resolve(from), target)
}
