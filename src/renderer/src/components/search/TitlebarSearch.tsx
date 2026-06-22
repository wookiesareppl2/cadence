import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { PlatformId } from '@shared/platform'
import type { SearchResultItem, SearchSnippet } from '@shared/search'
import { useGlobalSearch } from './use-global-search'
import './search.css'

const DROPDOWN_MIN_WIDTH = 380
const VIEWPORT_MARGIN = 8

type Section = { key: string; label: string; scoped: boolean; items: SearchResultItem[] }

export function TitlebarSearch({
  platform,
  projectId,
  onActivate
}: {
  platform: PlatformId
  projectId: string | null
  onActivate: (item: SearchResultItem, query: string) => void
}): JSX.Element {
  const { query, setQuery, results, loading } = useGlobalSearch(platform, projectId)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const sections = useMemo<Section[]>(() => {
    if (!results) return []
    return (
      [
        { key: 'projects', label: 'Projects', scoped: false, items: results.projects },
        { key: 'sessions', label: 'Sessions', scoped: false, items: results.sessions },
        { key: 'files', label: 'Files', scoped: true, items: results.files },
        { key: 'history', label: 'History', scoped: true, items: results.history }
      ] satisfies Section[]
    ).filter((section) => section.items.length > 0)
  }, [results])

  const flat = useMemo(() => sections.flatMap((section) => section.items), [sections])

  // Reset the highlighted row whenever the result set changes.
  useEffect(() => setActiveIndex(0), [flat])

  const close = useCallback(() => {
    setOpen(false)
    inputRef.current?.blur()
  }, [])

  const activate = useCallback(
    (item: SearchResultItem | undefined) => {
      if (!item) return
      onActivate(item, query.trim())
      close()
    },
    [onActivate, close, query]
  )

  // Position the dropdown from the input's rect (fixed, so it escapes the
  // titlebar's clipping), keeping it on-screen.
  useLayoutEffect(() => {
    if (!open) return
    const update = (): void => {
      if (inputRef.current) setRect(inputRef.current.getBoundingClientRect())
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [open])

  // Dismiss on outside pointer / Esc / scroll (matching the app's overlay pattern).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onScroll = (event: Event): void => {
      if (containerRef.current && containerRef.current.contains(event.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (query) setQuery('')
      else close()
      return
    }
    if (!flat.length) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((index) => Math.min(index + 1, flat.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activate(flat[activeIndex])
    }
  }

  const showDropdown = open && query.trim().length > 0
  const dropdownStyle = rect
    ? {
        top: rect.bottom + 6,
        left: Math.max(
          VIEWPORT_MARGIN,
          Math.min(rect.left, window.innerWidth - Math.max(rect.width, DROPDOWN_MIN_WIDTH) - VIEWPORT_MARGIN)
        ),
        width: Math.max(rect.width, DROPDOWN_MIN_WIDTH)
      }
    : undefined

  let runningIndex = -1

  return (
    <div
      className="titlebar-search"
      ref={containerRef}
      onClick={() => inputRef.current?.focus()}
    >
      <span className="titlebar-search-glyph" aria-hidden="true">
        ⌕
      </span>
      <input
        ref={inputRef}
        type="text"
        className="titlebar-search-input"
        placeholder="Search projects, sessions, files, history"
        value={query}
        spellCheck={false}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {query ? (
        <button
          type="button"
          className="titlebar-search-clear"
          aria-label="Clear search"
          onClick={() => {
            setQuery('')
            inputRef.current?.focus()
          }}
        >
          ✕
        </button>
      ) : null}

      {showDropdown ? (
        <div className="search-dropdown" style={dropdownStyle} role="listbox">
          {sections.length === 0 ? (
            <div className="search-empty">{loading ? 'Searching…' : 'No matches'}</div>
          ) : (
            sections.map((section) => (
              <div key={section.key} className="search-section">
                <div className="search-section-head">
                  {section.label}
                  {section.scoped ? <span className="search-section-scope"> · this project</span> : null}
                </div>
                {section.items.map((item) => {
                  runningIndex += 1
                  const index = runningIndex
                  return (
                    <button
                      key={`${section.key}:${item.id}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      className={`search-row${index === activeIndex ? ' active' : ''}`}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => activate(item)}
                    >
                      <span className="search-row-title">{item.title}</span>
                      {item.snippet ? (
                        <Snippet snippet={item.snippet} />
                      ) : item.subtitle ? (
                        <span className="search-row-subtitle">{item.subtitle}</span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))
          )}
          {results?.truncated ? (
            <div className="search-foot">Showing top matches — refine your search for more.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function Snippet({ snippet }: { snippet: SearchSnippet }): JSX.Element {
  const { text, matchStart, matchEnd } = snippet
  return (
    <span className="search-snippet">
      {text.slice(0, matchStart)}
      <mark>{text.slice(matchStart, matchEnd)}</mark>
      {text.slice(matchEnd)}
    </span>
  )
}
