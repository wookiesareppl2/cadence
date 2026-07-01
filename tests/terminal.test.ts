import { describe, expect, it } from 'vitest'
import {
  backgroundTerminalLocations,
  backgroundTerminalSessions,
  restorableTabs,
  type TerminalBackgroundLocation,
  type TerminalTab
} from '../src/shared/terminal'

const tabs: TerminalTab[] = [
  { id: 't1', title: 'Terminal 1', cwd: 'C:\\Projects\\cadence', sessionKey: 's1', wslDistro: null },
  { id: 't2', title: 'Terminal 2', cwd: '/home/user/app', sessionKey: 's2', wslDistro: 'Ubuntu' },
  { id: 't3', title: 'Terminal 1', cwd: 'C:\\Projects\\other', sessionKey: 'missing', wslDistro: null }
]

describe('backgroundTerminalLocations', () => {
  it('returns terminals outside the selected session with project/session labels', () => {
    expect(
      backgroundTerminalLocations(tabs, 's1', [
        {
          sessionKey: 's1',
          sessionTitle: 'Current task',
          projectId: 'project-1',
          projectName: 'Cadence',
          projectPath: 'C:\\Projects\\cadence'
        },
        {
          sessionKey: 's2',
          sessionTitle: 'Fix auth',
          projectId: 'project-2',
          projectName: 'API',
          projectPath: '/home/user/app'
        }
      ])
    ).toEqual([
      {
        terminalId: 't2',
        title: 'Terminal 2',
        sessionKey: 's2',
        sessionTitle: 'Fix auth',
        projectId: 'project-2',
        projectName: 'API',
        projectPath: '/home/user/app',
        cwd: '/home/user/app',
        wslDistro: 'Ubuntu'
      },
      {
        terminalId: 't3',
        title: 'Terminal 1',
        sessionKey: 'missing',
        sessionTitle: 'missing',
        projectId: null,
        projectName: 'Unknown project',
        projectPath: null,
        cwd: 'C:\\Projects\\other',
        wslDistro: null
      }
    ])
  })

  it('treats a null selected session as no visible session', () => {
    expect(backgroundTerminalLocations(tabs, null, [])).toHaveLength(3)
  })
})

describe('restorableTabs', () => {
  const persisted: TerminalTab[] = [
    { id: 't1', title: 'Terminal 1', cwd: 'C:\\Projects\\cadence', sessionKey: 's1', wslDistro: null },
    { id: 't2', title: 'Terminal 1', cwd: 'C:\\Projects\\cadence', sessionKey: '__new__abc', wslDistro: null }
  ]

  it('drops pending-keyed tabs on a fresh launch (keepPending defaults to false)', () => {
    const restored = restorableTabs(persisted)
    expect(restored.map((tab) => tab.id)).toEqual(['t1'])
  })

  it('keeps pending-keyed tabs across a within-run remount', () => {
    const restored = restorableTabs(persisted, { keepPending: true })
    expect(restored.map((tab) => tab.id)).toEqual(['t1', 't2'])
  })

  it('drops legacy tabs missing a cwd or sessionKey and normalises wslDistro', () => {
    const restored = restorableTabs([
      { id: 'ok', title: 'ok', cwd: '/home/app', sessionKey: 's9' } as TerminalTab,
      { id: 'no-cwd', title: 'no-cwd', cwd: null, sessionKey: 's9' },
      { id: 'no-session', title: 'no-session', cwd: '/home/app', sessionKey: '' }
    ])
    expect(restored).toEqual([
      { id: 'ok', title: 'ok', cwd: '/home/app', sessionKey: 's9', wslDistro: null }
    ])
  })
})

describe('backgroundTerminalSessions', () => {
  const location = (
    terminalId: string,
    sessionKey: string,
    overrides: Partial<TerminalBackgroundLocation> = {}
  ): TerminalBackgroundLocation => ({
    terminalId,
    title: terminalId,
    sessionKey,
    sessionTitle: `Session ${sessionKey}`,
    projectId: `project-${sessionKey}`,
    projectName: `Project ${sessionKey}`,
    projectPath: `C:\\Projects\\${sessionKey}`,
    cwd: `C:\\Projects\\${sessionKey}`,
    wslDistro: null,
    ...overrides
  })

  it('groups terminals in the same session into one entry with a count', () => {
    const sessions = backgroundTerminalSessions([
      location('t1', 's1'),
      location('t2', 's1'),
      location('t3', 's2')
    ])

    expect(sessions).toHaveLength(2)
    expect(sessions[0]).toMatchObject({ sessionKey: 's1', terminalCount: 2 })
    expect(sessions[0].terminals.map((t) => t.terminalId)).toEqual(['t1', 't2'])
    expect(sessions[1]).toMatchObject({ sessionKey: 's2', terminalCount: 1 })
  })

  it('preserves first-appearance order and keeps the first terminal as the jump target', () => {
    const sessions = backgroundTerminalSessions([
      location('t1', 's2'),
      location('t2', 's1'),
      location('t3', 's2')
    ])

    expect(sessions.map((s) => s.sessionKey)).toEqual(['s2', 's1'])
    expect(sessions[0].terminals[0].terminalId).toBe('t1')
  })

  it('returns an empty list when there are no background terminals', () => {
    expect(backgroundTerminalSessions([])).toEqual([])
  })
})
