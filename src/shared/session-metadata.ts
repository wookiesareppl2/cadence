import type { PlatformId } from './platform'
import type { AssistantSession } from './sessions'

// User-set display overrides for the otherwise inferred project/session names.
// These are app-only aliases — the underlying CLI transcript files are never
// renamed (their filenames/dirs are how Claude Code and Codex resolve sessions),
// so the alias is layered over the inferred name purely in the dashboard UI.
export type SessionMetadata = {
  // projectId (`<platform>:<resolved-lowercased-cwd>`) -> custom project name
  projectAliases: Record<string, string>
  // `<platform>:<sessionId>` -> custom session title
  sessionAliases: Record<string, string>
}

export function emptyMetadata(): SessionMetadata {
  return { projectAliases: {}, sessionAliases: {} }
}

export function sessionAliasKey(platform: PlatformId, sessionId: string): string {
  return `${platform}:${sessionId}`
}

export function isInternalSessionAlias(value: string | null | undefined): boolean {
  const normalized = value?.trim()
  if (!normalized) return false
  if (/<\/?subagent_notification\b/i.test(normalized)) return true
  return (
    normalized.startsWith('{') &&
    /"agent_(?:id|path)"\s*:/.test(normalized) &&
    /"status"\s*:/.test(normalized)
  )
}

// Returns the alias-overridden session, or the original untouched when no alias
// exists. A blank alias is treated as "no override" so a cleared name falls back
// to the inferred title.
export function applySessionAlias(
  session: AssistantSession,
  sessionAliases: Record<string, string>
): AssistantSession {
  const alias = sessionAliases[sessionAliasKey(session.platform, session.id)]
  if (!alias || !alias.trim() || isInternalSessionAlias(alias)) return session
  return { ...session, title: alias }
}

// Returns the alias for a project id, or the inferred name when none is set.
export function applyProjectAlias(
  name: string,
  projectId: string,
  projectAliases: Record<string, string>
): string {
  const alias = projectAliases[projectId]
  return alias && alias.trim() ? alias : name
}
