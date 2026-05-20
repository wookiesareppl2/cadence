export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  totalTokens: number
}

export type UsageWindow = {
  label: '5h' | '7d'
  startIso: string
  endIso: string
  usage: TokenUsage
  requestCount: number
}

export type ClaudeUsageRecord = {
  requestId: string
  sessionId: string
  messageId: string | null
  timestampIso: string
  timestampMs: number
  model: string | null
  sourcePath: string
  lineNumber: number
  usage: TokenUsage
  rawUsageJson: string
}

export type ClaudeUsageIngestStats = {
  scannedFileCount: number
  parsedLineCount: number
  usageRowCount: number
  uniqueRequestCount: number
  duplicateUsageRowCount: number
  skippedUsageRows: number
  invalidJsonLineCount: number
}

export type ClaudeUsageSummary = {
  sourceRoot: string
  databasePath: string
  dedupeKey: 'requestId'
  lastUpdatedIso: string
  ingest: ClaudeUsageIngestStats
  rolling: UsageWindow
  weekly: UsageWindow
}

export const emptyTokenUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  totalTokens: 0
})
