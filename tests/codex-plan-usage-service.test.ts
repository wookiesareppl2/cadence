import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchCodexPlanUsage } from '../src/main/usage/codex-plan-usage-service'

type RunWorker = (command: 'fetch' | 'refresh') => Promise<string>

// Use fake timers so reset_at timestamps classify deterministically by duration
const FAKE_NOW_MS = 1780000000000 // Fixed reference point
const FIVE_HOURS_SECONDS = 5 * 60 * 60
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FAKE_NOW_MS)
})

afterEach(() => {
  vi.useRealTimers()
})

// Both windows present: 5-hour resets soon, 7-day resets in a week
const fetchBothWindows = JSON.stringify({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 42, reset_at: FAKE_NOW_MS / 1000 + FIVE_HOURS_SECONDS },
      secondary_window: { used_percent: 24, reset_at: FAKE_NOW_MS / 1000 + SEVEN_DAYS_SECONDS }
    }
  })
})

// Weekly-only: Codex removed the 5-hour window, so only primary_window exists
const fetchWeeklyOnly = JSON.stringify({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 67, reset_at: FAKE_NOW_MS / 1000 + SEVEN_DAYS_SECONDS }
    }
  })
})

// Windows swapped: primary is weekly, secondary is 5-hour (edge case)
const fetchSwappedWindows = JSON.stringify({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 30, reset_at: FAKE_NOW_MS / 1000 + SEVEN_DAYS_SECONDS },
      secondary_window: { used_percent: 80, reset_at: FAKE_NOW_MS / 1000 + FIVE_HOURS_SECONDS }
    }
  })
})

const fetch401 = JSON.stringify({ ok: false, status: 401, statusText: 'Unauthorized', body: 'expired' })
const fetch403 = JSON.stringify({
  ok: false,
  status: 403,
  statusText: 'Forbidden',
  body: '<html><body>Just a moment...</body></html>'
})
const fetch429 = JSON.stringify({
  ok: false,
  status: 429,
  statusText: 'Too Many Requests',
  retryAfter: '180',
  body: 'too many requests'
})

describe('Codex plan usage service', () => {
  it('maps both windows correctly when 5-hour and weekly are present', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetchBothWindows)

    const result = await fetchCodexPlanUsage({ runWorker })

    expect(runWorker).toHaveBeenCalledTimes(1)
    expect(runWorker).toHaveBeenCalledWith('fetch')
    expect(result.fiveHour?.utilization).toBe(42)
    expect(result.sevenDay?.utilization).toBe(24)
    expect(result.fiveHour?.resetsAt).toBe(new Date((FAKE_NOW_MS / 1000 + FIVE_HOURS_SECONDS) * 1000).toISOString())
    expect(result.planType).toBe('plus')
    expect(result.isStale).toBe(false)
  })

  it('classifies weekly-only usage correctly when 5-hour window is absent', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetchWeeklyOnly)

    const result = await fetchCodexPlanUsage({ runWorker })

    expect(result.fiveHour).toBeNull()
    expect(result.sevenDay?.utilization).toBe(67)
    expect(result.sevenDay?.resetsAt).toBe(new Date((FAKE_NOW_MS / 1000 + SEVEN_DAYS_SECONDS) * 1000).toISOString())
  })

  it('classifies windows by duration even when field order is swapped', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetchSwappedWindows)

    const result = await fetchCodexPlanUsage({ runWorker })

    expect(result.fiveHour?.utilization).toBe(80)
    expect(result.sevenDay?.utilization).toBe(30)
  })

  it('refreshes credentials and retries once after a 401', async () => {
    const runWorker = vi.fn<RunWorker>()
      .mockResolvedValueOnce(fetch401) // first fetch
      .mockResolvedValueOnce(JSON.stringify({ ok: true })) // refresh
      .mockResolvedValueOnce(fetchBothWindows) // retried fetch

    const result = await fetchCodexPlanUsage({ runWorker })

    expect(runWorker.mock.calls.map((call) => call[0])).toEqual(['fetch', 'refresh', 'fetch'])
    expect(result.fiveHour?.utilization).toBe(42)
    expect(result.sevenDay?.utilization).toBe(24)
  })

  it('does not refresh when the first fetch succeeds', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetchBothWindows)

    await fetchCodexPlanUsage({ runWorker })

    expect(runWorker).toHaveBeenCalledTimes(1)
    expect(runWorker).not.toHaveBeenCalledWith('refresh')
  })

  it('throws when refresh fails after a 401', async () => {
    const runWorker = vi.fn()
      .mockResolvedValueOnce(fetch401)
      .mockResolvedValueOnce(JSON.stringify({ ok: false, error: 'No Codex refresh token in ~/.codex/auth.json' }))

    await expect(fetchCodexPlanUsage({ runWorker })).rejects.toThrow(/automatic refresh failed.*No Codex refresh token/)
  })

  it('surfaces the HTTP status and body on a non-401 failure', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetch403)

    await expect(fetchCodexPlanUsage({ runWorker })).rejects.toThrow(/403 Forbidden.*Just a moment/)
  })

  it('surfaces 429 responses with retry-after timing', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetch429)

    await expect(fetchCodexPlanUsage({ runWorker })).rejects.toMatchObject({
      name: 'UsageRateLimitError',
      retryAfterMs: 180_000
    })
  })

  it('surfaces a worker-level error message verbatim', async () => {
    const runWorker = vi.fn().mockResolvedValue(
      JSON.stringify({ ok: false, status: 0, error: 'No Codex access token in ~/.codex/auth.json' })
    )

    await expect(fetchCodexPlanUsage({ runWorker })).rejects.toThrow(/No Codex access token/)
  })
})
