import type { PlatformId } from './platform'
import type { SessionOrigin } from './sessions'

export type ProjectCatalogSource = 'attached' | 'provider'

// A known project folder made available to a provider, even when that provider
// has not created a session there yet. Session history remains provider-specific.
export type ProjectCatalogEntry = {
  id: string
  platform: PlatformId
  name: string
  path: string
  branch: string | null
  origin: SessionOrigin
  latestUpdatedAt: string | null
  age: string
  source: ProjectCatalogSource
}
