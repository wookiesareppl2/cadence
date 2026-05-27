import { describe, expect, it, vi } from 'vitest'
import { fetchClaudePlanUsage } from '../src/main/usage/claude-plan-usage-service'

const usageResponse = (status: number, body: unknown = {}): Pick<Response, 'status' | 'ok' | 'statusText' | 'json'> => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: status === 200 ? 'OK' : 'Unauthorized',
  json: () => Promise.resolve(body)
})

const usageBody = {
  five_hour: { utilization: 42, resets_at: '2026-05-27T12:00:00.000Z' },
  seven_day: { utilization: 24, resets_at: '2026-05-28T12:00:00.000Z' },
  extra_usage: null
}

describe('Claude plan usage service', () => {
  it('refreshes credentials and retries once after an expired access token', async () => {
    const readToken = vi.fn()
      .mockReturnValueOnce('expired-token')
      .mockReturnValueOnce('fresh-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn()
      .mockResolvedValueOnce(usageResponse(401))
      .mockResolvedValueOnce(usageResponse(200, usageBody))

    const result = await fetchClaudePlanUsage({ fetchUsage, readToken, refreshCredentials })

    expect(refreshCredentials).toHaveBeenCalledTimes(1)
    expect(readToken).toHaveBeenCalledTimes(2)
    expect(fetchUsage).toHaveBeenNthCalledWith(1, 'expired-token')
    expect(fetchUsage).toHaveBeenNthCalledWith(2, 'fresh-token')
    expect(result.fiveHour?.utilization).toBe(42)
    expect(result.sevenDay?.utilization).toBe(24)
  })

  it('does not refresh credentials when the first usage request succeeds', async () => {
    const readToken = vi.fn().mockReturnValue('valid-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn().mockResolvedValue(usageResponse(200, usageBody))

    await fetchClaudePlanUsage({ fetchUsage, readToken, refreshCredentials })

    expect(refreshCredentials).not.toHaveBeenCalled()
    expect(readToken).toHaveBeenCalledTimes(1)
    expect(fetchUsage).toHaveBeenCalledWith('valid-token')
  })
})
