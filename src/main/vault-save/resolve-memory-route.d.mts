// Types for the shipped memory-route resolver. This declaration exists so the
// test suite can drive the resolver directly; only the .mjs is delivered as a
// managed workflow file.

export declare const MARKER_PHRASE: string
export declare const PROJECT_IDENTITY_FILES: readonly string[]

export declare function stripFences(text: string): { stripped: string; unbalanced: boolean }
export declare function isMarkerShaped(line: string): boolean
export declare function findMarkerLines(text: string): string[]
export declare function findNearMissLines(text: string): string[]
export declare function extractWslPath(line: string): string | null
export declare function extractMarkerPaths(line: string): string[]

export type MarkerPathOptions = {
  env?: Record<string, string | undefined>
  /** Directory names under `path`; returns [] rather than throwing. */
  listDirectory?: (path: string) => string[]
}

/** Null when the path names an environment variable that is not set. */
export declare function expandMarkerPath(
  p: string | null,
  env?: Record<string, string | undefined>
): string | null

export declare function rehomeMarkerPaths(p: string | null, options?: MarkerPathOptions): string[]

/** Recorded form first, then expanded, then re-homed; de-duplicated. */
export declare function markerPathCandidates(p: string, options?: MarkerPathOptions): string[]

export declare function findProjectRoot(
  startDir: string,
  options: {
    gitTopLevel?: string | null
    homeDir?: string | null
    hasIdentity: (dir: string) => boolean
  }
): string

export type MemoryRoute = 'vault' | 'legacy-bank' | 'legacy-root' | 'abort'

export declare function resolveRoute(options: {
  root: string
  readFileSafe: (path: string) => string | null
  isDirectory: (path: string) => boolean
  fileExists: (path: string) => boolean
  env?: Record<string, string | undefined>
  listDirectory?: (path: string) => string[]
}): { route: MemoryRoute; home?: string; reason?: string }

export declare function findBrainRoot(options: {
  candidates: string[]
  readFileSafe: (path: string) => string | null
  isDirectory: (path: string) => boolean
  fileExists: (path: string) => boolean
}): string | null

export declare function toWslPath(p: string): string

/**
 * The vault's top-level areas, read live. There is deliberately no default area
 * — see the .mjs for why a constant here is always wrong eventually.
 */
export declare function listVaultAreas(
  brainRoot: string | null,
  options?: {
    readdir?: (dir: string) => string[]
    isDirectory?: (path: string) => boolean
  }
): string[]

/** `category` is REQUIRED: callers must ask rather than fall back to a default. */
export declare function proposeMemoryHome(
  brainRoot: string | null,
  projectName: string | null,
  category: string | undefined
): string | null

export declare function main(cwd?: string): string
