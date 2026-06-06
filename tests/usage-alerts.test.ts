import { describe, expect, it } from 'vitest'
import { USAGE_THRESHOLDS, newlyCrossedThresholds } from '../src/main/usage/usage-alerts'

describe('newlyCrossedThresholds', () => {
  it('returns nothing below the first threshold', () => {
    expect(newlyCrossedThresholds(50, new Set())).toEqual([])
  })

  it('returns the crossed threshold once it is reached', () => {
    expect(newlyCrossedThresholds(82, new Set())).toEqual([80])
  })

  it('returns both tiers when a single jump crosses them together', () => {
    expect(newlyCrossedThresholds(97, new Set())).toEqual([80, 95])
  })

  it('skips thresholds that already fired this window', () => {
    expect(newlyCrossedThresholds(97, new Set([80]))).toEqual([95])
    expect(newlyCrossedThresholds(82, new Set([80]))).toEqual([])
  })

  it('exposes the configured thresholds', () => {
    expect(USAGE_THRESHOLDS).toEqual([80, 95])
  })
})
