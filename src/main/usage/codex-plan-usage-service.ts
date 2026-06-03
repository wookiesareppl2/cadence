import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { UsageWindow } from '@shared/claude-plan-usage'
import { retryAfterHeaderMs, UsageRateLimitError } from './usage-rate-limit'

// Codex usage is fetched live from the ChatGPT/Codex backend, mirroring how Claude
// plan usage works — no local-log scraping (those snapshots are only as fresh as
// the user's last Codex run, so they can never be trusted as current).
//
// The actual HTTP call runs in a spawned system-Node worker because Electron's
// bundled BoringSSL TLS stack is rejected by the backend edge with 403; system
// Node (OpenSSL) is accepted. See codex-usage-worker.mjs.
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

async function runWorkerProcess(command: WorkerCommand): Promise<string> {
  const { stdout } = await execFileAsync('node', [workerPath(), command], {
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

function mapLiveUsage(data: { plan_type?: unknown; rate_limit?: RawApiRateLimit }): CodexPlanUsage {
  const rateLimit = data.rate_limit
  const now = new Date().toISOString()
  return {
    fiveHour: parseApiWindow(rateLimit?.primary_window),
    sevenDay: parseApiWindow(rateLimit?.secondary_window),
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
