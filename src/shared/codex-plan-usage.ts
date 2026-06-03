import type { PlanUsageRefreshMeta, UsageWindow } from './claude-plan-usage'

export type CodexPlanUsage = {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  planType: string | null
  sourcePath: string | null
  sourceTimestamp: string | null
  isStale: boolean
  staleReason: string | null
  fetchedAt: string
  refresh?: PlanUsageRefreshMeta
}
