import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { tlsCapableNodeExecutable } from '../node-runtime'
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
  const nodeExe = tlsCapableNodeExecutable()
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

// Classify windows by reset duration rather than field name, so the mapping
// stays correct if Codex reorders, removes, or reintroduces a window. A 5-hour
// window resets in ~5 hours (18000s), a 7-day window in ~7 days (604800s);
// 24 hours sits far from both, so ordinary clock skew cannot cross it.
const FIVE_HOUR_BOUNDARY_SECONDS = 24 * 60 * 60

type WindowSlot = 'fiveHour' | 'sevenDay'

// Returns null when the window carries no usable reset time — absent, wrong
// type, or already elapsed. parseApiWindow deliberately tolerates a missing
// reset_at, so "unclassifiable" must never mean "discard": the caller falls
// back to the field's positional meaning instead.
function classifyWindow(raw: RawApiWindow): WindowSlot | null {
  if (!raw || typeof raw.reset_at !== 'number') return null
  const secondsUntilReset = raw.reset_at - Date.now() / 1000
  if (secondsUntilReset < 0) return null
  return secondsUntilReset <= FIVE_HOUR_BOUNDARY_SECONDS ? 'fiveHour' : 'sevenDay'
}

function mapLiveUsage(data: { plan_type?: unknown; rate_limit?: RawApiRateLimit }): CodexPlanUsage {
  const rateLimit = data.rate_limit
  const now = new Date().toISOString()
  const primaryRaw = rateLimit?.primary_window
  const secondaryRaw = rateLimit?.secondary_window
  const primary = parseApiWindow(primaryRaw)
  const secondary = parseApiWindow(secondaryRaw)

  const primaryClass = classifyWindow(primaryRaw)
  const secondaryClass = classifyWindow(secondaryRaw)

  // Trust duration classification wherever it is confident, and never let an
  // unclassifiable window displace a classified one. A window with no usable
  // reset time simply takes whichever slot is left, so it still renders — the
  // previous positional behaviour — instead of vanishing or overwriting.
  let primarySlot: WindowSlot
  if (primaryClass && secondaryClass && primaryClass !== secondaryClass) {
    primarySlot = primaryClass
  } else if (primaryClass && !secondaryClass) {
    primarySlot = primaryClass
  } else if (!primaryClass && secondaryClass) {
    primarySlot = secondaryClass === 'fiveHour' ? 'sevenDay' : 'fiveHour'
  } else {
    // Neither is classifiable, or both claim the same slot: fall back to each
    // field's positional meaning (primary = 5-hour, secondary = 7-day).
    primarySlot = 'fiveHour'
  }

  return {
    fiveHour: primarySlot === 'fiveHour' ? primary : secondary,
    sevenDay: primarySlot === 'sevenDay' ? primary : secondary,
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
