import type { OpenCodePlanUsage } from '@shared/opencode'
import { listAllOpenCodeMessages } from './opencode-session-service'

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
const FIVE_HOUR_LIMIT = 12
const SEVEN_DAY_LIMIT = 30
const MONTHLY_LIMIT = 60
const CACHE_MS = 30_000

let cache: { expiresAt: number; value: OpenCodePlanUsage } | null = null

export type OpenCodeCostRecord = {
  role: string
  cost?: number
  time: { created: number }
}

function rollingCost(messages: OpenCodeCostRecord[], now: number, duration: number): number {
  const start = now - duration
  return messages.reduce(
    (sum, message) => (message.time.created >= start ? sum + Math.max(0, message.cost ?? 0) : sum),
    0
  )
}

function resetAt(messages: OpenCodeCostRecord[], now: number, duration: number): string | null {
  const start = now - duration
  const oldest = messages
    .filter((message) => message.time.created >= start)
    .sort((a, b) => a.time.created - b.time.created)[0]
  return oldest ? new Date(oldest.time.created + duration).toISOString() : null
}

function utilization(cost: number, limit: number): number {
  return Math.min(100, Math.max(0, (cost / limit) * 100))
}

export function summarizeOpenCodeUsage(
  records: OpenCodeCostRecord[],
  now = Date.now()
): OpenCodePlanUsage {
  const messages = records.filter((message) => message.role === 'assistant')
  const fiveHourCost = rollingCost(messages, now, FIVE_HOURS_MS)
  const sevenDayCost = rollingCost(messages, now, SEVEN_DAYS_MS)
  const monthlyCost = rollingCost(messages, now, THIRTY_DAYS_MS)
  return {
    fiveHour: {
      utilization: utilization(fiveHourCost, FIVE_HOUR_LIMIT),
      resetsAt: resetAt(messages, now, FIVE_HOURS_MS)
    },
    sevenDay: {
      utilization: utilization(sevenDayCost, SEVEN_DAY_LIMIT),
      resetsAt: resetAt(messages, now, SEVEN_DAYS_MS)
    },
    monthly: {
      utilization: utilization(monthlyCost, MONTHLY_LIMIT),
      resetsAt: resetAt(messages, now, THIRTY_DAYS_MS)
    },
    fiveHourCost,
    sevenDayCost,
    monthlyCost,
    source: 'local-sessions',
    isEstimate: true,
    fetchedAt: new Date(now).toISOString(),
    refresh: {
      state: 'fresh',
      nextRefreshAt: new Date(now + CACHE_MS).toISOString(),
      message: 'Estimated from local OpenCode session costs'
    }
  }
}

export async function getOpenCodePlanUsage(): Promise<OpenCodePlanUsage> {
  if (cache && cache.expiresAt > Date.now()) return cache.value
  const now = Date.now()
  const rows = await listAllOpenCodeMessages()
  const value = summarizeOpenCodeUsage(rows.map((row) => row.info), now)
  cache = { expiresAt: now + CACHE_MS, value }
  return value
}

export function invalidateOpenCodeUsage(): void {
  cache = null
}
