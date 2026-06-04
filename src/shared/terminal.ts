import type { PlatformId } from './platform'

export type TerminalPlatform = PlatformId

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
