import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ClaudeUsageIngestStats, ClaudeUsageRecord, TokenUsage } from '@shared/usage'

type UnknownRecord = Record<string, unknown>

type ClaudeUsageScanResult = {
  sourceRoot: string
  records: ClaudeUsageRecord[]
  stats: ClaudeUsageIngestStats
}

const numberFromUnknown = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

const stringFromUnknown = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)

const objectFromUnknown = (value: unknown): UnknownRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null

export const getDefaultClaudeProjectsRoot = (): string => join(homedir(), '.claude', 'projects')

export async function discoverClaudeJsonlFiles(root = getDefaultClaudeProjectsRoot()): Promise<string[]> {
  const files: string[] = []

  async function visit(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path)
      }
    }
  }

  await visit(root)
  return files.sort()
}

export async function scanClaudeUsageRecords(root = getDefaultClaudeProjectsRoot()): Promise<ClaudeUsageScanResult> {
  const files = await discoverClaudeJsonlFiles(root)
  const stats: ClaudeUsageIngestStats = {
    scannedFileCount: files.length,
    parsedLineCount: 0,
    usageRowCount: 0,
    uniqueRequestCount: 0,
    duplicateUsageRowCount: 0,
    skippedUsageRows: 0,
    invalidJsonLineCount: 0
  }
  const records = new Map<string, ClaudeUsageRecord>()

  for (const file of files) {
    const lineReader = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    let lineNumber = 0
    for await (const line of lineReader) {
      lineNumber += 1
      if (line.trim().length === 0) continue
      stats.parsedLineCount += 1

      const parsed = parseClaudeUsageLine(line, file, lineNumber)
      if (parsed.kind === 'invalid-json') {
        stats.invalidJsonLineCount += 1
        continue
      }
      if (parsed.kind === 'skipped') {
        if (parsed.sawUsage) stats.skippedUsageRows += 1
        continue
      }

      stats.usageRowCount += 1
      if (records.has(parsed.record.requestId)) {
        stats.duplicateUsageRowCount += 1
        continue
      }
      records.set(parsed.record.requestId, parsed.record)
    }
  }

  stats.uniqueRequestCount = records.size
  return { sourceRoot: root, records: [...records.values()], stats }
}

export function parseClaudeUsageLine(
  line: string,
  sourcePath: string,
  lineNumber: number
):
  | { kind: 'record'; record: ClaudeUsageRecord }
  | { kind: 'skipped'; sawUsage: boolean }
  | { kind: 'invalid-json' } {
  let row: UnknownRecord
  try {
    row = JSON.parse(line) as UnknownRecord
  } catch {
    return { kind: 'invalid-json' }
  }

  const message = objectFromUnknown(row.message)
  const usage = objectFromUnknown(message?.usage ?? row.usage)
  if (!usage) return { kind: 'skipped', sawUsage: false }

  const requestId = stringFromUnknown(row.requestId) ?? stringFromUnknown(row.request_id)
  const timestampIso = stringFromUnknown(row.timestamp)
  const timestampMs = timestampIso ? Date.parse(timestampIso) : NaN
  if (!requestId || !timestampIso || !Number.isFinite(timestampMs)) {
    return { kind: 'skipped', sawUsage: true }
  }

  const tokenUsage = normalizeTokenUsage(usage)
  return {
    kind: 'record',
    record: {
      requestId,
      sessionId: stringFromUnknown(row.sessionId) ?? 'unknown',
      messageId: stringFromUnknown(message?.id) ?? stringFromUnknown(row.messageId),
      timestampIso,
      timestampMs,
      model: stringFromUnknown(message?.model) ?? stringFromUnknown(row.model),
      sourcePath,
      lineNumber,
      usage: tokenUsage,
      rawUsageJson: JSON.stringify(usage)
    }
  }
}

function normalizeTokenUsage(usage: UnknownRecord): TokenUsage {
  const inputTokens = numberFromUnknown(usage.input_tokens)
  const outputTokens = numberFromUnknown(usage.output_tokens)
  const cacheCreationInputTokens = numberFromUnknown(usage.cache_creation_input_tokens)
  const cacheReadInputTokens = numberFromUnknown(usage.cache_read_input_tokens)

  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens
  }
}
