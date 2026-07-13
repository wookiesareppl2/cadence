import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createOpenCodeConfig,
  createSlimConfig,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_ROUTING_PROFILE,
  OPENCODE_SLIM_VERSION
} from '@shared/opencode'
import { detectOpenCodeRuntime, stopOpenCodeRuntime } from './opencode-runtime'

function wslHomeToUnc(distro: string, home: string): string {
  return `\\\\wsl.localhost\\${distro}${home.replace(/\//g, '\\')}`
}

export async function configureOpenCodeForCadence(): Promise<{
  ok: boolean
  distro: string
  configDir: string
  profile: string
}> {
  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro || !runtime.home) throw new Error(runtime.detail ?? 'OpenCode WSL runtime is unavailable')
  if (!runtime.installed) throw new Error(`Install OpenCode in ${runtime.distro} first`)
  if (!runtime.compatible) throw new Error(`Update OpenCode to ${OPENCODE_MINIMUM_VERSION} or newer first`)
  if (!runtime.connected) throw new Error('Connect your OpenCode Go subscription first')

  const configDir = join(wslHomeToUnc(runtime.distro, runtime.home), '.config', 'cadence', 'opencode')
  await mkdir(configDir, { recursive: true })
  await Promise.all([
    writeFile(join(configDir, 'opencode.json'), `${JSON.stringify(createOpenCodeConfig(), null, 2)}\n`, 'utf-8'),
    writeFile(
      join(configDir, 'oh-my-opencode-slim.json'),
      `${JSON.stringify(createSlimConfig(), null, 2)}\n`,
      'utf-8'
    ),
    writeFile(
      join(configDir, 'cadence-routing-manifest.json'),
      `${JSON.stringify(
        {
          profile: OPENCODE_ROUTING_PROFILE,
          openCodeMinimumVersion: OPENCODE_MINIMUM_VERSION,
          slimVersion: OPENCODE_SLIM_VERSION,
          managedBy: 'Cadence'
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
  ])

  return { ok: true, distro: runtime.distro, configDir, profile: OPENCODE_ROUTING_PROFILE }
}

export async function disconnectOpenCodeGo(): Promise<{ ok: boolean }> {
  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro || !runtime.home) return { ok: true }

  const authPath = join(wslHomeToUnc(runtime.distro, runtime.home), '.local', 'share', 'opencode', 'auth.json')
  try {
    const auth = JSON.parse(await readFile(authPath, 'utf-8')) as Record<string, unknown>
    delete auth['opencode-go']
    await stopOpenCodeRuntime()
    const temporaryPath = `${authPath}.cadence.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, 'utf-8')
    await rename(temporaryPath, authPath)
    return { ok: true }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    return { ok: code === 'ENOENT' }
  }
}
