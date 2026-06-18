import type { WebContents } from 'electron'
import type { PlatformId } from '@shared/platform'
import type { AssistantSession, SessionsUpdatedPayload } from '@shared/sessions'
import { getSessionOrigins, type SessionOriginRoot } from './session-origins'
import { getClaudeSessionsForOrigins, getCodexSessionsForOrigins } from './session-service'

// Channel the main process uses to push a completed full scan to the renderer
// after the fast (Windows-only) first paint. Kept here so the IPC wiring and the
// preload bridge agree on one name.
export const SESSIONS_UPDATED_CHANNEL = 'sessions:updated'

// Short TTL: long enough that flipping between the Claude/Codex tabs (or a quick
// re-poll) reuses the last full scan instead of re-reading the disk, short enough
// that the 60s renderer poll always re-scans for fresh activity.
const CACHE_TTL_MS = 15_000

type CacheEntry = { sessions: AssistantSession[]; expiresAt: number }

// Only complete (all-origin) results are cached. The fast Windows-only result is
// never cached, so a warm hit always returns the full list.
const cache = new Map<PlatformId, CacheEntry>()

// De-dupe concurrent background full scans for the same platform (e.g. the poll
// firing again before the previous WSL scan finished).
const inFlightFull = new Map<PlatformId, Promise<AssistantSession[]>>()

function scanForOrigins(platform: PlatformId, origins: SessionOriginRoot[]): Promise<AssistantSession[]> {
  return platform === 'claude' ? getClaudeSessionsForOrigins(origins) : getCodexSessionsForOrigins(origins)
}

function cacheFull(platform: PlatformId, sessions: AssistantSession[]): void {
  cache.set(platform, { sessions, expiresAt: Date.now() + CACHE_TTL_MS })
}

function pushUpdate(sender: WebContents, platform: PlatformId, sessions: AssistantSession[]): void {
  if (sender.isDestroyed()) return
  sender.send(SESSIONS_UPDATED_CHANNEL, { platform, sessions } satisfies SessionsUpdatedPayload)
}

// Drop cached results so the next scan re-reads disk. Called after a mutation
// (delete) trashes files, so the renderer's follow-up refresh doesn't see the
// deleted session/project resurface from a warm cache.
export function invalidateSessionCache(platform?: PlatformId): void {
  if (platform) cache.delete(platform)
  else cache.clear()
}

// Run the all-origins scan in the background, caching the result and pushing it to
// the renderer. Slow WSL origins (UNC share, possibly auto-booting a distro) live
// here so they never block the fast first paint. Errors are swallowed: the caller
// already returned the Windows-only list.
function runFullScan(
  platform: PlatformId,
  origins: SessionOriginRoot[],
  sender: WebContents
): Promise<AssistantSession[]> {
  const existing = inFlightFull.get(platform)
  if (existing) {
    existing.then((sessions) => pushUpdate(sender, platform, sessions)).catch(() => undefined)
    return existing
  }

  const run = scanForOrigins(platform, origins)
    .then((sessions) => {
      cacheFull(platform, sessions)
      pushUpdate(sender, platform, sessions)
      return sessions
    })
    .finally(() => {
      inFlightFull.delete(platform)
    })

  inFlightFull.set(platform, run)
  run.catch(() => undefined)
  return run
}

// Return the freshest available session list as fast as possible:
//   - a warm full-scan cache, when present (instant tab switches / re-polls);
//   - otherwise the Windows-only scan, while a background full scan (including slow
//     WSL origins) refreshes the cache and pushes the complete list to the renderer
//     over SESSIONS_UPDATED_CHANNEL.
// When there are no remote origins, the single scan is already complete, so it is
// cached and returned directly with no background pass or push.
export async function scanSessions(platform: PlatformId, sender: WebContents): Promise<AssistantSession[]> {
  const cached = cache.get(platform)
  if (cached && cached.expiresAt > Date.now()) return cached.sessions

  const origins = await getSessionOrigins()
  const windowsOrigins = origins.filter((origin) => origin.kind === 'windows')
  const remoteOrigins = origins.filter((origin) => origin.kind !== 'windows')

  if (remoteOrigins.length === 0) {
    const sessions = await scanForOrigins(platform, origins)
    cacheFull(platform, sessions)
    return sessions
  }

  const fast = await scanForOrigins(platform, windowsOrigins)
  void runFullScan(platform, origins, sender)
  return fast
}
