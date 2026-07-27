import type { OpenCodePlanLimit } from '@shared/opencode'

// OpenCode's Go plan enforces its quota server-side and exposes it nowhere: there
// is no usage, quota, or balance endpoint, and ordinary responses carry no
// rate-limit headers. The only authoritative signal is the rejection itself — a
// 429 whose `retry-after` gives the exact seconds to reset and whose body names
// the limit:
//
//   retry-after: 13650
//   {"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached.
//     Resets in 3hr 48min. …"},"metadata":{"limitName":"5 hour"}}
//
// So Cadence cannot show a percentage of the real quota — nothing can. It can
// show the limit state exactly, from the moment the provider reports it.

export type PlanLimitErrorInput = {
  name?: string
  data?: {
    statusCode?: number
    responseHeaders?: Record<string, string>
    responseBody?: string
  }
}

function header(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name)
  return match ? headers[match] : undefined
}

// `retry-after` is the authoritative countdown. Seconds only — the provider does
// not use the HTTP-date form here, and a date would parse as NaN and be ignored.
function retryAfterMs(headers: Record<string, string> | undefined): number | null {
  const raw = header(headers, 'retry-after')
  if (!raw) return null
  const seconds = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null
}

// Fallback when the header is absent: the human message carries the same figure
// ("Resets in 3hr 48min", "Resets in 45min", "Resets in 2hr").
function messageResetMs(message: string | undefined): number | null {
  if (!message) return null
  const match = /resets? in\s+(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/i.exec(message)
  if (!match || (!match[1] && !match[2])) return null
  const hours = Number.parseInt(match[1] ?? '0', 10)
  const minutes = Number.parseInt(match[2] ?? '0', 10)
  const total = hours * 3_600_000 + minutes * 60_000
  return total > 0 ? total : null
}

function parseBody(responseBody: string | undefined): {
  limitName?: string
  message?: string
  errorType?: string
} {
  if (!responseBody) return {}
  try {
    const body = JSON.parse(responseBody) as {
      error?: { type?: string; message?: string }
      metadata?: { limitName?: string }
    }
    return {
      limitName: body.metadata?.limitName,
      message: body.error?.message,
      errorType: body.error?.type
    }
  } catch {
    // A non-JSON body still leaves the status code and headers usable.
    return {}
  }
}

/**
 * Reads a provider rejection into a plan-limit state. Returns null for anything
 * that is not a quota rejection, so ordinary API failures never masquerade as one.
 */
export function parsePlanLimit(
  error: PlanLimitErrorInput | null | undefined,
  now = Date.now()
): OpenCodePlanLimit | null {
  if (!error || error.data?.statusCode !== 429) return null
  const { limitName, message, errorType } = parseBody(error.data?.responseBody)
  const resetMs = retryAfterMs(error.data?.responseHeaders) ?? messageResetMs(message)
  return {
    // "5 hour" reads naturally in the UI; fall back to the error type, then a
    // generic label, so an unnamed quota still surfaces rather than vanishing.
    limitName: limitName ?? errorType ?? 'usage',
    resetsAt: resetMs === null ? null : new Date(now + resetMs).toISOString(),
    observedAt: new Date(now).toISOString(),
    detail: message ?? null
  }
}

let current: OpenCodePlanLimit | null = null

export function recordPlanLimit(limit: OpenCodePlanLimit | null): void {
  if (limit) current = limit
}

/**
 * The active limit, or null once it has reset. A limit with no known reset time
 * is held briefly rather than forever — without a countdown there is no way to
 * learn it has lifted except by trying again.
 */
export function getPlanLimit(now = Date.now()): OpenCodePlanLimit | null {
  if (!current) return null
  const expiry = current.resetsAt
    ? Date.parse(current.resetsAt)
    : Date.parse(current.observedAt) + UNKNOWN_RESET_GRACE_MS
  if (Number.isFinite(expiry) && expiry <= now) {
    current = null
    return null
  }
  return current
}

const UNKNOWN_RESET_GRACE_MS = 15 * 60 * 1000

export function clearPlanLimit(): void {
  current = null
}
