import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createOpenCodeConfig,
  createOpenCodeRoutingManifest,
  createSlimConfig,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_ROUTING_PROFILE,
  type ManagedOpenCodeConfigOptions
} from '@shared/opencode'
import { detectOpenCodeRuntime, stopOpenCodeRuntime } from './opencode-runtime'
import { installManagedOpenCodeMemoryBankWorkflow } from './opencode-memory-bank-workflow'
import { managedOpenCodeConfigDir, wslHomeToUnc } from './opencode-profile-paths'

export { managedOpenCodeConfigDir, wslHomeToUnc } from './opencode-profile-paths'

async function writeJsonAtomically(path: string, value: Record<string, unknown>): Promise<void> {
  const temporaryPath = `${path}.cadence.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(temporaryPath, path)
}

export async function writeManagedOpenCodeConfiguration({
  configDir,
  slimVersion,
  pinSlimPlugin = false,
  autoUpdate = true
}: ManagedOpenCodeConfigOptions & { configDir: string }): Promise<void> {
  await mkdir(configDir, { recursive: true })
  await Promise.all([
    writeJsonAtomically(
      join(configDir, 'opencode.json'),
      createOpenCodeConfig({ slimVersion, pinSlimPlugin, autoUpdate })
    ),
    writeJsonAtomically(
      join(configDir, 'oh-my-opencode-slim.json'),
      createSlimConfig({ slimVersion, pinSlimPlugin, autoUpdate })
    ),
    writeJsonAtomically(
      join(configDir, 'cadence-routing-manifest.json'),
      createOpenCodeRoutingManifest(slimVersion)
    ),
    installManagedOpenCodeMemoryBankWorkflow(configDir)
  ])
}

export async function enableManagedSlimAutoUpdates(): Promise<void> {
  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro || !runtime.home || !runtime.configured) return
  const configDir = managedOpenCodeConfigDir(runtime.distro, runtime.home)
  const openCodePath = join(configDir, 'opencode.json')
  const slimPath = join(configDir, 'oh-my-opencode-slim.json')
  try {
    await installManagedOpenCodeMemoryBankWorkflow(configDir)
    const [openCode, slim] = await Promise.all([
      readFile(openCodePath, 'utf-8').then((value) => JSON.parse(value) as Record<string, unknown>),
      readFile(slimPath, 'utf-8').then((value) => JSON.parse(value) as Record<string, unknown>)
    ])
    const plugins = Array.isArray(openCode.plugin)
      ? openCode.plugin.filter((entry): entry is string => typeof entry === 'string')
      : []
    const nextPlugins = [
      ...plugins.filter((entry) => !entry.startsWith('oh-my-opencode-slim')),
      'oh-my-opencode-slim'
    ]
    const pluginChanged = JSON.stringify(nextPlugins) !== JSON.stringify(plugins)
    const autoUpdateChanged = slim.autoUpdate !== true
    if (!pluginChanged && !autoUpdateChanged) return
    openCode.plugin = nextPlugins
    slim.autoUpdate = true
    await Promise.all([
      pluginChanged ? writeJsonAtomically(openCodePath, openCode) : Promise.resolve(),
      autoUpdateChanged ? writeJsonAtomically(slimPath, slim) : Promise.resolve()
    ])
  } catch {
    // A partial/older managed profile is repaired by the normal Apply routing flow.
  }
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

  const configDir = managedOpenCodeConfigDir(runtime.distro, runtime.home)
  await writeManagedOpenCodeConfiguration({ configDir })

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
