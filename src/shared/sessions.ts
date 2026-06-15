import type { PlatformId } from './platform'

export type SessionTitleSource = 'manual' | 'generated' | 'heuristic' | 'raw' | 'fallback'

export type SessionTitleStatus = 'ready' | 'pending' | 'stale' | 'failed' | 'disabled'

export type SessionTitleGenerationStatus = {
  enabled: boolean
  pending: number
  running: boolean
  processed: number
  failed: number
  lastError: string | null
}

export type AssistantSession = {
  id: string
  platform: PlatformId
  projectId: string
  title: string
  rawTitle: string | null
  inferredTitle: string | null
  generatedTitle: string | null
  titleSource: SessionTitleSource
  titleStatus: SessionTitleStatus | null
  titleUpdatedAt: string | null
  project: string
  projectPath: string | null
  branch: string | null
  usageLabel: string | null
  status: string
  age: string
  updatedAt: string | null
}

export type AssistantProject = {
  id: string
  platform: PlatformId
  name: string
  path: string | null
  branch: string | null
  sessionCount: number
  latestUpdatedAt: string | null
  age: string
}

export type AssistantSessionHistoryEntry = {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  label: string
  text: string
  timestamp: string | null
}

export type AssistantSessionHistory = {
  sessionId: string
  platform: PlatformId
  title: string
  project: string
  entries: AssistantSessionHistoryEntry[]
}
