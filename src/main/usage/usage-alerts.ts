import { Notification } from 'electron'
import type { UsageWindow } from '@shared/claude-plan-usage'
import type { PlatformId } from '@shared/platform'

// Usage tracking is the app's primary purpose; these alerts make the data
// actionable by warning before a limit is actually hit. A single notification
// fires per tier per window period (re-armed when the window resets), so the
// user gets a heads-up (80%) and a final warning (95%) without spam.
export const USAGE_THRESHOLDS = [80, 95] as const

// Pure: the thresholds newly crossed at this utilization that haven't fired yet.
// Extracted so the dedup decision is unit-testable without Electron.
export function newlyCrossedThresholds(pct: number, alreadyFired: ReadonlySet<number>): number[] {
  return USAGE_THRESHOLDS.filter((threshold) => pct >= threshold && !alreadyFired.has(threshold))
}

type WindowKey = '5h' | '7d'
type WindowState = { fired: Set<number> }

// At most 4 entries (2 platforms x 2 windows). Reset timestamps can drift on
// rolling usage windows, so notification state is re-armed by utilization
// dropping below the first alert tier rather than by exact resetsAt changes.
const windowStates = new Map<string, WindowState>()

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return ''
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return ''
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
  return ` Resets at ${time}.`
}

function showNotification(
  platform: PlatformId,
  windowLabel: string,
  pct: number,
  threshold: number,
  resetsAt: string | null
): void {
  if (!Notification.isSupported()) return
  const name = platform === 'claude' ? 'Claude' : 'Codex'
  const lead = threshold >= 95 ? 'Nearly at your limit.' : 'Usage is getting high.'
  new Notification({
    title: `${name} ${windowLabel} usage at ${pct}%`,
    body: `${lead}${formatReset(resetsAt)}`
  }).show()
}

function processWindow(platform: PlatformId, key: WindowKey, label: string, window: UsageWindow | null): void {
  if (!window) return

  const mapKey = `${platform}:${key}`
  let state = windowStates.get(mapKey)
  if (!state) {
    state = { fired: new Set() }
    windowStates.set(mapKey, state)
  }

  const pct = Math.round(window.utilization)
  if (pct < USAGE_THRESHOLDS[0]) {
    state.fired.clear()
  }

  const newly = newlyCrossedThresholds(pct, state.fired)
  if (newly.length === 0) return

  for (const threshold of newly) state.fired.add(threshold)
  // Fire once, at the highest newly-crossed tier, so a single big jump doesn't
  // stack two notifications.
  showNotification(platform, label, pct, Math.max(...newly), window.resetsAt)
}

// Fire-and-forget; never throw into the usage IPC handler.
export function notifyUsageThresholds(
  platform: PlatformId,
  fiveHour: UsageWindow | null,
  sevenDay: UsageWindow | null
): void {
  try {
    processWindow(platform, '5h', '5-hour', fiveHour)
    processWindow(platform, '7d', 'weekly', sevenDay)
  } catch (error) {
    console.error('Usage alert failed', error)
  }
}

export function resetUsageAlertStateForTests(): void {
  windowStates.clear()
}
