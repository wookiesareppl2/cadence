import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nodeExecutable } from '../node-runtime'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { UsageWindow } from '@shared/claude-plan-usage'
import { retryAfterHeaderMs, UsageRateLimitError } from './usage-rate-limit'

// Codex usage is fetched live from the ChatGPT/Codex backend, mirroring how Claude
// plan usage works — no local-log scraping (those snapshots are only as fresh as
// the user's last Codex run, so they can never be trusted as current).
//
// The actual HTTP call runs in a spawned real-Node worker (a Node runtime bundled
// with the app, or system `node` in dev — see node-runtime.ts) because Electron's
// bundled BoringSSL TLS stack is rejected by the backend edge with 403; real Node
// (OpenSSL) is accepted. See codex-usage-worker.mjs.
const execFileAsync = promisify(execFile)
const WORKER_TIMEOUT_MS = 20_000
const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/codex/usage'

type WorkerCommand = 'fetch' | 'refresh'
type RunWorker = (command: WorkerCommand) => Promise<string>
type CodexPlanUsageDeps = { runWorker?: RunWorker }

type FetchResult = {
  ok: boolean
  status?: number
  statusText?: string
  retryAfter?: string | null
  body?: string
  error?: string
}
type RefreshResult = { ok: boolean; status?: number; error?: string }

type RawApiWindow = { used_percent?: unknown; reset_at?: unknown } | undefined
type RawApiRateLimit = { primary_window?: RawApiWindow; secondary_window?: RawApiWindow } | undefined

function workerPath(): string {
  const sourcePath = join(process.cwd(), 'src', 'main', 'usage', 'codex-usage-worker.mjs')
  if (existsSync(sourcePath)) return sourcePath
  return join(__dirname, 'codex-usage-worker.mjs')
}

// Convert WSL paths (/mnt/c/...) to Windows paths (C:\...) when spawning
// Windows Node from WSL. Windows Node can't read WSL-style paths.
function toWindowsPathIfNecessary(path: string, nodeExe: string): string {
  if (!nodeExe.endsWith('.exe')) return path
  const match = path.match(/^\/mnt\/([a-z])\/(.*)$/i)
  if (!match) return path
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}`
}

async function runWorkerProcess(command: WorkerCommand): Promise<string> {
  const nodeExe = nodeExecutable()
  const worker = toWindowsPathIfNecessary(workerPath(), nodeExe)
  const { stdout } = await execFileAsync(nodeExe, [worker, command], {
    timeout: WORKER_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
  return stdout
}

function parseWorkerJson<T>(stdout: string): T {
  try {
    return JSON.parse(stdout.trim()) as T
  } catch {
    throw new Error(`Codex usage worker returned an unreadable response: ${stdout.slice(0, 200)}`)
  }
}

function parseApiWindow(raw: RawApiWindow): UsageWindow | null {
  if (!raw || typeof raw.used_percent !== 'number') return null
  return {
    utilization: raw.used_percent,
    resetsAt: typeof raw.reset_at === 'number' ? new Date(raw.reset_at * 1000).toISOString() : null
  }
}

// Classify windows by reset duration rather than field name, so the code adapts
// if Codex removes or reintroduces the 5-hour window. A 5-hour window resets in
// ~5 hours (18000s), a 7-day window in ~7 days (604800s). Use 24 hours as the
// boundary: anything shorter is "5-hour", anything longer is "7-day".
const FIVE_HOUR_BOUNDARY_SECONDS = 24 * 60 * 60

function classifyWindow(raw: RawApiWindow): 'fiveHour' | 'sevenDay' | null {
  if (!raw || typeof raw.reset_at !== 'number') return null
  const secondsUntilReset = raw.reset_at - Date.now() / 1000
  return secondsUntilReset <= FIVE_HOUR_BOUNDARY_SECONDS ? 'fiveHour' : 'sevenDay'
}

function mapLiveUsage(data: { plan_type?: unknown; rate_limit?: RawApiRateLimit }): CodexPlanUsage {
  const rateLimit = data.rate_limit
  const now = new Date().toISOString()

  // Classify each window by duration, not field name
  const primaryClass = classifyWindow(rateLimit?.primary_window)
  const secondaryClass = classifyWindow(rateLimit?.secondary_window)

  let fiveHour: UsageWindow | null = null
  let sevenDay: UsageWindow | null = null

  if (primaryClass === 'fiveHour') {
    fiveHour = parseApiWindow(rateLimit?.primary_window)
  } else if (primaryClass === 'sevenDay') {
    sevenDay = parseApiWindow(rateLimit?.primary_window)
  }

  if (secondaryClass === 'fiveHour') {
    fiveHour = parseApiWindow(rateLimit?.secondary_window)
  } else if (secondaryClass === 'sevenDay') {
    sevenDay = parseApiWindow(rateLimit?.secondary_window)
  }

  return {
    fiveHour,
    sevenDay,
    planType: typeof data.plan_type === 'string' ? data.plan_type : null,
    sourcePath: USAGE_ENDPOINT,
    sourceTimestamp: now,
    isStale: false,
    staleReason: null,
    fetchedAt: now
  }
}

function describeFailure(result: FetchResult): string {
  if (result.error) return result.error
  const status = result.status ?? 0
  const statusText = result.statusText ? ` ${result.statusText}` : ''
  const bodyHint = result.body ? ` — ${result.body.replace(/\s+/g, ' ').trim().slice(0, 200)}` : ''
  return `Codex usage API returned ${status}${statusText}${bodyHint}`
}

export async function fetchCodexPlanUsage(deps: CodexPlanUsageDeps = {}): Promise<CodexPlanUsage> {
  const run = deps.runWorker ?? runWorkerProcess

  let result = parseWorkerJson<FetchResult>(await run('fetch'))

  // Hands-off refresh: on an expired access token, refresh via the OAuth
  // refresh_token (rewriting ~/.codex/auth.json) and retry once — the Codex
  // analogue of Claude's automatic credential refresh.
  if (result.status === 401) {
    const refresh = parseWorkerJson<RefreshResult>(await run('refresh'))
    if (!refresh.ok) {
      throw new Error(`Codex credentials expired and automatic refresh failed: ${refresh.error ?? 'unknown error'}`)
    }
    result = parseWorkerJson<FetchResult>(await run('fetch'))
  }

  if (result.status === 429) {
    throw new UsageRateLimitError(describeFailure(result), retryAfterHeaderMs(result.retryAfter))
  }

  if (!result.ok) {
    throw new Error(describeFailure(result))
  }

  return mapLiveUsage(parseWorkerJson<{ plan_type?: unknown; rate_limit?: RawApiRateLimit }>(result.body ?? '{}'))
}
