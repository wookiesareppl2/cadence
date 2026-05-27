import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ClaudePlanUsage, ExtraUsage, UsageWindow } from '@shared/claude-plan-usage'

const API_BASE = 'https://api.anthropic.com/api/oauth'
const USER_AGENT = 'claude-code/2.1.152'
const BETA_HEADER = 'oauth-2025-04-20'

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

export async function fetchClaudePlanUsage(): Promise<ClaudePlanUsage> {
  const token = readAccessToken()

  const res = await fetch(`${API_BASE}/usage`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': BETA_HEADER,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/json'
    }
  })

  if (res.status === 401) {
    throw new Error('Claude credentials expired — run any `claude` command to refresh')
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
