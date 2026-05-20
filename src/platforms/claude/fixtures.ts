import type { UsageSummary } from '@shared/usage'

export const claudeUsageSummary: UsageSummary = {
  rolling: {
    label: '5h',
    inputTokens: 184_220,
    outputTokens: 41_880,
    totalTokens: 226_100,
    percentUsed: 62,
    estimate: true
  },
  weekly: {
    label: '7d',
    inputTokens: 1_834_400,
    outputTokens: 352_980,
    totalTokens: 2_187_380,
    percentUsed: 71,
    estimate: true
  },
  requestCount: 438,
  dedupeKey: 'requestId'
}

export const claudeSessions = [
  { id: 'c-101', title: 'AI Dashboard scaffold', project: '~/projects/ai-dashboard', branch: 'design/initial-system', tokens: '226.1k', age: 'now' },
  { id: 'c-102', title: 'JSONL parser notes', project: '~/.claude/projects', branch: 'usage-core', tokens: '88.4k', age: '14m' },
  { id: 'c-103', title: 'Electron shell review', project: '~/projects/ai-dashboard', branch: 'desktop-shell', tokens: '41.2k', age: '51m' },
  { id: 'c-104', title: 'SQLite aggregation model', project: '~/projects/ai-dashboard', branch: 'storage', tokens: '67.9k', age: '2h' }
]
