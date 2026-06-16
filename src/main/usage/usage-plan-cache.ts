import type { ClaudePlanUsage, PlanUsageRefreshMeta } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import { fetchClaudePlanUsage } from './claude-plan-usage-service'
import { fetchCodexPlanUsage } from './codex-plan-usage-service'
import { UsageRateLimitError } from './usage-rate-limit'

const LIVE_FETCH_INTERVAL_MS = 2 * 60_000
const RATE_LIMIT_FALLBACK_MS = 15 * 60_000
const ERROR_RETRY_INTERVAL_MS = 2 * 60_000

type PlanUsageWithRefresh = { fetchedAt: string; refresh?: PlanUsageRefreshMeta }
type PlanUsageFetcher<T extends PlanUsageWithRefresh> = () => Promise<T>

type CacheState<T extends PlanUsageWithRefresh> = {
  value: T | null
  inFlight: Promise<T> | null
  nextFetchAtMs: number
  rateLimitedUntilMs: number | null
  lastError: string | null
}

function isoOrNull(ms: number | null): string | null {
  return ms ? new Date(ms).toISOString() : null
}

function attachRefresh<T extends PlanUsageWithRefresh>(usage: T, refresh: PlanUsageRefreshMeta): T {
  return { ...usage, refresh }
}

export function createCachedPlanUsage<T extends PlanUsageWithRefresh>(
  label: string,
  fetcher: PlanUsageFetcher<T>
): () => Promise<T> {
  const state: CacheState<T> = {
    value: null,
    inFlight: null,
    nextFetchAtMs: 0,
    rateLimitedUntilMs: null,
    lastError: null
  }

  async function refresh(nowMs: number): Promise<T> {
    state.inFlight ??= fetcher()
      .then((usage) => {
        state.value = usage
        state.lastError = null
        state.rateLimitedUntilMs = null
        state.nextFetchAtMs = Date.now() + LIVE_FETCH_INTERVAL_MS
        return attachRefresh(usage, {
          state: 'fresh',
          nextRefreshAt: isoOrNull(state.nextFetchAtMs),
          message: null
        })
      })
      .catch((error: unknown) => {
        if (error instanceof UsageRateLimitError) {
          const retryAfterMs = Math.max(error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS, LIVE_FETCH_INTERVAL_MS)
          state.rateLimitedUntilMs = Date.now() + retryAfterMs
          state.nextFetchAtMs = state.rateLimitedUntilMs
          state.lastError = error.message

          if (state.value) {
            return attachRefresh(state.value, {
              state: 'rate_limited',
              nextRefreshAt: isoOrNull(state.nextFetchAtMs),
              message: `${label} usage API rate limited; showing last known values`
            })
          }
        } else {
          state.nextFetchAtMs = Date.now() + ERROR_RETRY_INTERVAL_MS
          state.lastError = error instanceof Error ? error.message : `${label} usage refresh failed`

          if (state.value) {
            return attachRefresh(state.value, {
              state: 'cached',
              nextRefreshAt: isoOrNull(state.nextFetchAtMs),
              message: `${label} usage refresh failed; showing last known values`
            })
          }
        }

        throw error
      })
      .finally(() => {
        state.inFlight = null
      })

    return state.inFlight
  }

  return async () => {
    const nowMs = Date.now()
    if (state.inFlight) return state.inFlight

    if (state.value && nowMs < state.nextFetchAtMs) {
      const isRateLimited = state.rateLimitedUntilMs !== null && nowMs < state.rateLimitedUntilMs
      return attachRefresh(state.value, {
        state: isRateLimited ? 'rate_limited' : 'cached',
        nextRefreshAt: isoOrNull(state.nextFetchAtMs),
        message: isRateLimited ? `${label} usage API rate limited; showing last known values` : state.lastError
      })
    }

    if (!state.value && state.lastError && nowMs < state.nextFetchAtMs) {
      throw new Error(state.lastError)
    }

    return refresh(nowMs)
  }
}

export const getCachedClaudePlanUsage = createCachedPlanUsage<ClaudePlanUsage>('Claude', fetchClaudePlanUsage)
export const getCachedCodexPlanUsage = createCachedPlanUsage<CodexPlanUsage>('Codex', fetchCodexPlanUsage)
