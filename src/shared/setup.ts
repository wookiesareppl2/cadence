import type { PlatformId } from './platform'

// Per-platform setup state surfaced to the first-run onboarding screen.
export type PlatformSetup = {
  // The CLI (`claude` / `codex`) resolves on PATH.
  installed: boolean
  // First line of `<cli> --version`, when installed.
  version: string | null
  // The CLI is signed in (its credential file holds a token the app can read).
  connected: boolean
}

export type SetupStatus = Record<PlatformId, PlatformSetup>

// Onboarding actions: install the CLI, or sign in to it.
export type SetupAction = 'install' | 'connect'

// A command the onboarding runs in an embedded terminal for a platform/action,
// plus the plain-language label shown while it runs.
export type SetupCommand = {
  command: string
  label: string
}
