import type { PlatformId } from './platform'

export type TerminalPlatform = PlatformId

export type TerminalStartResult = {
  platform: TerminalPlatform
  cwd: string
  shell: string
  pid: number
  replay: string
}

export type TerminalDataEvent = {
  platform: TerminalPlatform
  data: string
}
