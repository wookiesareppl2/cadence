// Types for the shipped vault bootstrap. This declaration exists so the test
// suite can drive it directly; only the .mjs is delivered as a managed file.

export declare function toWindowsPath(p: string): string
export declare function toWslPath(p: string): string
export declare function markerLine(memoryDir: string): string
export declare function skeletonFiles(project: string, today: string): Record<string, string>

export declare function targetIsOccupied(
  memoryDir: string,
  readdir?: (dir: string) => string[],
  exists?: (path: string) => boolean
): boolean

/**
 * Home-relative (`~/…`) when the path is under the user's home, so the import
 * resolves whatever the account is called. Throws on a path containing a
 * newline, which cannot be escaped onto one line.
 */
export declare function toClaudeImportPath(
  p: string,
  env?: Record<string, string | undefined>
): string

/** The three `@`-prefixed import lines that load the hot layer, newline-joined. */
export declare function hotLayerImportLines(
  memoryDir: string,
  env?: Record<string, string | undefined>
): string

export declare function bootstrap(options: {
  workspace: string
  memory: string
  project?: string
  today: string
  dryRun?: boolean
}): {
  created: string[]
  archived: number
  marker: boolean
  imports: number
  validated: boolean
  log: string[]
}
