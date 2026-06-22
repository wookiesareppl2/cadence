import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

// Download the standalone Node runtime that gets bundled into packaged Windows
// builds (electron-builder `win.extraResources` copies resources/node -> resources/
// node). Shipping our own Node means the app runs on a clean PC with no system Node,
// gives the Codex usage worker OpenSSL TLS, and pins the ABI the terminal native
// module (node-pty) loads against. See src/main/node-runtime.ts.
//
// Pin Node 22.x: it matches node-pty's locally-built ABI (127) on Windows. Override
// with CADENCE_NODE_VERSION if the bundled-module ABI ever changes.
const NODE_VERSION = process.env.CADENCE_NODE_VERSION || 'v22.14.0'
const target = resolve('resources/node/node.exe')
const versionMarker = resolve('resources/node/.node-version')

async function alreadyCurrent() {
  if (!existsSync(target) || !existsSync(versionMarker)) return false
  return (await readFile(versionMarker, 'utf-8')).trim() === NODE_VERSION
}

async function main() {
  if (await alreadyCurrent()) {
    console.log(`[fetch-node] ${NODE_VERSION} already present — skipping download`)
    return
  }

  const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`
  console.log(`[fetch-node] downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`[fetch-node] ${res.status} ${res.statusText} fetching ${url}`)
  }

  const bytes = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  await writeFile(versionMarker, NODE_VERSION)
  console.log(`[fetch-node] saved ${(bytes.length / 1e6).toFixed(1)} MB -> ${target}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
