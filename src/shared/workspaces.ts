// A workspace is a folder the user has attached as a project. It is platform
// agnostic (the same folder can host both Claude and Codex sessions) and is
// persisted so it shows up in the project list even before any session exists.
export type Workspace = {
  id: string
  path: string
  name: string
  addedAtMs: number
}
