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
}): { route: MemoryRoute; home?: string; reason?: string }

export declare function main(cwd?: string): string
