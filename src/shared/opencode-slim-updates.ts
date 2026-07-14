export const OPENCODE_SLIM_UPDATE_STATUS_CHANNEL = 'opencode:slim-update-status'

export type OpenCodeSlimUpdatePhase =
  | 'unavailable'
  | 'current'
  | 'automatic-update-pending'
  | 'major-update-available'
  | 'installing'
  | 'installed'
  | 'cadence-update-required'
  | 'error'

export type OpenCodeSlimUpdateStatus = {
  phase: OpenCodeSlimUpdatePhase
  installedVersion: string | null
  latestVersion: string | null
  detail: string | null
  checkedAt: string | null
}

export type OpenCodeSlimVersionRelation = 'current' | 'same-major-update' | 'major-update' | 'invalid'

type Semver = {
  major: number
  minor: number
  patch: number
}

export function parseOpenCodeSlimVersion(value: string | null): Semver | null {
  if (!value) return null
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function compareOpenCodeSlimVersions(left: string, right: string): number | null {
  const a = parseOpenCodeSlimVersion(left)
  const b = parseOpenCodeSlimVersion(right)
  if (!a || !b) return null
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}

export function classifyOpenCodeSlimUpdate(
  installedVersion: string | null,
  latestVersion: string | null
): OpenCodeSlimVersionRelation {
  const installed = parseOpenCodeSlimVersion(installedVersion)
  const latest = parseOpenCodeSlimVersion(latestVersion)
  if (!installed || !latest) return 'invalid'
  const comparison = compareOpenCodeSlimVersions(installedVersion!, latestVersion!)
  if (comparison === null) return 'invalid'
  if (comparison >= 0) return 'current'
  return installed.major === latest.major ? 'same-major-update' : 'major-update'
}

export function missingCadenceOpenCodeAgents(output: string, requiredAgents: readonly string[]): string[] {
  const normalized = output.toLowerCase()
  return requiredAgents.filter((agent) => {
    const escaped = agent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return !new RegExp(`(^|[^a-z0-9_-])${escaped}([^a-z0-9_-]|$)`, 'i').test(normalized)
  })
}
