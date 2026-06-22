import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@shared/platform'
import type { MemoryFileContent, ProjectMemory } from '@shared/memory'

export type ProjectMemoryState = {
  data: ProjectMemory | null
  loading: boolean
  error: string | null
  selectedId: string | null
  select: (id: string) => void
  content: MemoryFileContent | null
  contentLoading: boolean
  save: (id: string, text: string) => Promise<boolean>
}

// Loads a project's memory/context file list (grouped) and the content of the
// selected file, and persists edits. Request-id guards drop out-of-order
// responses when the project changes mid-flight.
export function useProjectMemory(platform: PlatformId, projectId: string | null): ProjectMemoryState {
  const [data, setData] = useState<ProjectMemory | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState<MemoryFileContent | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const listReq = useRef(0)
  const contentReq = useRef(0)

  const loadList = useCallback(async () => {
    const api = window.dashboard?.memory?.list
    if (!api) {
      setError('Memory API unavailable')
      setLoading(false)
      return
    }
    const id = ++listReq.current
    setLoading(true)
    try {
      const result = await api(platform, projectId)
      if (id !== listReq.current) return
      setData(result)
      setError(null)
    } catch {
      if (id !== listReq.current) return
      setData(null)
      setError('Could not load memory')
    } finally {
      if (id === listReq.current) setLoading(false)
    }
  }, [platform, projectId])

  useEffect(() => {
    loadList()
  }, [loadList])

  // Keep a valid selection: pick the first file when nothing is selected or the
  // current selection vanished (e.g. after switching project).
  useEffect(() => {
    if (!data) return
    const ids = data.groups.flatMap((group) => group.files.map((file) => file.id))
    setSelectedId((current) => (current && ids.includes(current) ? current : ids[0] ?? null))
  }, [data])

  useEffect(() => {
    if (!selectedId) {
      setContent(null)
      return
    }
    const api = window.dashboard?.memory?.read
    if (!api) return
    const id = ++contentReq.current
    setContentLoading(true)
    api(platform, projectId, selectedId)
      .then((result) => {
        if (id === contentReq.current) setContent(result)
      })
      .catch(() => {
        if (id === contentReq.current) setContent({ id: selectedId, label: '', text: '', error: 'Could not read this file' })
      })
      .finally(() => {
        if (id === contentReq.current) setContentLoading(false)
      })
  }, [selectedId, platform, projectId])

  const save = useCallback(
    async (id: string, text: string): Promise<boolean> => {
      const api = window.dashboard?.memory?.write
      if (!api) return false
      const result = await api(platform, projectId, id, text)
      if (result.ok) {
        await loadList()
        const fresh = await window.dashboard?.memory?.read?.(platform, projectId, id)
        if (fresh) setContent(fresh)
      }
      return result.ok
    },
    [platform, projectId, loadList]
  )

  return {
    data,
    loading,
    error,
    selectedId,
    select: setSelectedId,
    content,
    contentLoading,
    save
  }
}
