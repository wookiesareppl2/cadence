import { useCallback, useEffect, useState } from 'react'

// The "wrap up & save" line for the per-session context gauge, as a fraction of the
// model's context window. Persisted globally (localStorage) and kept in sync across
// every gauge/control via the `storage` event, so adjusting it in one place updates
// all of them. Default 60% matches the Claude Code team's proactive-compaction
// guidance; adjustable down to 10% (useful on 1M-window models, where rot can be
// felt well before the window fills) and up to 90% (just under auto-compact).
const STORAGE_KEY = 'cadence:context-wrap-threshold'
export const CONTEXT_WRAP_DEFAULT = 0.6
export const CONTEXT_WRAP_MIN = 0.1
export const CONTEXT_WRAP_MAX = 0.9
// Hard ceiling: past this the tools auto-compact, so the gauge always reads
// "critical" here regardless of the user's wrap-up line.
export const CONTEXT_CRITICAL = 0.8

function clamp(value: number): number {
  if (!Number.isFinite(value)) return CONTEXT_WRAP_DEFAULT
  return Math.min(CONTEXT_WRAP_MAX, Math.max(CONTEXT_WRAP_MIN, value))
}

function read(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw) return clamp(JSON.parse(raw) as number)
  } catch {
    // Corrupt/unavailable storage falls back to the default.
  }
  return CONTEXT_WRAP_DEFAULT
}

export function useContextWrapThreshold(): [number, (value: number) => void] {
  const [value, setValue] = useState<number>(read)

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== STORAGE_KEY) return
      try {
        if (event.newValue) setValue(clamp(JSON.parse(event.newValue) as number))
      } catch {
        // Ignore malformed cross-tab updates.
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const update = useCallback((next: number): void => {
    const clamped = clamp(next)
    setValue(clamped)
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clamped))
      // The `storage` event only fires in *other* tabs/windows, so notify any
      // sibling gauges in this same window manually.
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: JSON.stringify(clamped) }))
    } catch {
      // Best-effort persistence; the in-memory value still updates.
    }
  }, [])

  return [value, update]
}
