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

  // Pin the 24-hour boundary from both sides. This has to be set up so that
  // crossing it CHANGES the observable result: with primary already weekly, a
  // secondary inside the boundary classifies as 5-hour and the windows swap,
  // while a secondary outside it collides with primary and falls back to the
  // positional split. A test where both sides expect the same output cannot
  // pin the constant at all — any boundary from 5 hours to 7 days passes.
  it('pins the 24-hour classification boundary from both sides', async () => {
    const usage = (secondaryResetInSeconds: number): string =>
      JSON.stringify({
        ok: true,
        status: 200,
        statusText: 'OK',
        body: JSON.stringify({
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 30, reset_at: FAKE_NOW_MS / 1000 + SEVEN_DAYS_SECONDS },
            secondary_window: {
              used_percent: 80,
              reset_at: FAKE_NOW_MS / 1000 + secondaryResetInSeconds
            }
          }
        })
      })
    const DAY = 24 * 60 * 60

    // Just inside → secondary is 5-hourly, so the windows swap.
    const inside = await fetchCodexPlanUsage({
      runWorker: vi.fn().mockResolvedValue(usage(DAY - 60))
    })
    expect(inside.fiveHour?.utilization).toBe(80)
    expect(inside.sevenDay?.utilization).toBe(30)

    // Just outside → both are weekly, so the positional split applies instead.
    const outside = await fetchCodexPlanUsage({
      runWorker: vi.fn().mockResolvedValue(usage(DAY + 60))
    })
    expect(outside.fiveHour?.utilization).toBe(30)
    expect(outside.sevenDay?.utilization).toBe(80)
  })

  // parseApiWindow tolerates a missing reset_at, so an unclassifiable window
  // must fall back to its positional meaning rather than disappear.
  it('keeps a window whose reset time is missing or not a number', async () => {
    for (const resetAt of [undefined, 'soon']) {
      const result = await fetchCodexPlanUsage({
        runWorker: vi.fn().mockResolvedValue(
          JSON.stringify({
            ok: true,
            status: 200,
            statusText: 'OK',
            body: JSON.stringify({
              plan_type: 'plus',
              rate_limit: {
                primary_window: { used_percent: 42, reset_at: resetAt },
                secondary_window: {
                  used_percent: 24,
                  reset_at: FAKE_NOW_MS / 1000 + SEVEN_DAYS_SECONDS
                }
              }
            })
          })
        )
      })
      expect(result.fiveHour?.utilization).toBe(42)
      expect(result.sevenDay?.utilization).toBe(24)
    }

    // A LONE window with an unusable reset time must keep its positional slot.
    // Without the type check, `reset_at - now` is NaN, every comparison against
    // it is false, and the window silently classifies as weekly — so a 5-hour
    // bar would go blank and its number would appear under the weekly one.
    const lone = await fetchCodexPlanUsage({
      runWorker: vi.fn().mockResolvedValue(
        JSON.stringify({
          ok: true,
          status: 200,
          statusText: 'OK',
          body: JSON.stringify({
            plan_type: 'plus',
            rate_limit: { primary_window: { used_percent: 42, reset_at: 'soon' } }
          })
        })
      )
    })
    expect(lone.fiveHour?.utilization).toBe(42)
    expect(lone.sevenDay).toBeNull()
  })

  // An elapsed reset_at yields negative seconds. Treated as a duration it looks
  // "short", so a stale window would claim the 5-hour slot and push a genuinely
  // 5-hourly window into the weekly bar. An elapsed window carries no usable
  // duration and must not out-rank one that does.
  it('does not let an elapsed window displace a classified one', async () => {
    const result = await fetchCodexPlanUsage({
      runWorker: vi.fn().mockResolvedValue(
        JSON.stringify({
          ok: true,
          status: 200,
          statusText: 'OK',
          body: JSON.stringify({
            plan_type: 'plus',
            rate_limit: {
              primary_window: { used_percent: 42, reset_at: FAKE_NOW_MS / 1000 - 3600 },
              secondary_window: {
                used_percent: 80,
                reset_at: FAKE_NOW_MS / 1000 + FIVE_HOURS_SECONDS
              }
            }
          })
        })
      )
    })
    // The live 5-hour window wins the 5-hour slot; the stale one still renders.
    expect(result.fiveHour?.utilization).toBe(80)
    expect(result.sevenDay?.utilization).toBe(42)
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
