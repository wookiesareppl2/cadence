import { WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PlatformId } from '@shared/platform'
import type { TerminalPlatform, TerminalStartResult } from '@shared/terminal'

type WorkerRequest = {
  requestId?: number
  type: 'start' | 'restart' | 'input' | 'resize' | 'closeAll'
  platform?: TerminalPlatform
  data?: string
  cols?: number
  rows?: number
}

type WorkerMessage =
  | { type: 'started'; requestId: number; result: TerminalStartResult }
  | { type: 'error'; requestId?: number; message: string }
  | { type: 'data'; platform: TerminalPlatform; data: string }

type PendingRequest = {
  resolve: (value: TerminalStartResult) => void
  reject: (error: Error) => void
}

const VALID_PLATFORMS = new Set<PlatformId>(['claude', 'codex'])

let worker: ChildProcess | null = null
let nextRequestId = 1
const pendingRequests = new Map<number, PendingRequest>()
const subscribers = new Map<TerminalPlatform, Set<WebContents>>()
const subscribersWithCleanup = new WeakSet<WebContents>()

function assertPlatform(platform: string): asserts platform is TerminalPlatform {
  if (!VALID_PLATFORMS.has(platform as PlatformId)) {
    throw new Error(`Invalid terminal platform: ${platform}`)
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

function subscribe(platform: TerminalPlatform, webContents: WebContents): void {
  const platformSubscribers = subscribers.get(platform) ?? new Set<WebContents>()
  platformSubscribers.add(webContents)
  subscribers.set(platform, platformSubscribers)

  if (!subscribersWithCleanup.has(webContents)) {
    subscribersWithCleanup.add(webContents)
    webContents.once('destroyed', () => {
      for (const platformSubscribers of subscribers.values()) {
        platformSubscribers.delete(webContents)
      }
    })
  }
}

function relayData(platform: TerminalPlatform, data: string): void {
  for (const webContents of subscribers.get(platform) ?? []) {
    if (!webContents.isDestroyed()) {
      webContents.send('terminal:data', { platform, data })
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
    relayData(message.platform, message.data)
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

export async function startTerminal(platform: string, webContents: WebContents): Promise<TerminalStartResult> {
  assertPlatform(platform)
  subscribe(platform, webContents)
  return sendWorkerRequest({ type: 'start', platform })
}

export function writeTerminal(platform: string, data: string): void {
  assertPlatform(platform)
  if (typeof data !== 'string' || data.length > 20_000) return
  ensureWorker().send?.({ type: 'input', platform, data } satisfies WorkerRequest)
}

export function resizeTerminal(platform: string, cols: number, rows: number): void {
  assertPlatform(platform)
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
  const safeCols = Math.min(300, Math.max(20, cols))
  const safeRows = Math.min(120, Math.max(6, rows))
  ensureWorker().send?.({ type: 'resize', platform, cols: safeCols, rows: safeRows } satisfies WorkerRequest)
}

export async function restartTerminal(platform: string, webContents: WebContents): Promise<TerminalStartResult> {
  assertPlatform(platform)
  subscribe(platform, webContents)
  return sendWorkerRequest({ type: 'restart', platform })
}

export function closeAllTerminals(): void {
  worker?.send?.({ type: 'closeAll' } satisfies WorkerRequest)
  worker?.kill()
  worker = null
}
