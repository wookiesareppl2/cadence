import { app, Notification } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  classifyOpenCodeSlimUpdate,
  missingCadenceOpenCodeAgents,
  type OpenCodeSlimUpdateStatus
} from '@shared/opencode-slim-updates'
import { OPENCODE_SLIM_VERSION } from '@shared/opencode'
import {
  enableManagedSlimAutoUpdates,
  managedOpenCodeConfigDir,
  writeManagedOpenCodeConfiguration,
  wslHomeToUnc
} from './opencode-config-service'
import {
  detectOpenCodeRuntime,
  getOpenCodeClient,
  REQUIRED_MANAGED_AGENTS,
  runOpenCodeWslCommand,
  stopOpenCodeRuntime
} from './opencode-runtime'

const SLIM_PACKAGE_NAME = 'oh-my-opencode-slim'
const SLIM_DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${SLIM_PACKAGE_NAME}/dist-tags`
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const REGISTRY_TIMEOUT_MS = 8_000
const VALIDATION_TIMEOUT_MS = 120_000

type IncompatibleRecord = {
  cadenceVersion: string
  slimVersion: string
  detail: string
}

type StatusListener = (status: OpenCodeSlimUpdateStatus) => void

const listeners = new Set<StatusListener>()
let checkPromise: Promise<OpenCodeSlimUpdateStatus> | null = null
let installPromise: Promise<OpenCodeSlimUpdateStatus> | null = null
let lastCheckAt = 0
let notifiedMajorVersion: string | null = null
let status: OpenCodeSlimUpdateStatus = {
  phase: 'unavailable',
  installedVersion: null,
  latestVersion: null,
  detail: null,
  checkedAt: null
}

function incompatibleRecordPath(): string {
  return join(app.getPath('userData'), 'opencode-slim-update.json')
}

async function readIncompatibleRecord(): Promise<IncompatibleRecord | null> {
  try {
    const value = JSON.parse(await readFile(incompatibleRecordPath(), 'utf-8')) as Partial<IncompatibleRecord>
    if (
      typeof value.cadenceVersion === 'string' &&
      typeof value.slimVersion === 'string' &&
      typeof value.detail === 'string'
    ) {
      return value as IncompatibleRecord
    }
  } catch {
    // No previously rejected major for this Cadence build.
  }
  return null
}

async function writeIncompatibleRecord(record: IncompatibleRecord | null): Promise<void> {
  const path = incompatibleRecordPath()
  if (!record) {
    await rm(path, { force: true }).catch(() => undefined)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf-8')
}

function publish(next: OpenCodeSlimUpdateStatus): OpenCodeSlimUpdateStatus {
  status = next
  for (const listener of listeners) listener(next)
  return next
}

export function subscribeOpenCodeSlimUpdates(listener: StatusListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function unavailable(detail: string | null = null): OpenCodeSlimUpdateStatus {
  return {
    phase: 'unavailable',
    installedVersion: null,
    latestVersion: null,
    detail,
    checkedAt: new Date().toISOString()
  }
}

async function readJsonVersion(path: string): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf-8')) as { version?: unknown; slimVersion?: unknown }
    if (typeof value.version === 'string') return value.version
    return typeof value.slimVersion === 'string' ? value.slimVersion : null
  } catch {
    return null
  }
}

async function installedSlimVersion(distro: string, home: string): Promise<string | null> {
  const root = wslHomeToUnc(distro, home)
  const cached = await readJsonVersion(
    join(root, '.cache', 'opencode', 'node_modules', SLIM_PACKAGE_NAME, 'package.json')
  )
  if (cached) return cached
  return readJsonVersion(join(managedOpenCodeConfigDir(distro, home), 'cadence-routing-manifest.json'))
}

async function latestSlimVersion(): Promise<string> {
  const response = await fetch(SLIM_DIST_TAGS_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`Slim registry returned ${response.status}`)
  const tags = (await response.json()) as { latest?: unknown }
  if (typeof tags.latest !== 'string') throw new Error('Slim registry did not return a latest version')
  return tags.latest
}

async function checkNow(): Promise<OpenCodeSlimUpdateStatus> {
  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro || !runtime.home || !runtime.installed || !runtime.configured) {
    return publish(unavailable())
  }

  await enableManagedSlimAutoUpdates()
  const installedVersion = (await installedSlimVersion(runtime.distro, runtime.home)) ?? OPENCODE_SLIM_VERSION
  let latestVersion: string
  try {
    latestVersion = await latestSlimVersion()
  } catch (error) {
    return publish({
      phase: 'error',
      installedVersion,
      latestVersion: null,
      detail: error instanceof Error ? error.message : 'Could not check Slim updates',
      checkedAt: new Date().toISOString()
    })
  }

  const relation = classifyOpenCodeSlimUpdate(installedVersion, latestVersion)
  const checkedAt = new Date().toISOString()
  if (relation === 'invalid') {
    return publish({
      phase: 'error',
      installedVersion,
      latestVersion,
      detail: 'Cadence could not compare the installed and available Slim versions.',
      checkedAt
    })
  }
  if (relation === 'current') {
    return publish({
      phase: 'current',
      installedVersion,
      latestVersion,
      detail: null,
      checkedAt
    })
  }
  if (relation === 'same-major-update') {
    return publish({
      phase: 'automatic-update-pending',
      installedVersion,
      latestVersion,
      detail: 'Slim will install this compatible update in the background when the next OpenCode session starts.',
      checkedAt
    })
  }

  const incompatible = await readIncompatibleRecord()
  if (
    incompatible?.cadenceVersion === app.getVersion() &&
    incompatible.slimVersion === latestVersion
  ) {
    return publish({
      phase: 'cadence-update-required',
      installedVersion,
      latestVersion,
      detail: incompatible.detail,
      checkedAt
    })
  }

  return publish({
    phase: 'major-update-available',
    installedVersion,
    latestVersion,
    detail: 'Cadence can validate this major in isolation before changing the active OpenCode configuration.',
    checkedAt
  })
}

export async function getOpenCodeSlimUpdateStatus(force = false): Promise<OpenCodeSlimUpdateStatus> {
  if (installPromise) return installPromise
  if (!force && Date.now() - lastCheckAt < CHECK_INTERVAL_MS && status.checkedAt) return status
  if (checkPromise) return checkPromise
  checkPromise = checkNow().finally(() => {
    lastCheckAt = Date.now()
    checkPromise = null
  })
  return checkPromise
}

async function validateSlimVersion({
  distro,
  version,
  stagingDir
}: {
  distro: string
  version: string
  stagingDir: string
}): Promise<{ output: string; missing: string[] }> {
  await writeManagedOpenCodeConfiguration({
    configDir: stagingDir,
    slimVersion: version,
    pinSlimPlugin: true,
    autoUpdate: false
  })
  const stagingName = stagingDir.split(/[\\/]/).pop()!
  const command = [
    `export OPENCODE_CONFIG_DIR="$HOME/.config/cadence/${stagingName}"`,
    'export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true',
    `$HOME/.opencode/bin/opencode agent list`
  ].join('; ')
  const output = await runOpenCodeWslCommand(distro, command, VALIDATION_TIMEOUT_MS)
  return { output, missing: missingCadenceOpenCodeAgents(output, REQUIRED_MANAGED_AGENTS) }
}

async function openCodeIsBusy(): Promise<boolean> {
  const client = await getOpenCodeClient()
  const response = await client.session.status()
  return Object.values(response.data ?? {}).some((entry) => entry.type === 'busy' || entry.type === 'retry')
}

function compatibilityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /invalid config|unknown (?:field|option)|schema|failed to load|cannot find export|is not a function|syntaxerror|typeerror/i.test(message)
}

async function installMajor(): Promise<OpenCodeSlimUpdateStatus> {
  const available = await getOpenCodeSlimUpdateStatus(true)
  if (available.phase !== 'major-update-available' || !available.latestVersion || !available.installedVersion) {
    return available
  }
  if (await openCodeIsBusy()) {
    return publish({
      ...available,
      detail: 'OpenCode is currently working. Finish the active response before installing this update.'
    })
  }

  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro || !runtime.home) return publish(unavailable('The OpenCode WSL runtime is unavailable.'))
  const latestVersion = available.latestVersion
  const installedVersion = available.installedVersion
  const cadenceRoot = join(wslHomeToUnc(runtime.distro, runtime.home), '.config', 'cadence')
  const stagingDir = join(cadenceRoot, `opencode-update-staging-${process.pid}`)
  publish({
    phase: 'installing',
    installedVersion,
    latestVersion,
    detail: 'Loading the new Slim version and checking every Cadence-managed agent.',
    checkedAt: new Date().toISOString()
  })

  try {
    let validation: { output: string; missing: string[] }
    try {
      validation = await validateSlimVersion({
        distro: runtime.distro,
        version: latestVersion,
        stagingDir
      })
    } catch (error) {
      await validateSlimVersion({
        distro: runtime.distro,
        version: installedVersion,
        stagingDir
      }).catch(() => undefined)
      if (compatibilityFailure(error)) {
        const detail = `Slim ${latestVersion} could not load with this Cadence integration. Slim ${installedVersion} was restored. Install a newer Cadence version before retrying.`
        await writeIncompatibleRecord({ cadenceVersion: app.getVersion(), slimVersion: latestVersion, detail })
        return publish({
          phase: 'cadence-update-required',
          installedVersion,
          latestVersion,
          detail,
          checkedAt: new Date().toISOString()
        })
      }
      return publish({
        phase: 'error',
        installedVersion,
        latestVersion,
        detail: `${error instanceof Error ? error.message : 'Slim validation failed'} The previous version was restored; retry when the connection is stable.`,
        checkedAt: new Date().toISOString()
      })
    }

    if (validation.missing.length > 0) {
      await validateSlimVersion({
        distro: runtime.distro,
        version: installedVersion,
        stagingDir
      }).catch(() => undefined)
      const detail = `Slim ${latestVersion} is missing required agents: ${validation.missing.join(', ')}. Slim ${installedVersion} was restored. A Cadence application update is required.`
      await writeIncompatibleRecord({ cadenceVersion: app.getVersion(), slimVersion: latestVersion, detail })
      return publish({
        phase: 'cadence-update-required',
        installedVersion,
        latestVersion,
        detail,
        checkedAt: new Date().toISOString()
      })
    }

    await writeManagedOpenCodeConfiguration({
      configDir: managedOpenCodeConfigDir(runtime.distro, runtime.home),
      slimVersion: latestVersion,
      pinSlimPlugin: false,
      autoUpdate: true
    })
    await writeIncompatibleRecord(null)
    await stopOpenCodeRuntime()
    return publish({
      phase: 'installed',
      installedVersion: latestVersion,
      latestVersion,
      detail: 'The update passed validation. OpenCode will use it the next time it starts.',
      checkedAt: new Date().toISOString()
    })
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function installOpenCodeSlimMajorUpdate(): Promise<OpenCodeSlimUpdateStatus> {
  if (installPromise) return installPromise
  installPromise = installMajor().finally(() => {
    installPromise = null
  })
  return installPromise
}

function notifyMajorUpdate(next: OpenCodeSlimUpdateStatus, onClick: () => void): void {
  if (
    (next.phase !== 'major-update-available' && next.phase !== 'cadence-update-required') ||
    !next.latestVersion
  ) return
  if (notifiedMajorVersion === next.latestVersion || !Notification.isSupported()) return
  notifiedMajorVersion = next.latestVersion
  const notification = new Notification({
    title:
      next.phase === 'cadence-update-required'
        ? `Cadence update required for Slim ${next.latestVersion}`
        : `Slim ${next.latestVersion} is available`,
    body:
      next.phase === 'cadence-update-required'
        ? 'The current Slim version remains active. Update Cadence before installing this major.'
        : 'Open Cadence to validate and install this major update safely.'
  })
  notification.on('click', onClick)
  notification.show()
}

export function initOpenCodeSlimUpdateChecks(onNotificationClick: () => void): () => void {
  const check = (): void => {
    getOpenCodeSlimUpdateStatus(true)
      .then((next) => notifyMajorUpdate(next, onNotificationClick))
      .catch((error) => console.error('[opencode-slim-update] check failed', error))
  }
  const initialTimer = setTimeout(check, 5_000)
  const interval = setInterval(check, CHECK_INTERVAL_MS)
  return () => {
    clearTimeout(initialTimer)
    clearInterval(interval)
  }
}
