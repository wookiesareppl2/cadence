import { describe, expect, it } from 'vitest'
import { backgroundTerminalLocations, type TerminalTab } from '../src/shared/terminal'

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
