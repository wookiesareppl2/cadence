import { join } from 'node:path'
import { app } from 'electron'
import type { ClaudeUsageSummary } from '@shared/usage'
import { scanClaudeUsageRecords } from './claude-jsonl'
import { ClaudeUsageStore } from './claude-usage-store'

let store: ClaudeUsageStore | null = null

export async function refreshClaudeUsageSummary(): Promise<ClaudeUsageSummary> {
  const scan = await scanClaudeUsageRecords()
  const usageStore = getUsageStore()
  usageStore.replaceAll(scan.records)
  return usageStore.getSummary(scan.sourceRoot, scan.stats)
}

export function closeClaudeUsageStore(): void {
  store?.close()
  store = null
}

function getUsageStore(): ClaudeUsageStore {
  if (!store) {
    store = new ClaudeUsageStore({
      databasePath: join(app.getPath('userData'), 'usage.sqlite')
    })
  }
  return store
}
