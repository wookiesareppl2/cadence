import { join } from 'node:path'
import { app } from 'electron'
import type { ClaudeUsageSummary } from '@shared/usage'
import { scanClaudeUsageRecordsAcrossRoots } from './claude-jsonl'
import { getSessionOrigins } from '../sessions/session-origins'
import { ClaudeUsageStore } from './claude-usage-store'

let store: ClaudeUsageStore | null = null

export async function refreshClaudeUsageSummary(): Promise<ClaudeUsageSummary> {
  // Count token usage from the Windows home plus every WSL distro home, so usage
  // stats reflect work done inside WSL too.
  const origins = await getSessionOrigins()
  const roots = origins.map((origin) => origin.claudeProjectsDir)
  const scan = await scanClaudeUsageRecordsAcrossRoots(roots)
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
