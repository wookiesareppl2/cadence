import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry, FileKind, FileOpResult, FileRequest } from '@shared/project-files'

function parentRelPath(relPath: string): string {
  const index = relPath.lastIndexOf('/')
  return index === -1 ? '' : relPath.slice(0, index)
}

export type FileTreeState = {
  rootError: string | null
  childrenOf: (relPath: string) => FileEntry[] | undefined
  isExpanded: (relPath: string) => boolean
  isLoading: (relPath: string) => boolean
  isTruncated: (relPath: string) => boolean
  selected: string | null
  toggleDir: (relPath: string) => void
  select: (relPath: string) => void
  refresh: (relPath: string) => void
  rename: (relPath: string, newName: string) => Promise<FileOpResult>
  remove: (relPath: string) => Promise<FileOpResult>
  create: (parentRel: string, name: string, kind: FileKind) => Promise<FileOpResult>
  reveal: (relPath: string) => void
  openExternally: (relPath: string) => Promise<FileOpResult>
}

export function useProjectFileTree(rootPath: string | null, distro: string | null, projectId: string | null): FileTreeState {
  const [children, setChildren] = useState<Map<string, FileEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [truncated, setTruncated] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)

  const childrenRef = useRef(children)
  childrenRef.current = children
  // Bumped whenever the project changes; in-flight loads from a prior project are
  // discarded so they can't write stale children into the new tree.
  const epochRef = useRef(0)

  const request = useCallback(
    (relPath: string): FileRequest => ({ rootPath: rootPath ?? '', distro, relPath }),
    [rootPath, distro]
  )

  const loadDir = useCallback(
    async (relPath: string, force = false): Promise<void> => {
      if (!rootPath) return
      if (!force && childrenRef.current.has(relPath)) return
      const epoch = epochRef.current
      setLoading((prev) => new Set(prev).add(relPath))
      try {
        const listing = await window.dashboard?.projectFiles?.list(request(relPath))
        if (epoch !== epochRef.current || !listing) return
        setChildren((prev) => new Map(prev).set(relPath, listing.entries))
        setTruncated((prev) => {
          const next = new Set(prev)
          if (listing.truncated) next.add(relPath)
          else next.delete(relPath)
          return next
        })
        if (relPath === '') setRootError(listing.error ?? null)
      } finally {
        setLoading((prev) => {
          if (epoch !== epochRef.current) return prev
          const next = new Set(prev)
          next.delete(relPath)
          return next
        })
      }
    },
    [request, rootPath]
  )

  // Re-root on project change: clear everything and load the root listing.
  useEffect(() => {
    epochRef.current += 1
    setChildren(new Map())
    setExpanded(new Set())
    setLoading(new Set())
    setTruncated(new Set())
    setSelected(null)
    setRootError(null)
    if (rootPath) void loadDir('', true)
  }, [projectId, rootPath, distro, loadDir])

  const toggleDir = useCallback(
    (relPath: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(relPath)) {
          next.delete(relPath)
        } else {
          next.add(relPath)
          void loadDir(relPath)
        }
        return next
      })
    },
    [loadDir]
  )

  const refresh = useCallback((relPath: string) => void loadDir(relPath, true), [loadDir])

  const rename = useCallback(
    async (relPath: string, newName: string): Promise<FileOpResult> => {
      const result = (await window.dashboard?.projectFiles?.rename(request(relPath), newName)) ?? { ok: false }
      if (result.ok) await loadDir(parentRelPath(relPath), true)
      return result
    },
    [request, loadDir]
  )

  const remove = useCallback(
    async (relPath: string): Promise<FileOpResult> => {
      const result = (await window.dashboard?.projectFiles?.delete(request(relPath))) ?? { ok: false }
      if (result.ok) {
        if (selected === relPath) setSelected(null)
        await loadDir(parentRelPath(relPath), true)
      }
      return result
    },
    [request, loadDir, selected]
  )

  const create = useCallback(
    async (parentRel: string, name: string, kind: FileKind): Promise<FileOpResult> => {
      const result = (await window.dashboard?.projectFiles?.create(request(parentRel), name, kind)) ?? { ok: false }
      if (result.ok) {
        setExpanded((prev) => new Set(prev).add(parentRel))
        await loadDir(parentRel, true)
      }
      return result
    },
    [request, loadDir]
  )

  const reveal = useCallback((relPath: string) => void window.dashboard?.projectFiles?.reveal(request(relPath)), [request])
  const openExternally = useCallback(
    async (relPath: string): Promise<FileOpResult> =>
      (await window.dashboard?.projectFiles?.open(request(relPath))) ?? { ok: false },
    [request]
  )

  return {
    rootError,
    childrenOf: useCallback((relPath: string) => children.get(relPath), [children]),
    isExpanded: useCallback((relPath: string) => expanded.has(relPath), [expanded]),
    isLoading: useCallback((relPath: string) => loading.has(relPath), [loading]),
    isTruncated: useCallback((relPath: string) => truncated.has(relPath), [truncated]),
    selected,
    toggleDir,
    select: setSelected,
    refresh,
    rename,
    remove,
    create,
    reveal,
    openExternally
  }
}
