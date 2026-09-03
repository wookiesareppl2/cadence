import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { rollUpToProjectFolder, type ProjectRoot } from '@shared/project-roots'

const LEGACY_CADENCE_DIR = 'ai-dashboard'
const CADENCE_DIR = 'cadence'
const CADENCE_PACKAGE_NAME = 'cadence'

function withoutTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

function isLegacyCadenceDir(path: string): boolean {
  return basename(withoutTrailingSeparators(path)).toLowerCase() === LEGACY_CADENCE_DIR
}

function hasCadencePackage(candidate: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf-8')) as { name?: unknown }
    return pkg.name === CADENCE_PACKAGE_NAME
  } catch {
    return false
  }
}

export function legacyCadenceSiblingPath(path: string): string | null {
  const clean = withoutTrailingSeparators(path)
  if (!isLegacyCadenceDir(clean)) return null
  return join(dirname(clean), CADENCE_DIR)
}

// `.claude` and `.codex` are agent metadata folders that live INSIDE a project,
// never standalone projects. A session occasionally records a cwd at or under one
// (e.g. a tool that stepped into `.claude` during a skill run), which would
// otherwise group the session under a bogus sibling project named `.claude`. A
// folder has exactly one project, so attribute any such cwd to the parent project
// folder. Handles both `\` (Windows) and `/` (WSL) paths.
export function stripAgentMetadataDir(path: string): string {
  const stripped = path.replace(/[\\/]\.(?:claude|codex)(?:[\\/][^\\/]*)*[\\/]?$/i, '')
  return stripped || path
}

export function canonicalProjectPath(path: string): string {
  const candidate = legacyCadenceSiblingPath(path)
  if (!candidate) return path
  return existsSync(candidate) && hasCadencePackage(candidate) ? candidate : path
}

// The configured project roots, held as a module snapshot rather than threaded
// through every caller.
//
// `canonicalSessionCwd` is reached from about ten places in the session scanner,
// several of which have no origin in hand. Adding a parameter to each is the shape
// of change this codebase has already been bitten by: miss one call site and the
// same folder produces two different project ids depending on which path built it,
// silently splitting a project in two. A single snapshot cannot disagree with
// itself that way.
//
// Set by the settings layer at startup and on every change, which also clears the
// session cache so ids are recomputed against the new roots.
let configuredRoots: ProjectRoot[] = []

export function setProjectRoots(roots: ProjectRoot[]): void {
  configuredRoots = roots
}

export function getProjectRoots(): ProjectRoot[] {
  return configuredRoots
}

// The project folder a working directory belongs to, or null when it sits outside
// every configured root. With no roots configured every path maps to itself, so an
// unconfigured app is unchanged.
export function projectFolderForCwd(path: string, distro: string | null): string | null {
  return rollUpToProjectFolder(path, distro, configuredRoots)
}
