import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX, ReactNode } from 'react'
import {
  projectFileBreadcrumbParts,
  type FileOpResult,
  type FilePreview,
  type FileRequest,
  type ProjectFileWatchMode
} from '@shared/project-files'
import { HistoryMarkdown } from '../history-markdown'

const MARKDOWN_EXT = /\.(md|markdown|mdx|mdown|mkd)$/i
const LIVE_PREVIEW_REFRESH_MS = 1200
const CHANGE_FLASH_MS = 2200

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Wrap every case-insensitive occurrence of `highlight` in the text with a <mark>
// so a term arrived-at from search stands out. The first match carries a marker
// class the preview uses to scroll it into view.
function HighlightedText({ text, highlight }: { text: string; highlight?: string }): JSX.Element {
  const needle = highlight?.toLowerCase().trim()
  if (!needle) return <>{text}</>

  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  let cursor = 0
  let first = true
  for (;;) {
    const idx = lower.indexOf(needle, cursor)
    if (idx === -1) {
      parts.push(text.slice(cursor))
      break
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx))
    parts.push(
      <mark
        key={idx}
        className={first ? 'files-preview-match files-preview-match-first' : 'files-preview-match'}
      >
        {text.slice(idx, idx + needle.length)}
      </mark>
    )
    first = false
    cursor = idx + needle.length
  }
  return <>{parts}</>
}

function changedLineNumbers(before: string, after: string): Set<number> {
  if (before === after) return new Set()
  const beforeLines = before.split(/\r?\n/)
  const afterLines = after.split(/\r?\n/)
  let prefix = 0

  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const changed = new Set<number>()
  const start = prefix
  const end = afterLines.length - suffix - 1
  if (end >= start) {
    for (let line = start; line <= end; line += 1) changed.add(line + 1)
  } else if (afterLines.length > 0) {
    changed.add(Math.min(start + 1, afterLines.length))
  }
  return changed
}

function HighlightedCode({
  text,
  highlight,
  changedLines,
  targetLine
}: {
  text: string
  highlight?: string
  changedLines?: Set<number>
  targetLine?: number
}): JSX.Element {
  const lines = text.split(/\r?\n/)

  return (
    <div className="files-preview-code">
      {lines.map((line, index) => {
        const lineNo = index + 1
        const classes = ['files-preview-code-line']
        if (changedLines?.has(lineNo)) classes.push('changed')
        if (lineNo === targetLine) classes.push('target')
        return (
          <div key={index} className={classes.join(' ')} data-line={lineNo}>
            <span className="files-preview-line-no" aria-hidden="true">
              {lineNo}
            </span>
            <code>
              <HighlightedText text={line} highlight={highlight} />
            </code>
          </div>
        )
      })}
    </div>
  )
}

function formatPreviewLoadedAt(ms: number | null): string {
  if (!ms) return 'Live'
  return `Live ${new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
}

function FileLocationBreadcrumb({ parts }: { parts: string[] }): JSX.Element {
  const label = parts.join(' / ')
  return (
    <nav className="files-preview-breadcrumb" aria-label="File location" title={label}>
      {parts.map((part, index) => (
        <span key={`${part}:${index}`} className="files-preview-breadcrumb-part">
          <span className={index === parts.length - 1 ? 'files-preview-crumb current' : 'files-preview-crumb'}>
            {part}
          </span>
          {index < parts.length - 1 ? (
            <span className="files-preview-crumb-separator" aria-hidden="true">
              /
            </span>
          ) : null}
        </span>
      ))}
    </nav>
  )
}

function FilePreviewFrame({
  request,
  highlight,
  scrollToLine,
  live = false,
  changeToken,
  mode,
  extraActions,
  onOpenExternally,
  onClose
}: {
  request: FileRequest
  highlight?: string
  scrollToLine?: number
  live?: boolean
  changeToken?: number
  mode: 'modal' | 'pane'
  extraActions?: ReactNode
  onOpenExternally: () => Promise<FileOpResult>
  onClose?: () => void
}): JSX.Element {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(true)
  // Default markdown files to the raw view when highlighting or jumping to a line,
  // so the term/line is visible (the rendered view has neither highlights nor
  // line numbers).
  const [raw, setRaw] = useState(Boolean(highlight) || scrollToLine != null)
  const [openingExternal, setOpeningExternal] = useState(false)
  const [externalError, setExternalError] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [changedLines, setChangedLines] = useState<Set<number>>(new Set())
  const bodyRef = useRef<HTMLDivElement>(null)
  const loadSeqRef = useRef(0)
  const previewRef = useRef<FilePreview | null>(null)
  const flashTimerRef = useRef<number | null>(null)

  const loadPreview = useCallback(
    async (silent = false, trackDiff = false): Promise<void> => {
      const seq = loadSeqRef.current + 1
      loadSeqRef.current = seq
      if (!silent) setLoading(true)

      try {
        const result = await window.dashboard?.projectFiles?.preview(request)
        if (loadSeqRef.current !== seq) return
        const next = result ?? { kind: 'error' as const, name: '', size: 0, error: 'Preview unavailable' }
        const previous = previewRef.current
        if (trackDiff && previous?.kind === 'text' && next.kind === 'text') {
          const nextChangedLines = changedLineNumbers(previous.text ?? '', next.text ?? '')
          setChangedLines(nextChangedLines)
          if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
          flashTimerRef.current = window.setTimeout(() => {
            flashTimerRef.current = null
            setChangedLines(new Set())
          }, CHANGE_FLASH_MS)
        } else if (!silent) {
          setChangedLines(new Set())
        }
        previewRef.current = next
        setPreview(next)
        setLoadedAt(Date.now())
      } catch {
        if (loadSeqRef.current !== seq) return
        const next = { kind: 'error' as const, name: '', size: 0, error: 'Preview failed' }
        previewRef.current = next
        setPreview(next)
        setLoadedAt(Date.now())
      } finally {
        // Clear the spinner whenever this is the latest load, even for a silent
        // refresh. When auto-follow switches files, a non-silent load and the
        // changeToken-driven silent load fire together; the silent one wins the
        // sequence guard, so if only non-silent loads cleared `loading` the pane
        // would stay stuck on "Loading..." until a manual refresh.
        if (loadSeqRef.current === seq) setLoading(false)
      }
    },
    [request.rootPath, request.distro, request.relPath]
  )

  useEffect(() => {
    setPreview(null)
    previewRef.current = null
    setRaw(Boolean(highlight) || scrollToLine != null)
    setExternalError(null)
    setLoadedAt(null)
    setChangedLines(new Set())
    void loadPreview(false)
  }, [highlight, scrollToLine, loadPreview])

  useEffect(() => {
    if (changeToken === undefined) return
    void loadPreview(true, true)
  }, [changeToken, loadPreview])

  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => void loadPreview(true), LIVE_PREVIEW_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [live, loadPreview])

  useEffect(() => {
    if (!onClose) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // When opened from search, jump to the first highlighted match once the text
  // for the current view has rendered.
  useEffect(() => {
    if (!highlight || loading) return
    const first = bodyRef.current?.querySelector('.files-preview-match-first')
    first?.scrollIntoView({ block: 'center' })
  }, [highlight, loading, raw, preview])

  // When opened from a terminal file:line link, scroll the target line into view
  // once the code view has rendered (raw is forced on for line jumps).
  useEffect(() => {
    if (scrollToLine == null || loading) return
    const target = bodyRef.current?.querySelector(`[data-line="${scrollToLine}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [scrollToLine, loading, raw, preview])

  useEffect(
    () => () => {
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    },
    []
  )

  const name = preview?.name || request.relPath.split('/').pop() || 'File'
  const isMarkdown = MARKDOWN_EXT.test(name)
  const canToggle = isMarkdown && preview?.kind === 'text'
  const breadcrumbParts = projectFileBreadcrumbParts(request)

  const openExternal = async (): Promise<void> => {
    setOpeningExternal(true)
    setExternalError(null)
    try {
      const result = await onOpenExternally()
      if (!result.ok) setExternalError(result.error ?? 'Could not open this file externally.')
    } catch (error) {
      setExternalError(error instanceof Error ? error.message : 'Could not open this file externally.')
    } finally {
      setOpeningExternal(false)
    }
  }

  const content = (
    <>
      <div className="files-preview-header">
        <div className="files-preview-title">
          <span className="files-preview-name" title={name}>
            {name}
          </span>
          <FileLocationBreadcrumb parts={breadcrumbParts} />
        </div>
        <div className="files-preview-actions">
          {live ? (
            <span className="files-preview-live" title={loadedAt ? new Date(loadedAt).toLocaleString() : undefined}>
              {formatPreviewLoadedAt(loadedAt)}
            </span>
          ) : null}
          {canToggle ? (
            <button type="button" onClick={() => setRaw((current) => !current)}>
              {raw ? 'Rendered' : 'Raw'}
            </button>
          ) : null}
          <button type="button" onClick={() => void loadPreview(false)} title="Refresh preview" aria-label="Refresh preview">
            ⟳
          </button>
          <button type="button" onClick={() => void openExternal()} disabled={openingExternal}>
            {openingExternal ? 'Opening...' : 'Open externally'}
          </button>
          {extraActions}
          {onClose ? (
            <button type="button" className="files-preview-close" onClick={onClose} aria-label="Close preview">
              ✕
            </button>
          ) : null}
        </div>
      </div>
      {externalError ? <div className="files-preview-open-error">{externalError}</div> : null}
      <div className="files-preview-body" ref={bodyRef}>
        {loading ? (
          <div className="files-preview-msg">Loading...</div>
        ) : !preview ? (
          <div className="files-preview-msg">No preview.</div>
        ) : preview.kind === 'text' ? (
          isMarkdown && !raw ? (
            <div className="files-preview-markdown">
              <HistoryMarkdown text={preview.text ?? ''} />
            </div>
          ) : (
            <HighlightedCode
              text={preview.text ?? ''}
              highlight={highlight}
              changedLines={changedLines}
              targetLine={scrollToLine}
            />
          )
        ) : preview.kind === 'image' ? (
          <div className="files-preview-image">
            <img src={preview.dataUrl} alt={name} />
          </div>
        ) : preview.kind === 'too-large' ? (
          <div className="files-preview-msg">
            File is too large to preview ({formatSize(preview.size)}). Use "Open externally".
          </div>
        ) : preview.kind === 'binary' ? (
          <div className="files-preview-msg">Binary file. Use "Open externally".</div>
        ) : (
          <div className="files-preview-msg error">{preview.error ?? 'Could not preview this file.'}</div>
        )}
      </div>
    </>
  )

  if (mode === 'pane') {
    return (
      <section className="panel files-preview-pane" aria-label={`Preview ${name}`}>
        {content}
      </section>
    )
  }

  return (
    <div
      className="files-preview"
      role="dialog"
      aria-label={`Preview ${name}`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {content}
    </div>
  )
}

export function FilePreviewPane({
  request,
  highlight,
  followEdits = false,
  watchMode,
  watchError,
  changeToken,
  extraActions,
  onToggleFollowEdits,
  onOpenExternally
}: {
  request: FileRequest | null
  highlight?: string
  followEdits?: boolean
  watchMode?: ProjectFileWatchMode | null
  watchError?: string | null
  changeToken?: number
  extraActions?: ReactNode
  onToggleFollowEdits?: () => void
  onOpenExternally?: () => Promise<FileOpResult>
}): JSX.Element {
  const followControls = (
    <>
      {onToggleFollowEdits ? (
        <div className="files-preview-mode-toggle" role="group" aria-label="Preview update mode">
          <button
            type="button"
            className={followEdits ? 'active' : ''}
            aria-pressed={followEdits}
            onClick={() => {
              if (!followEdits) onToggleFollowEdits()
            }}
            title="Automatically preview the latest changed source file"
          >
            Auto-follow
          </button>
          <button
            type="button"
            className={!followEdits ? 'active' : ''}
            aria-pressed={!followEdits}
            onClick={() => {
              if (followEdits) onToggleFollowEdits()
            }}
            title="Keep the preview pinned to the selected file"
          >
            Pinned
          </button>
        </div>
      ) : null}
      {followEdits ? (
        <span className={`files-preview-watch-state${watchError ? ' error' : ''}`} title={watchError ?? undefined}>
          {watchError ? 'watch error' : watchMode === 'poll' ? 'polling' : watchMode === 'native' ? 'watching' : 'watch'}
        </span>
      ) : null}
    </>
  )

  if (!request) {
    return (
      <section className="panel files-preview-pane" aria-label="File preview">
        <div className="files-preview-header">
          <span className="files-preview-name">File Preview</span>
          <div className="files-preview-actions">
            {followControls}
            {extraActions}
          </div>
        </div>
        <div className="files-preview-body">
          <div className="files-preview-msg">
            {followEdits ? 'Waiting for source edits in this project.' : 'Select a file from Files.'}
          </div>
        </div>
      </section>
    )
  }

  return (
    <FilePreviewFrame
      request={request}
      highlight={highlight}
      live
      changeToken={changeToken}
      mode="pane"
      extraActions={
        <>
          {followControls}
          {extraActions}
        </>
      }
      onOpenExternally={onOpenExternally ?? (async () => ({ ok: false, error: 'Open externally unavailable' }))}
    />
  )
}

export function FilePreviewModal({
  request,
  highlight,
  scrollToLine,
  onOpenExternally,
  onClose
}: {
  request: FileRequest
  highlight?: string
  scrollToLine?: number
  onOpenExternally: () => Promise<FileOpResult>
  onClose: () => void
}): JSX.Element {
  return (
    <div className="files-modal-backdrop" onMouseDown={onClose}>
      <FilePreviewFrame
        request={request}
        highlight={highlight}
        scrollToLine={scrollToLine}
        mode="modal"
        onOpenExternally={onOpenExternally}
        onClose={onClose}
      />
    </div>
  )
}
