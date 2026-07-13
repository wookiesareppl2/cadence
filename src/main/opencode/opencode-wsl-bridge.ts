import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { nodeExecutable } from '../node-runtime'

type WorkerRequestInput =
  | { type: 'runCommand'; distro: string; command: string; timeoutMs: number }
  | { type: 'startServer'; distro: string; command: string }
  | { type: 'stopServer' }

type WorkerRequest = WorkerRequestInput & { requestId: number }

type WorkerMessage =
  | { type: 'commandResult'; requestId: number; output: string }
  | { type: 'serverStarted'; requestId: number; pid: number }
  | { type: 'serverStopped'; requestId: number }
  | { type: 'serverExit'; exitCode: number; signal?: number; output: string }
  | { type: 'error'; requestId?: number; message: string }

type PendingRequest = {
  resolve: (value: WorkerMessage) => void
  reject: (error: Error) => void
}

let worker: ChildProcess | null = null
let nextRequestId = 1
const pending = new Map<number, PendingRequest>()

function workerPath(): string {
  const sourcePath = join(process.cwd(), 'src', 'main', 'opencode', 'opencode-wsl-worker.cjs')
  if (existsSync(sourcePath)) return sourcePath
  return join(__dirname, 'opencode-wsl-worker.cjs')
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function handleMessage(message: WorkerMessage): void {
  if (message.type === 'serverExit') {
    if (message.output) console.error(`[opencode] ${cleanPtyOutput(message.output)}`)
    return
  }
  if (message.type === 'error' && !message.requestId) {
    console.error('OpenCode WSL worker error', message.message)
    return
  }

  if (!('requestId' in message) || message.requestId === undefined) return
  const requestId = message.requestId
  const request = pending.get(requestId)
  if (!request) return
  pending.delete(requestId)
  if (message.type === 'error') request.reject(new Error(cleanPtyOutput(message.message)))
  else request.resolve(message)
}

function ensureWorker(): ChildProcess {
  if (worker?.connected) return worker
  const child = spawn(nodeExecutable(), [workerPath()], {
    cwd: process.env.INIT_CWD || process.cwd(),
    env: {
      ...process.env,
      AI_DASHBOARD_TERMINAL_CWD: process.env.INIT_CWD || process.cwd()
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })
  child.on('message', (message) => handleMessage(message as WorkerMessage))
  child.stdout?.on('data', (data) => console.log(`[opencode-wsl-worker] ${String(data).trimEnd()}`))
  child.stderr?.on('data', (data) => console.error(`[opencode-wsl-worker] ${String(data).trimEnd()}`))
  child.on('exit', (code, signal) => {
    rejectPending(new Error(`OpenCode WSL worker exited code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    worker = null
  })
  worker = child
  return child
}

function request<T extends WorkerMessage>(input: WorkerRequestInput): Promise<T> {
  const requestId = nextRequestId++
  const child = ensureWorker()
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve: (value) => resolve(value as T), reject })
    child.send?.({ ...input, requestId }, (error) => {
      if (!error) return
      pending.delete(requestId)
      reject(error)
    })
  })
}

function cleanPtyOutput(output: string): string {
  return output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '')
    .trim()
}

export async function runWslCommandViaPty(
  distro: string,
  command: string,
  timeoutMs: number
): Promise<string> {
  const result = await request<{ type: 'commandResult'; requestId: number; output: string }>({
    type: 'runCommand',
    distro,
    command,
    timeoutMs
  })
  return cleanPtyOutput(result.output)
}

export async function startOpenCodeServerViaPty(distro: string, command: string): Promise<number> {
  const result = await request<{ type: 'serverStarted'; requestId: number; pid: number }>({
    type: 'startServer',
    distro,
    command
  })
  return result.pid
}

export async function stopOpenCodeServerViaPty(): Promise<void> {
  if (!worker?.connected) return
  await request<{ type: 'serverStopped'; requestId: number }>({ type: 'stopServer' })
}
