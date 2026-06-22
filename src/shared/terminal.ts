import type { PlatformId } from './platform'

export type TerminalPlatform = PlatformId

export type TerminalTab = {
  id: string
  title: string
  cwd: string | null
  sessionKey: string
  wslDistro?: string | null
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
