import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudePlanUsage } from '../src/shared/claude-plan-usage'
import { createCachedPlanUsage } from '../src/main/usage/usage-plan-cache'
import { UsageRateLimitError } from '../src/main/usage/usage-rate-limit'

function usage(fetchedAt: string, utilization: number = 10): ClaudePlanUsage {
  return {
    fiveHour: { utilization, resetsAt: '2026-06-03T05:00:00.000Z' },
    sevenDay: { utilization: utilization / 2, resetsAt: '2026-06-10T00:00:00.000Z' },
    extraUsage: null,
    fetchedAt
  }
}

describe('createCachedPlanUsage', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses cached usage inside the safe live-fetch interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'))

    const fetcher = vi
      .fn<() => Promise<ClaudePlanUsage>>()
      .mockResolvedValueOnce(usage('2026-06-03T00:00:00.000Z', 20))
      .mockResolvedValueOnce(usage('2026-06-03T00:00:30.000Z', 30))
    const getUsage = createCachedPlanUsage('Test', fetcher)

    const first = await getUsage()
    const cached = await getUsage()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first.refresh?.state).toBe('fresh')
    expect(cached.refresh?.state).toBe('cached')
    expect(cached.fiveHour?.utilization).toBe(20)

    vi.advanceTimersByTime(29_000)
    const stillCached = await getUsage()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(stillCached.refresh?.state).toBe('cached')
    expect(stillCached.fiveHour?.utilization).toBe(20)

    vi.advanceTimersByTime(1_000)
    const refreshed = await getUsage()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(refreshed.refresh?.state).toBe('fresh')
    expect(refreshed.fiveHour?.utilization).toBe(30)
  })

  it('returns last known usage during a 429 cooldown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'))

    const fetcher = vi
      .fn<() => Promise<ClaudePlanUsage>>()
      .mockResolvedValueOnce(usage('2026-06-03T00:00:00.000Z', 40))
      .mockRejectedValueOnce(new UsageRateLimitError('rate limited', 10 * 60_000))
      .mockResolvedValueOnce(usage('2026-06-03T00:15:00.000Z', 45))
    const getUsage = createCachedPlanUsage('Test', fetcher)

    await getUsage()
    vi.advanceTimersByTime(5 * 60_000)

    const limited = await getUsage()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(limited.refresh?.state).toBe('rate_limited')
    expect(limited.fiveHour?.utilization).toBe(40)

    vi.advanceTimersByTime(9 * 60_000)
    const stillCached = await getUsage()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(stillCached.refresh?.state).toBe('rate_limited')

    vi.advanceTimersByTime(60_000)
    const refreshed = await getUsage()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(refreshed.fiveHour?.utilization).toBe(45)
  })

  it('throttles repeated failures even before a first usage value is cached', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T00:00:00.000Z'))

    const fetcher = vi
      .fn<() => Promise<ClaudePlanUsage>>()
      .mockRejectedValueOnce(new Error('credentials expired'))
      .mockResolvedValueOnce(usage('2026-06-03T00:02:00.000Z', 25))
    const getUsage = createCachedPlanUsage('Test', fetcher)

    await expect(getUsage()).rejects.toThrow('credentials expired')
    await expect(getUsage()).rejects.toThrow('credentials expired')
    expect(fetcher).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(59_000)
    await expect(getUsage()).rejects.toThrow('credentials expired')
    expect(fetcher).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(1_000)
    const refreshed = await getUsage()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(refreshed.refresh?.state).toBe('fresh')
    expect(refreshed.fiveHour?.utilization).toBe(25)
  })
})
