import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const source = resolve('src/main/terminal/terminal-worker.cjs')
const target = resolve('out/main/terminal-worker.cjs')

await mkdir(dirname(target), { recursive: true })
await copyFile(source, target)
