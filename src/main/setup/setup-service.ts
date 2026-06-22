import { app } from 'electron'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PlatformId } from '@shared/platform'
import type { PlatformSetup, SetupAction, SetupCommand, SetupStatus } from '@shared/setup'

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

// "Connected" mirrors the credential files the usage services already read:
// Claude's OAuth access token, Codex's auth token.
async function claudeConnected(): Promise<boolean> {
  const path = join(app.getPath('home'), '.claude', '.credentials.json')
  return (
    (await readJsonField(path, (data) =>
      nonEmptyString((data as { claudeAiOauth?: { accessToken?: unknown } })?.claudeAiOauth?.accessToken)
    )) ?? false
  )
}

async function codexConnected(): Promise<boolean> {
  const path = join(app.getPath('home'), '.codex', 'auth.json')
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

export function getSetupCommand(platform: PlatformId, action: SetupAction): SetupCommand {
  return COMMANDS[platform][action]
}
