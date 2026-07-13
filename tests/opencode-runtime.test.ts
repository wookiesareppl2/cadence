import { describe, expect, it } from 'vitest'
import {
  isOpenCodeVersionCompatible,
  windowsPathToWsl,
  wslPathToWindows
} from '../src/main/opencode/opencode-runtime'

describe('OpenCode WSL path mapping', () => {
  it('maps Windows workspaces into WSL mount paths', () => {
    expect(windowsPathToWsl('C:\\work\\cadence')).toBe('/mnt/c/work/cadence')
  })

  it('preserves POSIX paths and maps WSL mounts back to Windows', () => {
    expect(windowsPathToWsl('/home/user/project')).toBe('/home/user/project')
    expect(wslPathToWindows('/mnt/d/projects/app')).toBe('D:\\projects\\app')
    expect(wslPathToWindows('/home/user/project')).toBeNull()
  })
})

describe('OpenCode version compatibility', () => {
  it('accepts the pinned SDK generation and newer releases', () => {
    expect(isOpenCodeVersionCompatible('1.17.18')).toBe(true)
    expect(isOpenCodeVersionCompatible('opencode 1.18.0')).toBe(true)
    expect(isOpenCodeVersionCompatible('2.0.0')).toBe(true)
  })

  it('rejects old or unparseable versions', () => {
    expect(isOpenCodeVersionCompatible('1.17.17')).toBe(false)
    expect(isOpenCodeVersionCompatible('unknown')).toBe(false)
    expect(isOpenCodeVersionCompatible(null)).toBe(false)
  })
})
