import { describe, expect, it, vi } from 'vitest'
import { fetchCodexPlanUsage } from '../src/main/usage/codex-plan-usage-service'

const fetchOk = JSON.stringify({
  ok: true,
  status: 200,
  statusText: 'OK',
  body: JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 42, reset_at: 1780392053 },
      secondary_window: { used_percent: 24, reset_at: 1780978853 }
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

describe('Codex plan usage service', () => {
  it('maps a live usage response into 5-hour and weekly windows', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetchOk)

    const result = await fetchCodexPlanUsage({ runWorker })

    expect(runWorker).toHaveBeenCalledTimes(1)
    expect(runWorker).toHaveBeenCalledWith('fetch')
    expect(result.fiveHour?.utilization).toBe(42)
    expect(result.sevenDay?.utilization).toBe(24)
    expect(result.fiveHour?.resetsAt).toBe(new Date(1780392053 * 1000).toISOString())
    expect(result.planType).toBe('plus')
    expect(result.isStale).toBe(false)
  })

  it('refreshes credentials and retries once after a 401', async () => {
    const runWorker = vi.fn(async (command: 'fetch' | 'refresh') => command)
      .mockResolvedValueOnce(fetch401) // first fetch
      .mockResolvedValueOnce(JSON.stringify({ ok: true })) // refresh
      .mockResolvedValueOnce(fetchOk) // retried fetch

    const result = await fetchCodexPlanUsage({ runWorker })

    expect(runWorker.mock.calls.map((call) => call[0])).toEqual(['fetch', 'refresh', 'fetch'])
    expect(result.fiveHour?.utilization).toBe(42)
    expect(result.sevenDay?.utilization).toBe(24)
  })

  it('does not refresh when the first fetch succeeds', async () => {
    const runWorker = vi.fn().mockResolvedValue(fetchOk)

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

  it('surfaces a worker-level error message verbatim', async () => {
    const runWorker = vi.fn().mockResolvedValue(
      JSON.stringify({ ok: false, status: 0, error: 'No Codex access token in ~/.codex/auth.json' })
    )

    await expect(fetchCodexPlanUsage({ runWorker })).rejects.toThrow(/No Codex access token/)
  })
})
