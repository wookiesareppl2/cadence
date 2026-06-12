import { describe, expect, it, vi } from 'vitest'
import { __testing, fetchClaudePlanUsage } from '../src/main/usage/claude-plan-usage-service'
import { UsageRateLimitError } from '../src/main/usage/usage-rate-limit'

const usageResponse = (
  status: number,
  body: unknown = {},
  retryAfter: string | null = null
): Pick<Response, 'status' | 'ok' | 'statusText' | 'json'> & { headers: Pick<Headers, 'get'> } => ({
  status,
  ok: status >= 200 && status < 300,
  statusText: status === 200 ? 'OK' : status === 429 ? 'Too Many Requests' : 'Unauthorized',
  headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  json: () => Promise.resolve(body)
})

const usageBody = {
  five_hour: { utilization: 42, resets_at: '2026-05-27T12:00:00.000Z' },
  seven_day: { utilization: 24, resets_at: '2026-05-28T12:00:00.000Z' },
  extra_usage: null
}

describe('Claude plan usage service', () => {
  it('builds a direct refresh command that preserves prompt and empty tools arguments', () => {
    const command = __testing.claudeRefreshCommand()
    const toolsIndex = command.args.indexOf('--tools')
    const modelIndex = command.args.indexOf('--model')
    const budgetIndex = command.args.indexOf('--max-budget-usd')

    expect(command.file).toBe('claude')
    expect(command.args).toContain('Respond with exactly: pong')
    expect(toolsIndex).toBeGreaterThan(-1)
    expect(command.args[toolsIndex + 1]).toBe('')
    // Pin a cheap model and keep the budget above one Haiku turn so the refresh
    // ping exits 0 (rotating the token) instead of tripping error_max_budget_usd.
    expect(command.args[modelIndex + 1]).toBe('claude-haiku-4-5')
    expect(Number(command.args[budgetIndex + 1])).toBeGreaterThanOrEqual(0.05)
  })

  it('refreshes credentials and retries once after an expired access token', async () => {
    const readToken = vi.fn()
      .mockReturnValueOnce('expired-token')
      .mockReturnValueOnce('fresh-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn()
      .mockResolvedValueOnce(usageResponse(401))
      .mockResolvedValueOnce(usageResponse(200, usageBody))

    const result = await fetchClaudePlanUsage({
      fetchUsage,
      readToken,
      refreshCredentials,
      readTokenExpiry: () => null
    })

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

    await fetchClaudePlanUsage({ fetchUsage, readToken, refreshCredentials, readTokenExpiry: () => null })

    expect(refreshCredentials).not.toHaveBeenCalled()
    expect(readToken).toHaveBeenCalledTimes(1)
    expect(fetchUsage).toHaveBeenCalledWith('valid-token')
  })

  it('refreshes proactively before the first request when the stored token is expired', async () => {
    const readToken = vi.fn().mockReturnValue('fresh-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn().mockResolvedValue(usageResponse(200, usageBody))
    const now = 1_000_000

    const result = await fetchClaudePlanUsage({
      fetchUsage,
      readToken,
      refreshCredentials,
      readTokenExpiry: () => now - 1, // already past expiry
      now: () => now
    })

    expect(refreshCredentials).toHaveBeenCalledTimes(1)
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(fetchUsage).toHaveBeenCalledWith('fresh-token')
    expect(result.fiveHour?.utilization).toBe(42)
  })

  it('refreshes proactively within the skew window before expiry', async () => {
    const readToken = vi.fn().mockReturnValue('fresh-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn().mockResolvedValue(usageResponse(200, usageBody))
    const now = 1_000_000

    await fetchClaudePlanUsage({
      fetchUsage,
      readToken,
      refreshCredentials,
      readTokenExpiry: () => now + 30_000, // expires in 30s, inside the 60s skew
      now: () => now
    })

    expect(refreshCredentials).toHaveBeenCalledTimes(1)
  })

  it('does not refresh again when a proactive refresh still returns 401', async () => {
    const readToken = vi.fn().mockReturnValue('still-bad-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn().mockResolvedValue(usageResponse(401))
    const now = 1_000_000

    await expect(
      fetchClaudePlanUsage({
        fetchUsage,
        readToken,
        refreshCredentials,
        readTokenExpiry: () => now - 1,
        now: () => now
      })
    ).rejects.toThrow('did not produce a valid access token')

    expect(refreshCredentials).toHaveBeenCalledTimes(1)
    expect(fetchUsage).toHaveBeenCalledTimes(1)
  })

  it('does not refresh proactively when the token has ample time left', async () => {
    const readToken = vi.fn().mockReturnValue('valid-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn().mockResolvedValue(usageResponse(200, usageBody))
    const now = 1_000_000

    await fetchClaudePlanUsage({
      fetchUsage,
      readToken,
      refreshCredentials,
      readTokenExpiry: () => now + 10 * 60_000, // 10 minutes out
      now: () => now
    })

    expect(refreshCredentials).not.toHaveBeenCalled()
    expect(fetchUsage).toHaveBeenCalledTimes(1)
  })

  it('surfaces 429 responses with retry-after timing', async () => {
    const readToken = vi.fn().mockReturnValue('valid-token')
    const refreshCredentials = vi.fn().mockResolvedValue(undefined)
    const fetchUsage = vi.fn().mockResolvedValue(usageResponse(429, {}, '120'))

    await expect(
      fetchClaudePlanUsage({ fetchUsage, readToken, refreshCredentials, readTokenExpiry: () => null })
    ).rejects.toMatchObject({
      name: 'UsageRateLimitError',
      retryAfterMs: 120_000
    } satisfies Partial<UsageRateLimitError>)

    expect(refreshCredentials).not.toHaveBeenCalled()
  })
})
