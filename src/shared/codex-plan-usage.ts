import type { UsageWindow } from './claude-plan-usage'

export type CodexPlanUsage = {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  planType: string | null
  sourcePath: string | null
  sourceTimestamp: string | null
  fetchedAt: string
}
