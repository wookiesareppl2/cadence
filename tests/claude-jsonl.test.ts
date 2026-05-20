import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeUsageLine, scanClaudeUsageRecords } from '../src/main/usage/claude-jsonl'

const usageRow = (requestId: string, timestamp = '2026-05-20T00:00:00.000Z'): string =>
  JSON.stringify({
    type: 'assistant',
    requestId,
    sessionId: 'session-1',
    timestamp,
    message: {
      id: 'msg-1',
      model: 'claude-opus-4-6',
      usage: {
        input_tokens: 3,
        output_tokens: 7,
        cache_creation_input_tokens: 11,
        cache_read_input_tokens: 13
      }
    }
  })

describe('Claude JSONL usage parsing', () => {
  it('normalizes a usage row without reading message content', () => {
    const parsed = parseClaudeUsageLine(usageRow('req-1'), '/tmp/session.jsonl', 12)

    expect(parsed.kind).toBe('record')
    if (parsed.kind !== 'record') return
    expect(parsed.record.requestId).toBe('req-1')
    expect(parsed.record.usage).toEqual({
      inputTokens: 3,
      outputTokens: 7,
      cacheCreationInputTokens: 11,
      cacheReadInputTokens: 13,
      totalTokens: 34
    })
  })

  it('dedupes repeated usage rows by requestId before returning records', async () => {
    const root = join(tmpdir(), `ai-dashboard-jsonl-${Date.now()}`)
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'session.jsonl'),
      [usageRow('req-1'), usageRow('req-1'), usageRow('req-2'), '{not json', JSON.stringify({ type: 'user' })].join('\n')
    )

    const result = await scanClaudeUsageRecords(root)

    expect(result.records).toHaveLength(2)
    expect(result.stats.usageRowCount).toBe(3)
    expect(result.stats.uniqueRequestCount).toBe(2)
    expect(result.stats.duplicateUsageRowCount).toBe(1)
    expect(result.stats.invalidJsonLineCount).toBe(1)
  })
})
