import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PlatformId } from '@shared/platform'
import type { GitSetup, PlatformSetup, SetupAction, SetupCommand, SetupStatus } from '@shared/setup'

// Drives the first-run onboarding: detect whether each CLI is installed and signed
// in, and hand the renderer the official command to run for install / sign-in. The
// app stays a companion to the Claude Code and Codex CLIs (see the portability
// plan) — it never reimplements their auth, it just detects and launches them.

const execFileAsync = promisify(execFile)
const VERSION_TIMEOUT_MS = 6_000

// `<cli> --version` resolves the binary on PATH and confirms it's installed. On
// Windows the CLIs may be `.cmd`/`.ps1` shims, so run through the shell so PATHEXT
// resolution applies. A non-zero exit / missing binary throws → not installed.
async function detectVersion(cli: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cli, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
      shell: process.platform === 'win32'
    })
    const firstLine = stdout.trim().split(/\r?\n/)[0]?.trim()
    return firstLine && firstLine.length > 0 ? firstLine : null
  } catch {
    return null
  }
}

async function readJsonField<T>(path: string, pick: (data: unknown) => T): Promise<T | null> {
  try {
    return pick(JSON.parse(await readFile(path, 'utf-8')))
  } catch {
    return null
  }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0
}

// The credential file each CLI writes on sign-in; the usage services read the same
// files. Disconnecting trashes the file (recoverable) the way the CLIs' own logout
// just clears local credentials.
function credentialPath(platform: PlatformId): string {
  return platform === 'claude'
    ? join(app.getPath('home'), '.claude', '.credentials.json')
    : join(app.getPath('home'), '.codex', 'auth.json')
}

// "Connected" mirrors the credential files the usage services already read:
// Claude's OAuth access token, Codex's auth token.
async function claudeConnected(): Promise<boolean> {
  const path = credentialPath('claude')
  return (
    (await readJsonField(path, (data) =>
      nonEmptyString((data as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken)
    )) ?? false
  )
}

async function codexConnected(): Promise<boolean> {
  const path = credentialPath('codex')
  return (
    (await readJsonField(path, (data) =>
      nonEmptyString((data as { tokens?: { access_token?: unknown } })?.tokens?.access_token)
    )) ?? false
  )
}

async function platformSetup(cli: string, connected: () => Promise<boolean>): Promise<PlatformSetup> {
  const version = await detectVersion(cli)
  return {
    installed: version !== null,
    version,
    // Only worth a credential check once the CLI exists.
    connected: version !== null ? await connected() : false
  }
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const [claude, codex] = await Promise.all([
    platformSetup('claude', claudeConnected),
    platformSetup('codex', codexConnected)
  ])
  return { claude, codex }
}

// Official commands, run in the onboarding's embedded terminal so the user can see
// progress and complete the browser sign-in. Windows-only today (the install
// scripts are the native PowerShell installers — no Node required for the CLIs).
const COMMANDS: Record<PlatformId, Record<SetupAction, SetupCommand>> = {
  claude: {
    install: { command: 'irm https://claude.ai/install.ps1 | iex', label: 'Installing Claude Code…' },
    connect: { command: 'claude /login', label: 'Signing in to Claude…' }
  },
  codex: {
    install: { command: 'iwr -useb https://cli.codex.openai.com/install.ps1 | iex', label: 'Installing Codex…' },
    connect: { command: 'codex login', label: 'Signing in to Codex…' }
  }
}

export async function getSetupCommand(platform: PlatformId, action: SetupAction): Promise<SetupCommand> {
  return COMMANDS[platform][action]
}

// Git is a prerequisite, not a platform: nothing in Cadence signs in to it, and it
// backs one feature (importing a repository) rather than a provider. Keeping it out
// of PLATFORM_CONFIG is deliberate — a third card in the platform row would read as
// a third assistant, and every platform-keyed surface in the app would inherit it.
//
// It is detected because it is NOT bundled, unlike the Node runtime. On a clean
// Windows PC the import path failed with a raw `spawn git ENOENT` surfaced through
// a generic message, which tells a non-technical user nothing about what to install.
export const GIT_INSTALL_COMMAND: SetupCommand = {
  command: 'winget install --id Git.Git -e --source winget',
  label: 'Installing Git…'
}

export async function getGitStatus(): Promise<GitSetup> {
  const version = await detectVersion('git')
  return { installed: version !== null, version, installCommand: GIT_INSTALL_COMMAND }
}

// Disconnect = local credential cleanup (the CLIs' own logout does only this). Send
// the credential file to the OS trash so it's recoverable; the next status check
// then reports the platform disconnected. A missing file already counts as done.
export async function disconnectPlatform(platform: PlatformId): Promise<{ ok: boolean }> {
  const path = credentialPath(platform)
  if (!existsSync(path)) return { ok: true }
  try {
    await shell.trashItem(path)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
