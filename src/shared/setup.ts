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
  detail?: string | null
}

export type SetupStatus = Record<PlatformId, PlatformSetup>

// Onboarding actions: install the CLI or sign in. Both supported providers run
// natively and own their own configuration, so Cadence applies none of its own.
export type SetupAction = 'install' | 'connect'

// A command the onboarding runs in an embedded terminal for a platform/action,
// plus the plain-language label shown while it runs.
export type SetupCommand = {
  command: string
  label: string
}

// Git is a prerequisite for importing a repository, NOT a platform — deliberately
// outside PlatformId and SetupStatus so no platform-keyed surface inherits it.
// Unlike the Node runtime it is not bundled, so it has to be detected and offered.
export type GitSetup = {
  installed: boolean
  version: string | null
  installCommand: SetupCommand
}
