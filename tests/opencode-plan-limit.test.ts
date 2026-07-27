import { afterEach, describe, expect, it } from 'vitest'
import {
  clearPlanLimit,
  getPlanLimit,
  parsePlanLimit,
  recordPlanLimit
} from '../src/main/opencode/opencode-plan-limit'

// Captured verbatim from the Go gateway while the account was rate limited. This
// rejection is the only place the real quota is ever reported — there is no usage
// endpoint and no rate-limit headers on successful responses.
const REAL_REJECTION = {
  name: 'APIError',
  data: {
    statusCode: 429,
    isRetryable: false,
    responseHeaders: { 'retry-after': '13650', 'content-type': 'application/json' },
    responseBody: JSON.stringify({
      type: 'error',
      error: {
        type: 'GoUsageLimitError',
        message:
          '5-hour usage limit reached. Resets in 3hr 48min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_test/go'
      },
      metadata: { workspace: 'wrk_test', limitName: '5 hour' }
    })
  }
}

const NOW = Date.parse('2026-07-27T17:00:00.000Z')

afterEach(() => clearPlanLimit())

describe('parsing the provider rate-limit rejection', () => {
  it('reads the limit name and an exact reset from retry-after', () => {
    const limit = parsePlanLimit(REAL_REJECTION, NOW)

    expect(limit?.limitName).toBe('5 hour')
    // 13650s after NOW — the header wins because it is exact to the second.
    expect(limit?.resetsAt).toBe('2026-07-27T20:47:30.000Z')
    expect(limit?.observedAt).toBe('2026-07-27T17:00:00.000Z')
  })

  it('falls back to the countdown in the message when the header is missing', () => {
    const limit = parsePlanLimit(
      { ...REAL_REJECTION, data: { ...REAL_REJECTION.data, responseHeaders: {} } },
      NOW
    )

    // "Resets in 3hr 48min" — coarser than the header, hence the fallback order.
    expect(limit?.resetsAt).toBe('2026-07-27T20:48:00.000Z')
  })

  it('matches retry-after case-insensitively', () => {
    const limit = parsePlanLimit(
      { ...REAL_REJECTION, data: { ...REAL_REJECTION.data, responseHeaders: { 'Retry-After': '60' } } },
      NOW
    )

    expect(limit?.resetsAt).toBe('2026-07-27T17:01:00.000Z')
  })

  it('still reports a limit when the body is unparseable', () => {
    const limit = parsePlanLimit(
      { ...REAL_REJECTION, data: { ...REAL_REJECTION.data, responseBody: '<html>gateway</html>' } },
      NOW
    )

    expect(limit).not.toBeNull()
    expect(limit?.limitName).toBe('usage')
    expect(limit?.resetsAt).toBe('2026-07-27T20:47:30.000Z')
  })

  it('ignores failures that are not quota rejections', () => {
    expect(parsePlanLimit(null, NOW)).toBeNull()
    expect(parsePlanLimit({ name: 'APIError', data: { statusCode: 500 } }, NOW)).toBeNull()
    expect(parsePlanLimit({ name: 'UnknownError' }, NOW)).toBeNull()
  })
})

describe('holding the limit state', () => {
  it('reports the limit until its reset passes, then clears', () => {
    recordPlanLimit(parsePlanLimit(REAL_REJECTION, NOW))

    expect(getPlanLimit(NOW + 60_000)?.limitName).toBe('5 hour')
    expect(getPlanLimit(Date.parse('2026-07-27T20:47:29.000Z'))).not.toBeNull()
    expect(getPlanLimit(Date.parse('2026-07-27T20:47:30.000Z'))).toBeNull()
  })

  it('expires a limit with no known reset instead of holding it forever', () => {
    recordPlanLimit({
      limitName: '5 hour',
      resetsAt: null,
      observedAt: new Date(NOW).toISOString(),
      detail: null
    })

    expect(getPlanLimit(NOW + 60_000)).not.toBeNull()
    expect(getPlanLimit(NOW + 16 * 60_000)).toBeNull()
  })

  it('reports nothing when no limit has been seen', () => {
    expect(getPlanLimit(NOW)).toBeNull()
  })
})
