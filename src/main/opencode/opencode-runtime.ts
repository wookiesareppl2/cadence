import { app } from 'electron'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_ROUTING_PROFILE,
  OPENCODE_ROUTING_REVISION
} from '@shared/opencode'
import {
  runWslCommandViaPty,
  startOpenCodeServerViaPty,
  stopOpenCodeServerViaPty
} from './opencode-wsl-bridge'
import { OpenCodeLifecycle } from './opencode-lifecycle'
import { installManagedOpenCodeMemoryBankWorkflow } from './opencode-memory-bank-workflow'
import { managedOpenCodeConfigDir } from './opencode-profile-paths'

const execFileAsync = promisify(execFile)
const COMMAND_TIMEOUT_MS = 10_000
const START_TIMEOUT_MS = 60_000
const MANAGED_AGENT_TIMEOUT_MS = 30_000
const SKIP_DISTRO = /^docker-desktop(-data)?$/i
export const REQUIRED_MANAGED_AGENTS = [
  'orchestrator',
  'oracle',
  'explorer',
  'librarian',
  'designer',
  'fixer',
  'observer',
  'council',
  'quick-fixer',
  'deep-fixer'
] as const

export type OpenCodeRuntimeDetection = {
  kind: 'wsl'
  distro: string | null
  availableDistros: string[]
  home: string | null
  installed: boolean
  compatible: boolean
  version: string | null
  connected: boolean
  configured: boolean
  detail: string | null
}

type RunningOpenCode = {
  distro: string
  port: number
  password: string
  baseUrl: string
  home: string
}

// The managed server runs on a fresh random port every start. Rather than freeze
// that port into each terminal's `opencode` command — which strands the terminal
// the moment the server moves — Cadence writes the current URL + password here on
// every (re)start, and the terminal wrapper reads it at launch time. Keep this
// filename in sync with the wrapper in terminal-worker.cjs.
export const SERVER_ENDPOINT_FILE = 'server-endpoint.env'

// A two-line KEY=value file the terminal wrapper parses with `sed`. Values are
// app-generated and shell-safe (a localhost URL and a hex password), one per line.
export function formatServerEndpoint(baseUrl: string, password: string): string {
  return `CADENCE_OPENCODE_URL=${baseUrl}\nCADENCE_OPENCODE_PASSWORD=${password}\n`
}

async function writeServerEndpoint(runtime: RunningOpenCode): Promise<void> {
  const uncPath = join(managedOpenCodeConfigDir(runtime.distro, runtime.home), SERVER_ENDPOINT_FILE)
  await mkdir(dirname(uncPath), { recursive: true })
  const temporaryPath = `${uncPath}.${process.pid}.cadence.tmp`
  try {
    await writeFile(temporaryPath, formatServerEndpoint(runtime.baseUrl, runtime.password), 'utf-8')
    await rename(temporaryPath, uncPath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  // The file carries the server password; a UNC write can't set POSIX mode, so
  // tighten it to the user through the WSL bridge. Best-effort — a single-user
  // WSL home is already private, and the server exposes the same password in its
  // own process environment.
  const posixPath = `${runtime.home}/.config/cadence/opencode/${SERVER_ENDPOINT_FILE}`
  await runWslCommandViaPty(runtime.distro, `chmod 600 ${shellSingleQuote(posixPath)}`, COMMAND_TIMEOUT_MS).catch(
    () => undefined
  )
}

async function removeServerEndpoint(runtime: RunningOpenCode): Promise<void> {
  const uncPath = join(managedOpenCodeConfigDir(runtime.distro, runtime.home), SERVER_ENDPOINT_FILE)
  await unlink(uncPath).catch(() => undefined)
}

let running: RunningOpenCode | null = null
const lifecycle = new OpenCodeLifecycle<RunningOpenCode>()

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('OpenCode runtime startup stopped')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

function versionParts(value: string): [number, number, number] | null {
  const match = value.match(/(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function isOpenCodeVersionCompatible(version: string | null): boolean {
  if (!version) return false
  const current = versionParts(version)
  const minimum = versionParts(OPENCODE_MINIMUM_VERSION)
  if (!current || !minimum) return false
  for (let index = 0; index < current.length; index += 1) {
    if (current[index] !== minimum[index]) return current[index] > minimum[index]
  }
  return true
}

function preferencePath(): string {
  return join(app.getPath('userData'), 'opencode-runtime.json')
}

function decodeWslList(stdout: string | Buffer): string[] {
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
  const decoded = buffer.includes(0) ? buffer.toString('utf16le') : buffer.toString('utf8')
  return decoded
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0 && !SKIP_DISTRO.test(line))
}

async function listRegisteredWslDistros(): Promise<string[]> {
  try {
    const command = [
      "Get-ChildItem -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss' -ErrorAction SilentlyContinue",
      "ForEach-Object { (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).DistributionName }"
    ].join(' | ')
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ], {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    })
    return decodeWslList(stdout)
  } catch {
    return []
  }
}

export async function listOpenCodeWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileAsync('wsl.exe', ['-l', '-q'], {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'buffer',
      maxBuffer: 1024 * 1024
    })
    const distros = decodeWslList(stdout)
    return distros.length > 0 ? distros : listRegisteredWslDistros()
  } catch {
    return listRegisteredWslDistros()
  }
}

async function preferredDistro(available: string[]): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(preferencePath(), 'utf-8')) as { distro?: unknown }
    if (typeof parsed.distro === 'string' && available.includes(parsed.distro)) return parsed.distro
  } catch {
    // First run or an invalid preference: use the first real distro.
  }
  return available[0] ?? null
}

export async function setPreferredOpenCodeDistro(distro: string): Promise<void> {
  const available = await listOpenCodeWslDistros()
  if (!available.includes(distro)) throw new Error(`WSL distribution not found: ${distro}`)
  await writeFile(preferencePath(), `${JSON.stringify({ distro }, null, 2)}\n`, 'utf-8')
  if (running && running.distro !== distro) await stopOpenCodeRuntime()
}

export async function runOpenCodeWslCommand(
  distro: string,
  command: string,
  timeout = COMMAND_TIMEOUT_MS
): Promise<string> {
  return runWslCommandViaPty(distro, command, timeout)
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export async function detectOpenCodeRuntime(): Promise<OpenCodeRuntimeDetection> {
  if (process.platform !== 'win32') {
    return {
      kind: 'wsl',
      distro: null,
      availableDistros: [],
      home: null,
      installed: false,
      compatible: false,
      version: null,
      connected: false,
      configured: false,
      detail: 'The current Cadence OpenCode integration requires WSL on Windows.'
    }
  }

  const availableDistros = await listOpenCodeWslDistros()
  const distro = await preferredDistro(availableDistros)
  if (!distro) {
    return {
      kind: 'wsl',
      distro: null,
      availableDistros,
      home: null,
      installed: false,
      compatible: false,
      version: null,
      connected: false,
      configured: false,
      detail: 'Install an Ubuntu WSL distribution before setting up OpenCode.'
    }
  }

  try {
    const probe = await runOpenCodeWslCommand(
      distro,
      [
        `printf 'home=%s\\n' "$HOME"`,
        `if test -x $HOME/.opencode/bin/opencode; then printf 'version=%s\\n' "$($HOME/.opencode/bin/opencode --version | head -n 1)"; else printf 'version=\\n'; fi`,
        `if test -f "$HOME/.local/share/opencode/auth.json" && grep -q '"opencode-go"' "$HOME/.local/share/opencode/auth.json"; then printf 'connected=yes\\n'; else printf 'connected=no\\n'; fi`,
        `if test -f "$HOME/.config/cadence/opencode/oh-my-opencode-slim.json" && grep -q ${shellSingleQuote(OPENCODE_ROUTING_PROFILE)} "$HOME/.config/cadence/opencode/oh-my-opencode-slim.json" && test -f "$HOME/.config/cadence/opencode/cadence-routing-manifest.json" && grep -q ${shellSingleQuote(`"routingRevision": ${OPENCODE_ROUTING_REVISION}`)} "$HOME/.config/cadence/opencode/cadence-routing-manifest.json"; then printf 'configured=yes\\n'; else printf 'configured=no\\n'; fi`
      ].join('; ')
    )
    const fields = new Map(
      probe
        .split(/\r?\n/)
        .map((line) => line.split(/=(.*)/s))
        .filter((parts) => parts.length >= 2)
        .map(([key, value]) => [key, value])
    )
    const version = fields.get('version')?.trim() || null
    const compatible = isOpenCodeVersionCompatible(version)
    return {
      kind: 'wsl',
      distro,
      availableDistros,
      home: fields.get('home')?.trim() || null,
      installed: version !== null,
      compatible,
      version,
      connected: fields.get('connected') === 'yes',
      configured: fields.get('configured') === 'yes',
      detail: version
        ? compatible
          ? `Running in ${distro}`
          : `Update OpenCode to ${OPENCODE_MINIMUM_VERSION} or newer in ${distro}`
        : `Install OpenCode in ${distro}`
    }
  } catch (error) {
    return {
      kind: 'wsl',
      distro,
      availableDistros,
      home: null,
      installed: false,
      compatible: false,
      version: null,
      connected: false,
      configured: false,
      detail: error instanceof Error ? error.message : `Unable to inspect ${distro}`
    }
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

async function waitForHealth(baseUrl: string, password: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS
  let lastError: unknown
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { Authorization: basicAuth(password) },
        signal: requestSignal(signal, 1_500)
      })
      if (response.ok) return
      lastError = new Error(`OpenCode health returned ${response.status}`)
    } catch (error) {
      throwIfAborted(signal)
      lastError = error
    }
    await wait(250, signal)
  }
  throw lastError instanceof Error ? lastError : new Error('OpenCode server did not become ready')
}

async function validateManagedAgents(
  baseUrl: string,
  password: string,
  signal: AbortSignal
): Promise<void> {
  const client = createOpencodeClient({
    baseUrl,
    headers: { Authorization: basicAuth(password) },
    throwOnError: true
  })

  const deadline = Date.now() + MANAGED_AGENT_TIMEOUT_MS
  let lastError: unknown
  let missing = [...REQUIRED_MANAGED_AGENTS]
  while (Date.now() < deadline) {
    throwIfAborted(signal)
    try {
      const response = await client.app.agents()
      const names = new Set((response.data ?? []).map((agent) => agent.name))
      missing = REQUIRED_MANAGED_AGENTS.filter((name) => !names.has(name))
      if (missing.length === 0) return
      lastError = new Error(`missing ${missing.join(', ')}`)
    } catch (error) {
      throwIfAborted(signal)
      lastError = error
    }
    await wait(500, signal)
  }

  const detail = lastError instanceof Error ? lastError.message : `missing ${missing.join(', ')}`
  throw new Error(`Cadence OpenCode profile did not load: ${detail}`)
}

async function startOpenCodeRuntime(signal: AbortSignal): Promise<RunningOpenCode> {
  throwIfAborted(signal)
  if (running) {
    try {
      const response = await fetch(`${running.baseUrl}/global/health`, {
        headers: { Authorization: basicAuth(running.password) },
        signal: requestSignal(signal, 1_500)
      })
      if (response.ok) {
        throwIfAborted(signal)
        return running
      }
    } catch {
      throwIfAborted(signal)
      // The worker or server exited; clear it and start a fresh managed runtime.
    }
    running = null
    await stopOpenCodeServerViaPty().catch(() => undefined)
  }

  const detection = await detectOpenCodeRuntime()
  throwIfAborted(signal)
  if (!detection.distro) throw new Error(detection.detail ?? 'OpenCode requires a WSL distribution')
  if (!detection.installed) throw new Error(`OpenCode is not installed in ${detection.distro}`)
  if (!detection.compatible) {
    throw new Error(`OpenCode ${OPENCODE_MINIMUM_VERSION} or newer is required`)
  }
  if (!detection.configured) throw new Error('Configure the Cadence OpenCode routing profile first')
  if (!detection.home) throw new Error(`Unable to resolve the home directory in ${detection.distro}`)

  await installManagedOpenCodeMemoryBankWorkflow(
    managedOpenCodeConfigDir(detection.distro, detection.home)
  )
  throwIfAborted(signal)

  const port = await availablePort()
  throwIfAborted(signal)
  const password = randomBytes(24).toString('hex')
  const baseUrl = `http://127.0.0.1:${port}`
  const command = [
    `export OPENCODE_CONFIG_DIR="$HOME/.config/cadence/opencode"`,
    `export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`,
    `export OPENCODE_SERVER_PASSWORD=${shellSingleQuote(password)}`,
    `exec $HOME/.opencode/bin/opencode serve --hostname 127.0.0.1 --port ${port}`
  ].join('; ')
  const candidate: RunningOpenCode = {
    distro: detection.distro,
    port,
    password,
    baseUrl,
    home: detection.home
  }

  try {
    await startOpenCodeServerViaPty(detection.distro, command)
    throwIfAborted(signal)
    await waitForHealth(baseUrl, password, signal)
    await validateManagedAgents(baseUrl, password, signal)
    throwIfAborted(signal)
    running = candidate
    // Publish the live address so terminals resolve it at launch time. Best-effort:
    // the server itself is up and usable by the in-process client regardless, so a
    // transient UNC hiccup must not fail the whole runtime start.
    await writeServerEndpoint(candidate).catch((error) => {
      console.error('[opencode] could not write the server endpoint file', error)
    })
    return candidate
  } catch (error) {
    if (!signal.aborted) await stopOpenCodeServerViaPty().catch(() => undefined)
    throw error
  }
}

async function ensureOpenCodeRuntime(): Promise<RunningOpenCode> {
  return lifecycle.ensure(startOpenCodeRuntime)
}

export async function getOpenCodeClient(directory?: string): Promise<OpencodeClient> {
  const runtime = await ensureOpenCodeRuntime()
  return createOpencodeClient({
    baseUrl: runtime.baseUrl,
    directory,
    headers: { Authorization: basicAuth(runtime.password) },
    throwOnError: true
  })
}

export async function getOpenCodeTerminalRuntime(): Promise<{
  distro: string
  baseUrl: string
  password: string
}> {
  const runtime = await ensureOpenCodeRuntime()
  return { distro: runtime.distro, baseUrl: runtime.baseUrl, password: runtime.password }
}

export async function stopOpenCodeRuntime(): Promise<void> {
  const previous = running
  await lifecycle.stop(async () => {
    running = null
    await stopOpenCodeServerViaPty()
  })
  // Remove the stale endpoint so a terminal launched after an intentional stop
  // fails with a clear message instead of attaching to a dead port. A later
  // (re)start republishes it.
  if (previous) await removeServerEndpoint(previous)
}

export function windowsPathToWsl(path: string): string {
  const match = /^([a-zA-Z]):[\\/](.*)$/.exec(path)
  if (!match) return path.replace(/\\/g, '/')
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`
}

export function wslPathToWindows(path: string): string | null {
  const match = /^\/mnt\/([a-zA-Z])(?:\/(.*))?$/.exec(path)
  if (!match) return null
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').replace(/\//g, '\\')}`
}
