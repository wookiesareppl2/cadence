import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ClaudeUsageIngestStats, ClaudeUsageRecord, ClaudeUsageSummary, TokenUsage, UsageWindow } from '@shared/usage'
import { emptyTokenUsage } from '@shared/usage'

type UsageStoreOptions = {
  databasePath: string
}

type TotalsRow = {
  request_count: number
  input_tokens: number | null
  output_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  total_tokens: number | null
}

export class ClaudeUsageStore {
  private readonly database: Database.Database
  readonly databasePath: string

  constructor({ databasePath }: UsageStoreOptions) {
    this.databasePath = databasePath
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new Database(databasePath)
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.migrate()
  }

  close(): void {
    this.database.close()
  }

  replaceAll(records: ClaudeUsageRecord[]): void {
    const insert = this.database.prepare(`
      INSERT INTO claude_usage_records (
        request_id,
        session_id,
        message_id,
        timestamp_iso,
        timestamp_ms,
        model,
        source_path,
        line_number,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        total_tokens,
        raw_usage_json
      ) VALUES (
        @requestId,
        @sessionId,
        @messageId,
        @timestampIso,
        @timestampMs,
        @model,
        @sourcePath,
        @lineNumber,
        @inputTokens,
        @outputTokens,
        @cacheCreationInputTokens,
        @cacheReadInputTokens,
        @totalTokens,
        @rawUsageJson
      )
      ON CONFLICT(request_id) DO UPDATE SET
        session_id = excluded.session_id,
        message_id = excluded.message_id,
        timestamp_iso = excluded.timestamp_iso,
        timestamp_ms = excluded.timestamp_ms,
        model = excluded.model,
        source_path = excluded.source_path,
        line_number = excluded.line_number,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens,
        cache_read_input_tokens = excluded.cache_read_input_tokens,
        total_tokens = excluded.total_tokens,
        raw_usage_json = excluded.raw_usage_json
    `)

    const transaction = this.database.transaction((rows: ClaudeUsageRecord[]) => {
      this.database.prepare('DELETE FROM claude_usage_records').run()
      for (const record of rows) {
        insert.run({
          requestId: record.requestId,
          sessionId: record.sessionId,
          messageId: record.messageId,
          timestampIso: record.timestampIso,
          timestampMs: record.timestampMs,
          model: record.model,
          sourcePath: record.sourcePath,
          lineNumber: record.lineNumber,
          inputTokens: record.usage.inputTokens,
          outputTokens: record.usage.outputTokens,
          cacheCreationInputTokens: record.usage.cacheCreationInputTokens,
          cacheReadInputTokens: record.usage.cacheReadInputTokens,
          totalTokens: record.usage.totalTokens,
          rawUsageJson: record.rawUsageJson
        })
      }
    })

    transaction(records)
  }

  getSummary(sourceRoot: string, ingest: ClaudeUsageIngestStats, nowMs = Date.now()): ClaudeUsageSummary {
    const rollingStartMs = nowMs - 5 * 60 * 60 * 1000
    const weeklyStartMs = nowMs - 7 * 24 * 60 * 60 * 1000

    return {
      sourceRoot,
      databasePath: this.databasePath,
      dedupeKey: 'requestId',
      lastUpdatedIso: new Date(nowMs).toISOString(),
      ingest,
      rolling: this.getWindow('5h', rollingStartMs, nowMs),
      weekly: this.getWindow('7d', weeklyStartMs, nowMs)
    }
  }

  private getWindow(label: UsageWindow['label'], startMs: number, endMs: number): UsageWindow {
    const row = this.database
      .prepare(
        `
        SELECT
          COUNT(*) AS request_count,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(cache_read_input_tokens) AS cache_read_input_tokens,
          SUM(total_tokens) AS total_tokens
        FROM claude_usage_records
        WHERE timestamp_ms >= @startMs AND timestamp_ms <= @endMs
      `
      )
      .get({ startMs, endMs }) as TotalsRow

    return {
      label,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      usage: totalsFromRow(row),
      requestCount: row.request_count
    }
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS claude_usage_records (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        timestamp_iso TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        model TEXT,
        source_path TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        raw_usage_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_claude_usage_timestamp_ms
        ON claude_usage_records(timestamp_ms);

      CREATE INDEX IF NOT EXISTS idx_claude_usage_session_id
        ON claude_usage_records(session_id);
    `)
  }
}

function totalsFromRow(row: TotalsRow): TokenUsage {
  if (!row || row.request_count === 0) return emptyTokenUsage()

  return {
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheCreationInputTokens: row.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: row.cache_read_input_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0
  }
}
