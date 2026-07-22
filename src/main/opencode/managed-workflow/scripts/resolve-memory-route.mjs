#!/usr/bin/env node
// Resolve which memory home a project's /start and /save must use.
//
// This decision is the highest-risk step in either skill: routing a vault
// project to its frozen `.claude/` bank writes the session's memory somewhere
// it will never be read from again, and routing a project to an ANCESTOR's
// memory home writes one project's memory into another project's vault.
//
// It lives here, as a script, rather than inline in the skills, because it was
// twice shipped as prose-embedded shell and twice found to misroute on
// well-formed input. As a script it is unit-testable directly, cannot drift
// between the start and save copies, and does not depend on the model
// reproducing it faithfully.
//
// Output is line-oriented KEY=value on stdout:
//   MEMORY_ROUTE=vault|legacy-bank|legacy-root|abort
//   MEMORY_HOME=<path>            (absent when MEMORY_ROUTE=abort)
//   WORKSPACE_ROOT=<path>
//   REASON=<text>                 (only when MEMORY_ROUTE=abort)

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const MARKER_PHRASE = 'Felix memory home'

// Files that identify a directory as a project in its own right. The walk stops
// at the first one found. `.claude/HANDOFF.md` and `HANDOFF.md` matter as much
// as `CLAUDE.md`: a legacy project has no `CLAUDE.md`, and without them it
// climbs out of itself and adopts an ancestor's route.
export const PROJECT_IDENTITY_FILES = [
  'CLAUDE.md',
  join('.claude', 'CLAUDE.md'),
  join('.claude', 'HANDOFF.md'),
  'HANDOFF.md'
]

/**
 * Remove fenced code blocks so a documented example marker is not mistaken for
 * live configuration. Handles both backtick and tilde fences, and reports when
 * a fence was left open — in which case everything below it was discarded and
 * the result cannot be trusted.
 */
export function stripFences(text) {
  const out = []
  let fence = null
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(`{3,}|~{3,})/)
    if (match) {
      const char = match[1][0]
      const length = match[1].length
      if (!fence) {
        fence = { char, length }
      } else if (char === fence.char && length >= fence.length) {
        fence = null
      }
      continue
    }
    if (!fence) out.push(line)
  }
  return { stripped: out.join('\n'), unbalanced: fence !== null }
}

/**
 * A marker declares a path, so it carries a `WSL:` or `Windows:` label. Prose
 * that merely mentions the phrase ("we have not set up a Felix memory home
 * yet") does not, and must not be treated as a malformed marker — doing so
 * aborts and makes both skills permanently unusable for that project.
 */
export function isMarkerShaped(line) {
  return /WSL:/i.test(line) || /Windows:/i.test(line)
}

export function findMarkerLines(text) {
  return text
    .split('\n')
    .filter((line) => line.includes(MARKER_PHRASE) && isMarkerShaped(line))
}

/**
 * Marker-shaped but not an exact match — a reworded or corrupted marker. Worth
 * aborting over, because falling through to a legacy bank is exactly the
 * data-loss this resolver exists to prevent. Requires a `WSL:` label so that
 * prose merely mentioning the phrase does not brick the project.
 */
export function findNearMissLines(text) {
  return text
    .split('\n')
    .filter(
      (line) =>
        !line.includes(MARKER_PHRASE) &&
        /felix memory home/i.test(line) &&
        isMarkerShaped(line)
    )
}

/** Take the path after the `WSL:` label — never merely the first quoted path. */
export function extractWslPath(line) {
  const match = line.match(/WSL:\s*`([^`]+)`/)
  return match ? match[1] : null
}

/**
 * A marker declares the same memory home twice, once per platform. Return both,
 * WSL first: OpenCode runs under WSL, but the resolver must also work when run
 * on Windows, and picking a form that does not resolve on the current platform
 * would abort on a perfectly valid marker.
 */
export function extractMarkerPaths(line) {
  const wsl = extractWslPath(line)
  const windows = line.match(/Windows:\s*`([^`]+)`/)
  return [wsl, windows ? windows[1] : null].filter(Boolean)
}

/**
 * Walk upward for the project's own root.
 *
 * A directory carrying any identity file is a project and the walk stops there
 * — including a legacy project whose only identity is `.claude/HANDOFF.md`.
 * That is what stops one project climbing out of itself and adopting a
 * different project's memory home.
 *
 * Two bounds keep the walk honest:
 *  - it never goes above the git top level when inside a repository;
 *  - it never accepts the user's HOME as a project root. `~/.claude/CLAUDE.md`
 *    is the global agent adapter, not a project, and adopting it would route
 *    every unmarked directory under HOME at the home directory itself.
 *
 * A directory with no identity file is treated as a subdirectory of the nearest
 * enclosing project, which is what it almost always is.
 */
export function findProjectRoot(startDir, { gitTopLevel, homeDir, hasIdentity } = {}) {
  const start = resolve(startDir)
  const home = homeDir ? resolve(homeDir) : null
  const top = gitTopLevel ? resolve(gitTopLevel) : null
  let current = start
  for (;;) {
    if (home && current === home) break
    if (hasIdentity(current)) return current
    if (top && current === top) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

export function resolveRoute({ root, readFileSafe, isDirectory, fileExists }) {
  let raw = ''
  let stripped = ''
  let unbalanced = false

  for (const relative of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
    const text = readFileSafe(join(root, relative))
    if (text === null) continue
    raw += text + '\n'
    const result = stripFences(text)
    stripped += result.stripped + '\n'
    if (result.unbalanced) unbalanced = true
  }

  const candidates = findMarkerLines(stripped)
  const unresolved = []
  for (const line of candidates) {
    const paths = extractMarkerPaths(line)
    if (!paths.length) {
      unresolved.push('<no WSL: or Windows: path on marker line>')
      continue
    }
    const found = paths.find((candidate) => isDirectory(candidate))
    if (found) return { route: 'vault', home: found }
    unresolved.push(paths.join(' | '))
  }

  if (candidates.length > 0) {
    return {
      route: 'abort',
      reason:
        `vault marker found but no memory home resolved (tried: ${unresolved.join(', ')}). ` +
        'Fix the WSL path in the project CLAUDE.md marker, or create that directory.'
    }
  }

  // A fence left open swallowed everything below it — possibly the real marker.
  if (unbalanced && findMarkerLines(raw).length > 0) {
    return {
      route: 'abort',
      reason:
        'a vault marker exists but sits below an unclosed code fence in the project baseline, ' +
        'so it could not be read. Close the fence in CLAUDE.md.'
    }
  }

  if (findNearMissLines(stripped).length > 0) {
    return {
      route: 'abort',
      reason:
        'marker-like text found but it does not match the expected format, so the memory home is ' +
        'unknown. Refusing to fall back to a legacy bank. Restore the marker line to the exact form: ' +
        'Felix memory home — Windows: `<win path>` · WSL: `<wsl path>`'
    }
  }

  if (fileExists(join(root, '.claude', 'HANDOFF.md'))) {
    return { route: 'legacy-bank', home: join(root, '.claude') }
  }
  return { route: 'legacy-root', home: root }
}

/**
 * Locate the vault root by reading the global agent adapter, which declares it.
 * Used only to PROPOSE where an unmigrated project's memory should live; it is
 * never used to pick an existing memory home, so it cannot cause a project to
 * adopt another project's vault.
 */
export function findBrainRoot({ candidates, readFileSafe: read, isDirectory: isDir, fileExists: isFile }) {
  for (const candidate of candidates) {
    const text = read(candidate)
    if (!text) continue
    const match = text.match(/canonical Brain is:?\s*\n+\s*`([^`]+)`/i)
    if (!match) continue
    // Accept the declared path in whichever form resolves on this platform, and
    // require VAULT-INDEX.md as proof it really is the vault root rather than a
    // stale or partially-synced directory.
    for (const form of [match[1], toWslPath(match[1])]) {
      if (isDir(form) && isFile(join(form, 'VAULT-INDEX.md'))) return form
    }
  }
  return null
}

export function toWslPath(p) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!match) return p
  return `/mnt/${match[1].toLowerCase()}/${match[2].split('\\').join('/')}`
}

export const DEFAULT_VAULT_CATEGORY = '04 - Personal Projects'

/** Where an unmigrated project's memory home should be created. */
export function proposeMemoryHome(brainRoot, projectName, category = DEFAULT_VAULT_CATEGORY) {
  if (!brainRoot || !projectName) return null
  return join(brainRoot, category, projectName, 'memory')
}

function readFileSafe(path) {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileExists(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function gitTopLevel(cwd) {
  try {
    // Resolved without spawning git: walk up for a .git entry.
    let current = resolve(cwd)
    for (;;) {
      if (existsSync(join(current, '.git'))) return current
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  } catch {
    return null
  }
}

export function main(cwd = process.cwd()) {
  const root = findProjectRoot(cwd, {
    gitTopLevel: gitTopLevel(cwd),
    homeDir: process.env.HOME || process.env.USERPROFILE || null,
    hasIdentity: (dir) => PROJECT_IDENTITY_FILES.some((f) => fileExists(join(dir, f)))
  })
  const result = resolveRoute({ root, readFileSafe, isDirectory, fileExists })
  const lines = [`MEMORY_ROUTE=${result.route}`]
  if (result.home) lines.push(`MEMORY_HOME=${result.home}`)
  lines.push(`WORKSPACE_ROOT=${root}`)
  if (result.reason) lines.push(`REASON=${result.reason}`)

  // A project without a vault memory home is not an error and never a reason to
  // write into a legacy bank — it just has not been set up yet. Propose where it
  // should live so a first save can create it, exactly as a first save on a new
  // project has always created the memory system.
  if (result.route === 'legacy-bank' || result.route === 'legacy-root') {
    // Discover the adapter from the environment only. No machine-specific path
    // is hardcoded: this script ships to every install, and a path naming one
    // developer's account would be dead weight everywhere else. If no adapter is
    // found the proposal degrades to "unknown", which asks rather than guesses.
    const candidates = []
    for (const base of [process.env.HOME, process.env.USERPROFILE]) {
      if (!base) continue
      candidates.push(join(base, '.claude', 'CLAUDE.md'), join(base, '.codex', 'AGENTS.md'))
    }
    const brain = findBrainRoot({ candidates, readFileSafe, isDirectory, fileExists })
    const proposed = proposeMemoryHome(brain, basename(root))
    lines.push('BOOTSTRAP=required')
    if (proposed) lines.push(`PROPOSED_MEMORY_HOME=${proposed}`)
    else lines.push('PROPOSED_MEMORY_HOME=unknown (vault root not found; ask before creating one)')
    if (result.route === 'legacy-bank') {
      lines.push('LEGACY_BANK_PRESENT=true (archive it during bootstrap; never write to it)')
    }
  }
  return lines.join('\n')
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]).endsWith('resolve-memory-route.mjs')
if (invokedDirectly) {
  process.stdout.write(main() + '\n')
}
