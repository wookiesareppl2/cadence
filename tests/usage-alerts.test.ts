import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageWindow } from '../src/shared/claude-plan-usage'

const electronMock = vi.hoisted(() => {
  const show = vi.fn()
  const isSupported = vi.fn(() => true)
  const Notification = vi.fn(function () {
    return { show }
  })
  Object.assign(Notification, { isSupported })
  return { Notification, isSupported, show }
})

vi.mock('electron', () => ({ Notification: electronMock.Notification }))

import {
  USAGE_THRESHOLDS,
  newlyCrossedThresholds,
  notifyUsageThresholds,
  resetUsageAlertStateForTests
} from '../src/main/usage/usage-alerts'

function usageWindow(utilization: number, resetsAt: string): UsageWindow {
  return { utilization, resetsAt }
}

beforeEach(() => {
  resetUsageAlertStateForTests()
  electronMock.Notification.mockClear()
  electronMock.isSupported.mockReturnValue(true)
  electronMock.show.mockClear()
})

afterEach(() => {
  resetUsageAlertStateForTests()
})

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

describe('notifyUsageThresholds', () => {
  it('does not re-fire when the reset timestamp drifts while usage remains high', () => {
    notifyUsageThresholds('claude', usageWindow(84, '2026-06-08T10:00:00.000Z'), null)
    notifyUsageThresholds('claude', usageWindow(85, '2026-06-08T10:05:00.000Z'), null)
    notifyUsageThresholds('claude', usageWindow(86, '2026-06-08T10:10:00.000Z'), null)

    expect(electronMock.Notification).toHaveBeenCalledTimes(1)
    expect(electronMock.Notification).toHaveBeenLastCalledWith({
      title: 'Claude 5-hour usage at 84%',
      body: expect.stringContaining('Usage is getting high.')
    })
  })

  it('can still escalate once from the warning tier to the critical tier', () => {
    notifyUsageThresholds('claude', usageWindow(84, '2026-06-08T10:00:00.000Z'), null)
    notifyUsageThresholds('claude', usageWindow(97, '2026-06-08T10:05:00.000Z'), null)
    notifyUsageThresholds('claude', usageWindow(98, '2026-06-08T10:10:00.000Z'), null)

    expect(electronMock.Notification).toHaveBeenCalledTimes(2)
    expect(electronMock.Notification).toHaveBeenLastCalledWith({
      title: 'Claude 5-hour usage at 97%',
      body: expect.stringContaining('Nearly at your limit.')
    })
  })

  it('re-arms after usage falls below the first alert tier', () => {
    notifyUsageThresholds('claude', usageWindow(84, '2026-06-08T10:00:00.000Z'), null)
    notifyUsageThresholds('claude', usageWindow(79, '2026-06-08T10:05:00.000Z'), null)
    notifyUsageThresholds('claude', usageWindow(84, '2026-06-08T10:10:00.000Z'), null)

    expect(electronMock.Notification).toHaveBeenCalledTimes(2)
  })
})
