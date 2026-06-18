import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { FileOpResult, FilePreview, FileRequest } from '@shared/project-files'
import { HistoryMarkdown } from '../history-markdown'

const MARKDOWN_EXT = /\.(md|markdown|mdx|mdown|mkd)$/i

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FilePreviewModal({
  request,
  onOpenExternally,
  onClose
}: {
  request: FileRequest
  onOpenExternally: () => Promise<FileOpResult>
  onClose: () => void
}): JSX.Element {
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [raw, setRaw] = useState(false)
  const [openingExternal, setOpeningExternal] = useState(false)
  const [externalError, setExternalError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setRaw(false)
    setExternalError(null)
    window.dashboard?.projectFiles
      ?.preview(request)
      .then((result) => {
        if (!cancelled) setPreview(result)
      })
      .catch(() => {
        if (!cancelled) setPreview({ kind: 'error', name: '', size: 0, error: 'Preview failed' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [request.rootPath, request.distro, request.relPath])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const name = preview?.name || request.relPath.split('/').pop() || 'File'
  const isMarkdown = MARKDOWN_EXT.test(name)
  const canToggle = isMarkdown && preview?.kind === 'text'

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

  return (
    <div className="files-modal-backdrop" onMouseDown={onClose}>
      <div
        className="files-preview"
        role="dialog"
        aria-label={`Preview ${name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="files-preview-header">
          <span className="files-preview-name" title={name}>
            {name}
          </span>
          <div className="files-preview-actions">
            {canToggle ? (
              <button type="button" onClick={() => setRaw((current) => !current)}>
                {raw ? 'Rendered' : 'Raw'}
              </button>
            ) : null}
            <button type="button" onClick={() => void openExternal()} disabled={openingExternal}>
              {openingExternal ? 'Opening...' : 'Open externally'}
            </button>
            <button type="button" className="files-preview-close" onClick={onClose} aria-label="Close preview">
              ✕
            </button>
          </div>
        </div>
        {externalError ? <div className="files-preview-open-error">{externalError}</div> : null}
        <div className="files-preview-body">
          {loading ? (
            <div className="files-preview-msg">Loading…</div>
          ) : !preview ? (
            <div className="files-preview-msg">No preview.</div>
          ) : preview.kind === 'text' ? (
            isMarkdown && !raw ? (
              <div className="files-preview-markdown">
                <HistoryMarkdown text={preview.text ?? ''} />
              </div>
            ) : (
              <pre className="files-preview-text">{preview.text}</pre>
            )
          ) : preview.kind === 'image' ? (
            <div className="files-preview-image">
              <img src={preview.dataUrl} alt={name} />
            </div>
          ) : preview.kind === 'too-large' ? (
            <div className="files-preview-msg">
              File is too large to preview ({formatSize(preview.size)}). Use “Open externally”.
            </div>
          ) : preview.kind === 'binary' ? (
            <div className="files-preview-msg">Binary file — no in-app preview. Use “Open externally”.</div>
          ) : (
            <div className="files-preview-msg error">{preview.error ?? 'Could not preview this file.'}</div>
          )}
        </div>
      </div>
    </div>
  )
}
