import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import type { ClaudePlanUsage, ExtraUsage, UsageWindow } from '@shared/claude-plan-usage'
import { retryAfterHeaderMs, UsageRateLimitError } from './usage-rate-limit'

const API_BASE = 'https://api.anthropic.com/api/oauth'
const USER_AGENT = 'claude-code/2.1.152'
const BETA_HEADER = 'oauth-2025-04-20'
const REFRESH_TIMEOUT_MS = 45_000
const execFileAsync = promisify(execFile)
let refreshPromise: Promise<void> | null = null

function readAccessToken(): string {
  const credPath = join(app.getPath('home'), '.claude', '.credentials.json')
  const raw = readFileSync(credPath, 'utf-8')
  const creds = JSON.parse(raw)
  const token = creds?.claudeAiOauth?.accessToken
  if (!token || typeof token !== 'string') {
    throw new Error('No Claude OAuth access token found in ~/.claude/.credentials.json')
  }
  return token
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
  refreshCredentials?: () => Promise<void>
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

function claudeRefreshCommand(): { file: string; args: string[] } {
  const prompt = 'Respond with exactly: pong'
  const printArgs = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--no-session-persistence',
    '--max-budget-usd',
    '0.01',
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--tools',
    ''
  ]

  if (process.platform !== 'win32') {
    return { file: 'claude', args: printArgs }
  }

  return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'claude', ...printArgs] }
}

async function runClaudeRefreshCommand(): Promise<void> {
  const { file, args } = claudeRefreshCommand()
  await execFileAsync(file, args, {
    timeout: REFRESH_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  })
}

async function refreshClaudeCredentials(): Promise<void> {
  refreshPromise ??= runClaudeRefreshCommand().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function fetchWithOptionalCredentialRefresh(
  fetchUsage: FetchUsage,
  readToken: () => string,
  refreshCredentials: () => Promise<void>
): Promise<UsageResponse> {
  let res = await fetchUsage(readToken())

  if (res.status !== 401) {
    return res
  }

  try {
    await refreshCredentials()
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`Claude credentials expired and automatic refresh failed: ${detail}`)
  }

  res = await fetchUsage(readToken())

  if (res.status === 401) {
    throw new Error('Claude credentials expired and automatic refresh did not produce a valid access token')
  }

  return res
}

export async function fetchClaudePlanUsage(deps: ClaudePlanUsageDeps = {}): Promise<ClaudePlanUsage> {
  const res = await fetchWithOptionalCredentialRefresh(
    deps.fetchUsage ?? fetchUsageWithToken,
    deps.readToken ?? readAccessToken,
    deps.refreshCredentials ?? refreshClaudeCredentials
  )

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
