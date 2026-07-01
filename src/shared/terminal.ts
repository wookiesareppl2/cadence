import type { PlatformId } from './platform'

export type TerminalPlatform = PlatformId

export type TerminalTab = {
  id: string
  title: string
  cwd: string | null
  sessionKey: string
  wslDistro?: string | null
  // A command auto-run once when this tab's shell first starts (e.g. a session
  // resume). In-memory only — intentionally not persisted, so a reload (which
  // reconnects the live pty via replay) never re-fires it.
  initialInput?: string | null
}

// Pending-session keys tag terminals whose session has no transcript on disk yet;
// this mirrors the renderer's pending-session id scheme (`__new__…`). Kept here so
// tab restoration — which drops or keeps pending tabs depending on context — can be
// unit-tested without the renderer.
export function isPendingSessionKey(key: string): boolean {
  return key.startsWith('__new__')
}

// Rebuild the persisted terminal tabs that should be restored. A tab needs both a
// cwd and the sessionKey that scopes it; legacy tabs predating session scoping are
// dropped. Pending-keyed tabs (a session not yet adopted) are dropped on a fresh
// app launch — by then anything real was retagged and an unadopted pending session
// is transient — but kept when `keepPending` is set, which the deck does for a
// within-run remount (e.g. a platform switch unmounts the inactive workspace) so a
// brand-new session's live terminal survives the switch and can still be adopted.
export function restorableTabs(tabs: TerminalTab[], options?: { keepPending?: boolean }): TerminalTab[] {
  const keepPending = options?.keepPending ?? false
  return tabs
    .filter(
      (tab): tab is TerminalTab =>
        typeof tab.cwd === 'string' &&
        tab.cwd.length > 0 &&
        typeof tab.sessionKey === 'string' &&
        tab.sessionKey.length > 0 &&
        (keepPending || !isPendingSessionKey(tab.sessionKey))
    )
    .map((tab) => ({
      id: tab.id,
      title: tab.title,
      cwd: tab.cwd,
      sessionKey: tab.sessionKey,
      wslDistro: tab.wslDistro ?? null
    }))
}

export type TerminalStartResult = {
  terminalId: string
  platform: TerminalPlatform
  cwd: string
  shell: string
  pid: number
  replay: string
}

export type TerminalDataEvent = {
  terminalId: string
  platform: TerminalPlatform
  data: string
}

export type TerminalDetachedEvent = {
  platform: TerminalPlatform
}

export const TERMINAL_DETACHED_CLOSED_CHANNEL = 'terminal:detached-closed'

export type TerminalSessionLocator = {
  sessionKey: string
  sessionTitle: string
  projectId: string | null
  projectName: string
  projectPath: string | null
}

export type TerminalBackgroundLocation = {
  terminalId: string
  title: string
  sessionKey: string
  sessionTitle: string
  projectId: string | null
  projectName: string
  projectPath: string | null
  cwd: string | null
  wslDistro: string | null
}

export function backgroundTerminalLocations(
  tabs: TerminalTab[],
  selectedSessionKey: string | null,
  sessions: TerminalSessionLocator[]
): TerminalBackgroundLocation[] {
  const locators = new Map(sessions.map((session) => [session.sessionKey, session]))
  return tabs
    .filter((tab) => tab.sessionKey !== selectedSessionKey)
    .map((tab) => {
      const locator = locators.get(tab.sessionKey)
      return {
        terminalId: tab.id,
        title: tab.title,
        sessionKey: tab.sessionKey,
        sessionTitle: locator?.sessionTitle ?? tab.sessionKey,
        projectId: locator?.projectId ?? null,
        projectName: locator?.projectName ?? 'Unknown project',
        projectPath: locator?.projectPath ?? null,
        cwd: tab.cwd,
        wslDistro: tab.wslDistro ?? null
      }
    })
}

export type TerminalBackgroundSession = {
  sessionKey: string
  sessionTitle: string
  projectId: string | null
  projectName: string
  projectPath: string | null
  // A representative working directory for the row (the session's first
  // background terminal); terminals in a session usually share the project root.
  cwd: string | null
  wslDistro: string | null
  terminalCount: number
  // The terminals in this session, in discovery order. Selecting any of them
  // jumps to the same session, so the menu only needs the first as the target.
  terminals: TerminalBackgroundLocation[]
}

// Collapse per-terminal background locations into one entry per session.
// Multiple terminals in the same session all jump to that session, so listing
// each terminal separately just clutters the locator — group them and surface a
// count instead. Order follows first appearance.
export function backgroundTerminalSessions(
  locations: TerminalBackgroundLocation[]
): TerminalBackgroundSession[] {
  const order: string[] = []
  const groups = new Map<string, TerminalBackgroundSession>()
  for (const location of locations) {
    const existing = groups.get(location.sessionKey)
    if (existing) {
      existing.terminalCount += 1
      existing.terminals.push(location)
      continue
    }
    order.push(location.sessionKey)
    groups.set(location.sessionKey, {
      sessionKey: location.sessionKey,
      sessionTitle: location.sessionTitle,
      projectId: location.projectId,
      projectName: location.projectName,
      projectPath: location.projectPath,
      cwd: location.cwd,
      wslDistro: location.wslDistro,
      terminalCount: 1,
      terminals: [location]
    })
  }
  return order.map((key) => groups.get(key)!)
}
