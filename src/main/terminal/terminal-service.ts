import { WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlatformId } from '@shared/platform'
import type { TerminalPlatform, TerminalStartResult } from '@shared/terminal'

type WorkerRequest = {
  requestId?: number
  type: 'start' | 'restart' | 'input' | 'resize' | 'close' | 'closeAll'
  terminalId?: string
  platform?: TerminalPlatform
  cwd?: string
  data?: string
  cols?: number
  rows?: number
}

type WorkerMessage =
  | { type: 'started'; requestId: number; result: TerminalStartResult }
  | { type: 'error'; requestId?: number; message: string }
  | { type: 'data'; terminalId: string; platform: TerminalPlatform; data: string }

type PendingRequest = {
  resolve: (value: TerminalStartResult) => void
  reject: (error: Error) => void
}

const VALID_PLATFORMS = new Set<PlatformId>(['claude', 'codex'])

let worker: ChildProcess | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
const subscribers = new Set<WebContents>()
const subscribersWithCleanup = new WeakSet<WebContents>()

function assertPlatform(platform: string): asserts platform is TerminalPlatform {
  if (!VALID_PLATFORMS.has(platform as PlatformId)) {
    throw new Error(`Invalid terminal platform: ${platform}`)
  }
}

function assertTerminalId(terminalId: unknown): asserts terminalId is string {
  if (typeof terminalId !== 'string' || !terminalId || terminalId.length > 128) {
    throw new Error('Invalid terminal id')
  }
}

function terminalCwd(): string {
  return process.env.INIT_CWD || process.cwd() || homedir()
}

function workerPath(): string {
  const sourcePath = join(process.cwd(), 'src', 'main', 'terminal', 'terminal-worker.cjs')
  if (existsSync(sourcePath)) return sourcePath
  return join(__dirname, 'terminal-worker.cjs')
}

function subscribe(webContents: WebContents): void {
  subscribers.add(webContents)

  if (!subscribersWithCleanup.has(webContents)) {
    subscribersWithCleanup.add(webContents)
    webContents.once('destroyed', () => subscribers.delete(webContents))
  }
}

function relayData(terminalId: string, platform: TerminalPlatform, data: string): void {
  for (const webContents of subscribers) {
    if (!webContents.isDestroyed()) {
      webContents.send('terminal:data', { terminalId, platform, data })
    }
  }
}

function rejectAllPending(error: Error): void {
  for (const request of pendingRequests.values()) {
    request.reject(error)
  }
  pendingRequests.clear()
}

function handleWorkerMessage(message: WorkerMessage): void {
  if (message.type === 'data') {
    relayData(message.terminalId, message.platform, message.data)
    return
  }

  if (message.type === 'started') {
    const request = pendingRequests.get(message.requestId)
    pendingRequests.delete(message.requestId)
    request?.resolve(message.result)
    return
  }

  if (message.type === 'error') {
    const error = new Error(message.message)
    if (message.requestId) {
      const request = pendingRequests.get(message.requestId)
      pendingRequests.delete(message.requestId)
      request?.reject(error)
      return
    }
    console.error('Terminal worker error', error)
  }
}

function ensureWorker(): ChildProcess {
  if (worker?.connected) return worker

  const child = spawn('node', [workerPath()], {
    cwd: terminalCwd(),
    env: {
      ...process.env,
      AI_DASHBOARD_TERMINAL_CWD: terminalCwd()
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })

  child.on('message', (message) => handleWorkerMessage(message as WorkerMessage))
  child.stdout?.on('data', (data) => console.log(`[terminal-worker] ${String(data).trimEnd()}`))
  child.stderr?.on('data', (data) => console.error(`[terminal-worker] ${String(data).trimEnd()}`))
  child.on('exit', (code, signal) => {
    rejectAllPending(new Error(`Terminal worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    worker = null
  })

  worker = child
  return child
}

function sendWorkerRequest(request: WorkerRequest): Promise<TerminalStartResult> {
  const requestId = nextRequestId++
  const child = ensureWorker()

  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject })
    child.send?.({ ...request, requestId }, (error) => {
      if (error) {
        pendingRequests.delete(requestId)
        reject(error)
      }
    })
  })
}

export async function startTerminal(
  terminalId: string,
  platform: string,
  webContents: WebContents,
  cwd?: string
): Promise<TerminalStartResult> {
  assertTerminalId(terminalId)
  assertPlatform(platform)
  subscribe(webContents)

  let workspaceCwd: string | undefined
  if (typeof cwd === 'string' && cwd.trim()) {
    if (!existsSync(cwd)) throw new Error(`Workspace folder not found: ${cwd}`)
    workspaceCwd = cwd
  }

  return sendWorkerRequest({ type: 'start', terminalId, platform, cwd: workspaceCwd })
}

export function writeTerminal(terminalId: string, data: string): void {
  assertTerminalId(terminalId)
  if (typeof data !== 'string' || data.length > 20_000) return
  ensureWorker().send?.({ type: 'input', terminalId, data } satisfies WorkerRequest)
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  assertTerminalId(terminalId)
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
  const safeCols = Math.min(300, Math.max(20, cols))
  const safeRows = Math.min(120, Math.max(6, rows))
  ensureWorker().send?.({ type: 'resize', terminalId, cols: safeCols, rows: safeRows } satisfies WorkerRequest)
}

export async function restartTerminal(terminalId: string, webContents: WebContents): Promise<TerminalStartResult> {
  assertTerminalId(terminalId)
  subscribe(webContents)
  return sendWorkerRequest({ type: 'restart', terminalId })
}

export function closeTerminal(terminalId: string): void {
  assertTerminalId(terminalId)
  ensureWorker().send?.({ type: 'close', terminalId } satisfies WorkerRequest)
}

export function closeAllTerminals(): void {
  worker?.send?.({ type: 'closeAll' } satisfies WorkerRequest)
  worker?.kill()
  worker = null
}
