export type UsageWindow = {
  label: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  percentUsed: number
  estimate: boolean
}

export type UsageSummary = {
  rolling: UsageWindow
  weekly: UsageWindow
  requestCount: number
  dedupeKey: 'requestId'
}
