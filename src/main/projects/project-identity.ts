import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

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

export function canonicalProjectPath(path: string): string {
  const candidate = legacyCadenceSiblingPath(path)
  if (!candidate) return path
  return existsSync(candidate) && hasCadencePackage(candidate) ? candidate : path
}
