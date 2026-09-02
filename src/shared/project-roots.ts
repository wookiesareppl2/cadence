// Project root folders: the directories a user's projects actually live inside.
//
// Cadence discovers a "project" from every folder an AI CLI has ever run in, which
// means a stray `cd` into a temp directory becomes a permanent entry in the Projects
// list. Naming the parent folders instead lets the app answer two questions from one
// piece of configuration: which discovered folders are projects at all, and which
// folder a session run three levels deep actually belongs to.
//
// Dependency-free (no node:*, no electron) so both processes share one answer, and
// so the path arithmetic is unit-testable without a filesystem.

export type ProjectRoot = {
  id: string // stable key: the normalized origin + path
  path: string // native Windows path, or a POSIX path when `distro` is set
  distro: string | null // WSL distro name; null for Windows
  label: string // display name, defaults to the folder's own name
}

// A path's parts, keeping whatever leading separator run it had so the rebuilt path
// is the same shape as the one that came in: a drive path, a POSIX path, a UNC share.
function splitPath(path: string): { prefix: string; segments: string[] } {
  const prefix = /^[\\/]*/.exec(path)?.[0] ?? ''
  return {
    prefix,
    segments: path
      .slice(prefix.length)
      .split(/[\\/]+/)
      .filter(Boolean)
  }
}

function joinPath(prefix: string, segments: string[], distro: string | null): string {
  const separator = distro ? '/' : '\\'
  return prefix.replace(/[\\/]/g, separator) + segments.join(separator)
}

// Windows paths are compared case-insensitively; WSL paths are not, because a Linux
// filesystem genuinely distinguishes `Code` from `code` and folding them would merge
// two real projects into one.
function comparable(segment: string, distro: string | null): string {
  return distro ? segment : segment.toLowerCase()
}

function sameOrigin(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return a.toLowerCase() === b.toLowerCase()
}

function isUnder(pathSegments: string[], rootSegments: string[], distro: string | null): boolean {
  // A root with no segments is that origin's own root — `/` for a WSL distro, a bare
  // separator on Windows — and everything in the origin is under it. Rejecting it
  // was silently catastrophic: picking the distro node itself, which the picker's
  // own wording invites, stored a root that matched nothing, and because ANY root
  // switches filtering on, the entire Projects list emptied with nothing on screen
  // to say why.
  if (pathSegments.length < rootSegments.length) return false
  return rootSegments.every(
    (segment, index) => comparable(pathSegments[index], distro) === comparable(segment, distro)
  )
}

export function projectRootId(path: string, distro: string | null): string {
  const { prefix, segments } = splitPath(path)
  const normalized = joinPath(prefix, segments.map((segment) => comparable(segment, distro)), distro)
  return `${distro ? `wsl:${distro.toLowerCase()}` : 'windows'}:${normalized}`
}

export function projectRootLabel(path: string): string {
  const { segments } = splitPath(path)
  return segments[segments.length - 1] || path
}

// Whether a root names a real location.
//
// `/` is a genuine WSL root: the distro's filesystem root, and every project in it
// sits below. A bare Windows separator is not the same thing — it is drive-RELATIVE,
// so a path rolled up against it comes back as just a drive prefix, which `resolve()`
// then interprets against the process working directory. Every Windows project would
// collapse to a single id that moves when the working directory does. Unreachable
// through the folder picker, which always returns a drive-qualified path, but a
// hand-edited settings file can produce it and the failure is silent.
export function isUsableProjectRoot(root: ProjectRoot): boolean {
  if (root.distro) return true
  return splitPath(root.path).segments.length > 0
}

export function makeProjectRoot(path: string, distro: string | null, label?: string): ProjectRoot {
  const { prefix, segments } = splitPath(path)
  const clean = joinPath(prefix, segments, distro)
  return {
    id: projectRootId(clean, distro),
    path: clean,
    distro,
    label: label?.trim() || projectRootLabel(clean)
  }
}

// The project folder a session's working directory belongs to, or null when it is
// outside every configured root.
//
// A project is a folder directly inside a root, so a session run at any depth below
// it rolls up to that folder — the same rule the agent-metadata strip already applies
// for a cwd inside `.claude`, and for the same reason: a folder has exactly one
// project. A session run in the root itself has nowhere to roll up to, so the root is
// its own project rather than being discarded.
//
// With no roots configured this returns the path unchanged, so an unconfigured app
// behaves exactly as it did before and never presents an empty Projects list.
export function rollUpToProjectFolder(
  path: string,
  distro: string | null,
  roots: ProjectRoot[]
): string | null {
  if (roots.length === 0) return path
  const { prefix, segments } = splitPath(path)

  let best: string[] | null = null
  for (const root of roots) {
    if (!sameOrigin(root.distro, distro)) continue
    const rootSegments = splitPath(root.path).segments
    if (!isUnder(segments, rootSegments, distro)) continue
    // Most specific root wins, so nesting one root inside another resolves against
    // the one the user meant rather than whichever happened to be added first.
    if (!best || rootSegments.length > best.length) best = rootSegments
  }
  if (!best) return null

  return joinPath(prefix, segments.slice(0, Math.min(best.length + 1, segments.length)), distro)
}

export function isInsideProjectRoots(
  path: string,
  distro: string | null,
  roots: ProjectRoot[]
): boolean {
  return rollUpToProjectFolder(path, distro, roots) !== null
}

// A folder picked through the Windows dialog can land on a WSL distro's 9P share.
// Recognising that is what lets one "Add folder" button serve both origins: the share
// path is turned back into the distro + POSIX path the rest of the app uses. The
// inverse of `toNativeRoot` in project-files.
export function parseWslSharePath(nativePath: string): { distro: string; posixPath: string } | null {
  const match = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]+([^\\/]+)(.*)$/i.exec(
    nativePath.trim()
  )
  if (!match) return null
  const distro = match[1]
  // `.` and `..` are path navigation, not distro names; a root built from one could
  // never match anything and would sit in Settings looking configured.
  if (distro === '.' || distro === '..') return null
  const { segments } = splitPath(match[2] ?? '')
  return { distro, posixPath: `/${segments.join('/')}` }
}

// Whether a discovered project belongs in the Projects list.
//
// Two exemptions, both deliberate. A project with no resolvable folder cannot be
// judged against a root, so it stays rather than vanishing for a reason the user
// cannot see or fix. A hand-attached folder stays because attaching one is an
// explicit act — and attaching a folder outside the usual tree is precisely why
// anyone attaches a folder, so it is the case a roots filter would most often get
// wrong.
//
// Shared so the main-process catalog and the renderer's session-derived list decide
// this the same way. They are separate lists that merge, and a project the renderer
// drops but the catalog keeps comes back with its sessions stripped: still listed,
// its history gone.
export function isProjectListed(
  path: string | null,
  distro: string | null,
  isAttached: boolean,
  roots: ProjectRoot[]
): boolean {
  if (!path) return true
  if (isAttached) return true
  return isInsideProjectRoots(path, distro, roots)
}
