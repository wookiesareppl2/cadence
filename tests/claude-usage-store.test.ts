import { describe, expect, it } from 'vitest'
import { ClaudeUsageStore } from '../src/main/usage/claude-usage-store'
import type { ClaudeUsageRecord } from '../src/shared/usage'

const record = (requestId: string, timestampMs: number, tokenBase = 10): ClaudeUsageRecord => ({
  requestId,
  sessionId: 'session-1',
  messageId: `msg-${requestId}`,
  timestampIso: new Date(timestampMs).toISOString(),
  timestampMs,
  model: 'claude-opus-4-6',
  sourcePath: '/tmp/session.jsonl',
  lineNumber: 1,
  usage: {
    inputTokens: tokenBase,
    outputTokens: tokenBase,
    cacheCreationInputTokens: tokenBase,
    cacheReadInputTokens: tokenBase,
    totalTokens: tokenBase * 4
  },
  rawUsageJson: '{}'
})

describe('Claude usage SQLite store', () => {
  it('aggregates 5-hour and weekly windows from deduped records', () => {
    const now = Date.parse('2026-05-20T12:00:00.000Z')
    const store = new ClaudeUsageStore({ databasePath: ':memory:' })

    try {
      store.replaceAll([
        record('recent', now - 60 * 60 * 1000, 10),
        record('week', now - 2 * 24 * 60 * 60 * 1000, 20),
        record('old', now - 10 * 24 * 60 * 60 * 1000, 30)
      ])

      const summary = store.getSummary(
        '/tmp/root',
        {
          scannedFileCount: 1,
          parsedLineCount: 3,
          usageRowCount: 3,
          uniqueRequestCount: 3,
          duplicateUsageRowCount: 0,
          skippedUsageRows: 0,
          invalidJsonLineCount: 0
        },
        now
      )

      expect(summary.rolling.requestCount).toBe(1)
      expect(summary.rolling.usage.totalTokens).toBe(40)
      expect(summary.weekly.requestCount).toBe(2)
      expect(summary.weekly.usage.totalTokens).toBe(120)
    } finally {
      store.close()
    }
  })
})
