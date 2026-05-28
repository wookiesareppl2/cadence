import type { PlatformId } from './platform'

export type AssistantSession = {
  id: string
  platform: PlatformId
  title: string
  project: string
  branch: string | null
  usageLabel: string | null
  status: string
  age: string
  updatedAt: string | null
}
