import { describe, expect, it } from 'vitest'
import { summarizeOpenCodeUsage, type OpenCodeCostRecord } from '../src/main/opencode/opencode-usage-service'

const NOW = Date.UTC(2026, 6, 13, 0, 0, 0)

function assistant(cost: number, ageMs: number): OpenCodeCostRecord {
  return { role: 'assistant', cost, time: { created: NOW - ageMs } }
}

describe('OpenCode Go local usage estimate', () => {
  it('uses the documented $12, $30, and $60 plan windows', () => {
    const usage = summarizeOpenCodeUsage([
      assistant(6, 60 * 60 * 1000),
      assistant(9, 6 * 60 * 60 * 1000),
      assistant(15, 8 * 24 * 60 * 60 * 1000),
      { role: 'user', time: { created: NOW - 1_000 } }
    ], NOW)

    expect(usage.fiveHourCost).toBe(6)
    expect(usage.fiveHour?.utilization).toBe(50)
    expect(usage.sevenDayCost).toBe(15)
    expect(usage.sevenDay?.utilization).toBe(50)
    expect(usage.monthlyCost).toBe(30)
    expect(usage.monthly?.utilization).toBe(50)
    expect(usage.isEstimate).toBe(true)
  })

  it('caps utilization at 100 percent and estimates the rolling reset', () => {
    const usage = summarizeOpenCodeUsage([assistant(20, 2 * 60 * 60 * 1000)], NOW)
    expect(usage.fiveHour?.utilization).toBe(100)
    expect(usage.fiveHour?.resetsAt).toBe(new Date(NOW + 3 * 60 * 60 * 1000).toISOString())
  })

  // Plan-included models bill nothing, so cost alone reads as "no usage" while the
  // plan is in fact exhausted. The provider's own report is what closes that gap.
  it('carries the provider-reported limit alongside the cost estimate', () => {
    const limit = {
      limitName: '5 hour',
      resetsAt: new Date(NOW + 3 * 60 * 60 * 1000).toISOString(),
      observedAt: new Date(NOW).toISOString(),
      detail: '5-hour usage limit reached. Resets in 3hr 0min.'
    }
    const usage = summarizeOpenCodeUsage([assistant(0, 60 * 1000)], NOW, limit)

    expect(usage.fiveHourCost).toBe(0)
    expect(usage.limit).toEqual(limit)
    expect(usage.refresh?.message).toBe('5 hour limit reached — reported by OpenCode')
  })

  it('reports no limit when the provider has not rejected anything', () => {
    const usage = summarizeOpenCodeUsage([assistant(0, 60 * 1000)], NOW)

    expect(usage.limit).toBeNull()
    expect(usage.refresh?.message).toBe('Estimated metered spend from local OpenCode sessions')
  })
})
