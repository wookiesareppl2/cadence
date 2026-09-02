// How Cadence invokes each AI CLI: starting one, resuming a recorded session, and
// the mode that bypasses every permission check.
//
// These three facts are recorded here once because they were previously spread
// across the UI — the terminal deck's launch buttons knew the skip flags, App.tsx
// separately knew the resume commands — and neither knew about the other. Adding
// "resume with the skip mode" needed both at once, which is the point at which two
// copies become one that drifts. Dependency-free (no node:*, no electron, no React)
// so it is safe anywhere and trivially unit-testable.

import { PLATFORM_CONFIG, type PlatformId } from './platform'

type AiLaunch = {
  // The executable, exactly as typed at a shell prompt.
  base: string
  // Resume a recorded session by id. Claude takes a flag, Codex a subcommand, so
  // this is per-CLI rather than a shared template.
  resumeArgs: (sessionId: string) => string
  // Bypass every permission check. Both CLIs accept this alongside their resume
  // form (verified against `claude --help` and `codex resume --help`).
  skipFlag: string
  // What this CLI calls that mode. Claude says "skip permissions", Codex says
  // "yolo"; the UI uses each CLI's own word rather than inventing a house term,
  // because the word is what the user will search that CLI's docs for.
  skipModeName: string
}

const AI_LAUNCH: Record<PlatformId, AiLaunch> = {
  claude: {
    base: 'claude',
    resumeArgs: (sessionId) => `--resume ${sessionId}`,
    skipFlag: '--dangerously-skip-permissions',
    skipModeName: 'skip perms'
  },
  codex: {
    base: 'codex',
    resumeArgs: (sessionId) => `resume ${sessionId}`,
    skipFlag: '--dangerously-bypass-approvals-and-sandbox',
    skipModeName: 'yolo'
  }
}

// Start a fresh session.
export function launchCommand(platform: PlatformId, skipPermissions = false): string {
  const cli = AI_LAUNCH[platform]
  return skipPermissions ? `${cli.base} ${cli.skipFlag}` : cli.base
}

// Rejoin a recorded session by its real id. Never bind a fresh shell to a
// historical id directly — the CLI's own resume is what keeps new work filed under
// the right session.
export function resumeCommand(platform: PlatformId, sessionId: string, skipPermissions = false): string {
  const cli = AI_LAUNCH[platform]
  const command = `${cli.base} ${cli.resumeArgs(sessionId)}`
  return skipPermissions ? `${command} ${cli.skipFlag}` : command
}

export function skipModeName(platform: PlatformId): string {
  return AI_LAUNCH[platform].skipModeName
}

export function launchLabel(platform: PlatformId): string {
  return `Launch ${PLATFORM_CONFIG[platform].shortLabel}`
}

export function launchSkipLabel(platform: PlatformId): string {
  return `${PLATFORM_CONFIG[platform].shortLabel} (${skipModeName(platform)})`
}

export function resumeSkipLabel(platform: PlatformId): string {
  return `Resume (${skipModeName(platform)})`
}
