import type { PlatformId } from './platform'

// Per-platform setup state surfaced to the first-run onboarding screen.
export type PlatformSetup = {
  // The provider CLI resolves in its required host environment.
  installed: boolean
  // First line of `<cli> --version`, when installed.
  version: string | null
  compatible?: boolean
  // The CLI is signed in (its credential file holds a token the app can read).
  connected: boolean
  // Authentication can be complete before a managed provider profile is configured.
  authenticated?: boolean
  // OpenCode runs in WSL on Windows. Other platforms leave these fields unset.
  runtime?: 'native' | 'wsl' | null
  wslDistro?: string | null
  availableWslDistros?: string[]
  configured?: boolean
  detail?: string | null
}

export type SetupStatus = Record<PlatformId, PlatformSetup>

// Onboarding actions: install the CLI, sign in, or apply Cadence-managed routing.
export type SetupAction = 'install' | 'connect' | 'configure'

// A command the onboarding runs in an embedded terminal for a platform/action,
// plus the plain-language label shown while it runs.
export type SetupCommand = {
  command: string
  label: string
  wslDistro?: string | null
}
