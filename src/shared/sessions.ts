import type { PlatformId } from './platform'

// Where a session's transcript physically lives. The app scans the Windows user
// profile plus every WSL distro home, so sessions created inside WSL surface too.
export type SessionOrigin = {
  id: string // 'windows' | 'wsl:Ubuntu'
  kind: 'windows' | 'wsl'
  label: string // badge text: 'Windows' | 'Ubuntu'
  distro: string | null // WSL distro name, null for Windows
}

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
  origin: SessionOrigin
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
  origin: SessionOrigin
  sessionCount: number
  latestUpdatedAt: string | null
  age: string
}

export const WINDOWS_ORIGIN: SessionOrigin = { id: 'windows', kind: 'windows', label: 'Windows', distro: null }

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
