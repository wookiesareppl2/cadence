import type { PlatformId } from './platform'

export type AssistantSession = {
  id: string
  platform: PlatformId
  projectId: string
  title: string
  rawTitle: string | null
  inferredTitle: string | null
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
