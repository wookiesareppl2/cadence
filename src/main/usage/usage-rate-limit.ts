export class UsageRateLimitError extends Error {
  retryAfterMs: number | null

  constructor(message: string, retryAfterMs: number | null = null) {
    super(message)
    this.name = 'UsageRateLimitError'
    this.retryAfterMs = retryAfterMs
  }
}

export function retryAfterHeaderMs(value: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!value) return null

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)

  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) return null
  return Math.max(0, dateMs - nowMs)
}
