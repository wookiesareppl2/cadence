import { useEffect, useRef, useState } from 'react'
import type { PlatformId } from '@shared/platform'
import type { SearchResults } from '@shared/search'

const DEBOUNCE_MS = 250

export type GlobalSearchState = {
  query: string
  setQuery: (value: string) => void
  results: SearchResults | null
  loading: boolean
}

// Debounced bridge to the main-process search. A monotonic request id guards
// against out-of-order responses (a slow earlier query resolving after a faster
// later one), and re-running on platform/project change keeps results scoped to
// the active tab + selected project.
export function useGlobalSearch(platform: PlatformId, projectId: string | null): GlobalSearchState {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const requestId = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      requestId.current += 1
      setResults(null)
      setLoading(false)
      return
    }

    const runner = window.dashboard?.search?.query
    if (!runner) {
      setResults(null)
      setLoading(false)
      return
    }

    const id = ++requestId.current
    setLoading(true)
    const handle = window.setTimeout(() => {
      runner({ platform, projectId, query: trimmed })
        .then((next) => {
          if (id !== requestId.current) return
          setResults(next)
          setLoading(false)
        })
        .catch(() => {
          if (id !== requestId.current) return
          setResults(null)
          setLoading(false)
        })
    }, DEBOUNCE_MS)

    return () => window.clearTimeout(handle)
  }, [query, platform, projectId])

  return { query, setQuery, results, loading }
}
