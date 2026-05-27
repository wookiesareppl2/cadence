export type UsageWindow = {
  utilization: number
  resetsAt: string | null
}

export type ExtraUsage = {
  isEnabled: boolean
  monthlyLimit: number
  usedCredits: number
  utilization: number
  currency: string
  disabledReason: string | null
}

export type ClaudePlanUsage = {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  extraUsage: ExtraUsage | null
  fetchedAt: string
}
