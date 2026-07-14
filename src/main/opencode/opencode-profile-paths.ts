import { join } from 'node:path'

export function wslHomeToUnc(distro: string, home: string): string {
  return `\\\\wsl.localhost\\${distro}${home.replace(/\//g, '\\')}`
}

export function managedOpenCodeConfigDir(distro: string, home: string): string {
  return join(wslHomeToUnc(distro, home), '.config', 'cadence', 'opencode')
}

