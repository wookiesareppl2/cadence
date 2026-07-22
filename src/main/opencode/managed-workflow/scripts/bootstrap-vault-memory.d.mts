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

export declare function bootstrap(options: {
  workspace: string
  memory: string
  project?: string
  today: string
  dryRun?: boolean
}): { created: string[]; archived: number; marker: boolean; log: string[] }
