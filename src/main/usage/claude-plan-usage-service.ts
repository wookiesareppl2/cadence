import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import type { ClaudePlanUsage, ExtraUsage, UsageWindow } from '@shared/claude-plan-usage'
import { retryAfterHeaderMs, UsageRateLimitError } from './usage-rate-limit'

const API_BASE = 'https://api.anthropic.com/api/oauth'
const USER_AGENT = 'claude-code/2.1.152'
const BETA_HEADER = 'oauth-2025-04-20'
const REFRESH_TIMEOUT_MS = 45_000
const REFRESH_MAX_BUFFER = 1024 * 1024
let refreshPromise: Promise<void> | null = null

// Refresh slightly before the token actually lapses so we never spend a
// guaranteed-401 request on the boundary.
const EXPIRY_SKEW_MS = 60_000

function credentialsPath(): string {
  return join(app.getPath('home'), '.claude', '.credentials.json')
}

function readAccessToken(): string {
  const raw = readFileSync(credentialsPath(), 'utf-8')
  const creds = JSON.parse(raw)
  const token = creds?.claudeAiOauth?.accessToken
  if (!token || typeof token !== 'string') {
    throw new Error('No Claude OAuth access token found in ~/.claude/.credentials.json')
  }
  return token
}

// Best-effort: returns the stored token's expiry (ms epoch), or null when it
// can't be determined (file missing, unparseable, or field absent). A null
// expiry skips the proactive refresh and falls back to the reactive 401 path.
function readTokenExpiry(): number | null {
  try {
    const creds = JSON.parse(readFileSync(credentialsPath(), 'utf-8'))
    const expiresAt = creds?.claudeAiOauth?.expiresAt
    return typeof expiresAt === 'number' ? expiresAt : null
  } catch {
    return null
  }
}

function isTokenExpired(expiresAt: number | null, nowMs: number): boolean {
  return expiresAt !== null && nowMs >= expiresAt - EXPIRY_SKEW_MS
}

type RawWindow = { utilization: number; resets_at: string | null } | null
type RawExtraUsage = {
  is_enabled: boolean
  monthly_limit: number
  used_credits: number
  utilization: number
  currency: string
  disabled_reason: string | null
} | null

type UsageResponse = Pick<Response, 'status' | 'ok' | 'statusText' | 'json'> & {
  headers?: Pick<Headers, 'get'>
}
type FetchUsage = (token: string) => Promise<UsageResponse>
type ClaudePlanUsageDeps = {
  fetchUsage?: FetchUsage
  readToken?: () => string
  readTokenExpiry?: () => number | null
  refreshCredentials?: () => Promise<void>
  now?: () => number
}

function parseWindow(raw: RawWindow): UsageWindow | null {
  if (!raw || typeof raw.utilization !== 'number') return null
  return { utilization: raw.utilization, resetsAt: raw.resets_at }
}

function parseExtraUsage(raw: RawExtraUsage): ExtraUsage | null {
  if (!raw) return null
  return {
    isEnabled: raw.is_enabled,
    monthlyLimit: raw.monthly_limit,
    usedCredits: raw.used_credits,
    utilization: raw.utilization,
    currency: raw.currency,
    disabledReason: raw.disabled_reason
  }
}

async function fetchUsageWithToken(token: string): Promise<UsageResponse> {
  return fetch(`${API_BASE}/usage`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': BETA_HEADER,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json'
    }
  })
}

type RefreshCommand = { file: string; args: string[] }

function claudeRefreshCommand(): RefreshCommand {
  const prompt = 'Respond with exactly: pong'
  return {
    file: 'claude',
    args: [
      '-p',
      prompt,
      // Pin Haiku so the throwaway refresh ping has a predictable, tiny cost
      // regardless of the user's default model. Inheriting Opus made a single
      // turn (system-prompt cache creation) cost ~$0.05 and trip the budget.
      '--model',
      'claude-haiku-4-5',
      '--output-format',
      'json',
      '--no-session-persistence',
      // Headroom above one Haiku turn (~$0.011) so the command exits 0 and
      // rotates the OAuth token instead of aborting with error_max_budget_usd.
      '--max-budget-usd',
      '0.05',
      '--permission-mode',
      'dontAsk',
      '--disable-slash-commands',
      '--tools',
      ''
    ]
  }
}

function commandLabel({ file, args }: RefreshCommand): string {
  return [file, ...args]
    .map((arg) => {
      if (arg === '') return '""'
      return /\s/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg
    })
    .join(' ')
}

function appendOutput(buffer: string, chunk: Buffer | string): string {
  if (buffer.length >= REFRESH_MAX_BUFFER) return buffer
  return (buffer + chunk.toString()).slice(0, REFRESH_MAX_BUFFER)
}

async function runRefreshProcess(command: RefreshCommand): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timeout: NodeJS.Timeout

    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve()
    }

    timeout = setTimeout(() => {
      child.kill()
      settle(new Error(`${commandLabel(command)} timed out after ${REFRESH_TIMEOUT_MS}ms`))
    }, REFRESH_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, chunk)
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, chunk)
    })
    child.on('error', (error) => settle(error))
    child.on('close', (code, signal) => {
      if (code === 0) {
        settle()
        return
      }

      const output = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n')
      const suffix = output ? `: ${output}` : ''
      const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      settle(new Error(`${commandLabel(command)} failed with ${status}${suffix}`))
    })
  })
}

async function runClaudeRefreshCommand(): Promise<void> {
  await runRefreshProcess(claudeRefreshCommand())
}

export const __testing = {
  claudeRefreshCommand
}

async function refreshClaudeCredentials(): Promise<void> {
  refreshPromise ??= runClaudeRefreshCommand().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function refreshOrThrow(refreshCredentials: () => Promise<void>): Promise<void> {
  try {
    await refreshCredentials()
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`Claude credentials expired and automatic refresh failed: ${detail}`)
  }
}

type RefreshFlowDeps = {
  fetchUsage: FetchUsage
  readToken: () => string
  readTokenExpiry: () => number | null
  refreshCredentials: () => Promise<void>
  now: () => number
}

async function fetchWithOptionalCredentialRefresh(deps: RefreshFlowDeps): Promise<UsageResponse> {
  const { fetchUsage, readToken, readTokenExpiry, refreshCredentials, now } = deps

  // Proactive: refresh up front when the stored token is already expired so the
  // first request isn't a guaranteed 401. Skipped when expiry is unknown.
  let alreadyRefreshed = false
  if (isTokenExpired(readTokenExpiry(), now())) {
    await refreshOrThrow(refreshCredentials)
    alreadyRefreshed = true
  }

  let res = await fetchUsage(readToken())

  if (res.status !== 401) {
    return res
  }

  // Already refreshed but still rejected — refreshing again won't help.
  if (alreadyRefreshed) {
    throw new Error('Claude credentials expired and automatic refresh did not produce a valid access token')
  }

  // Reactive fallback: token was rejected despite not looking expired.
  await refreshOrThrow(refreshCredentials)

  res = await fetchUsage(readToken())

  if (res.status === 401) {
    throw new Error('Claude credentials expired and automatic refresh did not produce a valid access token')
  }

  return res
}

export async function fetchClaudePlanUsage(deps: ClaudePlanUsageDeps = {}): Promise<ClaudePlanUsage> {
  const res = await fetchWithOptionalCredentialRefresh({
    fetchUsage: deps.fetchUsage ?? fetchUsageWithToken,
    readToken: deps.readToken ?? readAccessToken,
    readTokenExpiry: deps.readTokenExpiry ?? readTokenExpiry,
    refreshCredentials: deps.refreshCredentials ?? refreshClaudeCredentials,
    now: deps.now ?? Date.now
  })

  if (res.status === 401) {
    throw new Error('Claude credentials expired — run any `claude` command to refresh')
  }

  if (res.status === 429) {
    throw new UsageRateLimitError(
      `Claude usage API returned 429: ${res.statusText || 'Too Many Requests'}`,
      retryAfterHeaderMs(res.headers?.get('retry-after'))
    )
  }

  if (!res.ok) {
    throw new Error(`Usage API returned ${res.status}: ${res.statusText}`)
  }

  const data = await res.json()

  return {
    fiveHour: parseWindow(data.five_hour),
    sevenDay: parseWindow(data.seven_day),
    extraUsage: parseExtraUsage(data.extra_usage),
    fetchedAt: new Date().toISOString()
  }
}
