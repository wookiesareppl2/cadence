import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { PlatformId } from '@shared/platform'
import type { MemoryFileMeta } from '@shared/memory'
import { HistoryMarkdown } from '../history-markdown'
import { useProjectMemory } from './use-project-memory'
import './memory-view.css'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatModified(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function MemoryView({
  platform,
  projectId,
  initialFileId,
  initialFileRequestKey,
  onClose
}: {
  platform: PlatformId
  projectId: string | null
  initialFileId?: string | null
  initialFileRequestKey?: number | null
  onClose: () => void
}): JSX.Element {
  const { data, loading, error, selectedId, select, content, contentLoading, save } = useProjectMemory(
    platform,
    projectId
  )
  const [filter, setFilter] = useState('')
  const [pendingInitialId, setPendingInitialId] = useState<string | null>(initialFileId ?? null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    setPendingInitialId(initialFileId ?? null)
  }, [initialFileId, initialFileRequestKey])

  // Leaving a file (or reloading) always drops back to read mode.
  useEffect(() => {
    setEditing(false)
    setSaveError(null)
  }, [selectedId])

  const groups = useMemo(() => {
    if (!data) return []
    const needle = filter.trim().toLowerCase()
    if (!needle) return data.groups
    return data.groups
      .map((group) => ({ ...group, files: group.files.filter((file) => file.label.toLowerCase().includes(needle)) }))
      .filter((group) => group.files.length > 0)
  }, [data, filter])

  const selectedMeta: MemoryFileMeta | null = useMemo(() => {
    if (!data || !selectedId) return null
    for (const group of data.groups) {
      const found = group.files.find((file) => file.id === selectedId)
      if (found) return found
    }
    return null
  }, [data, selectedId])

  useEffect(() => {
    if (!data || !pendingInitialId) return
    const ids = data.groups.flatMap((group) => group.files.map((file) => file.id))
    if (ids.includes(pendingInitialId)) {
      setFilter('')
      select(pendingInitialId)
    }
    setPendingInitialId(null)
  }, [data, pendingInitialId, select])

  const beginEdit = (): void => {
    setDraft(content?.text ?? '')
    setSaveError(null)
    setEditing(true)
  }

  const commit = async (): Promise<void> => {
    if (!selectedId) return
    setSaving(true)
    setSaveError(null)
    const ok = await save(selectedId, draft)
    setSaving(false)
    if (ok) setEditing(false)
    else setSaveError('Could not save this file. It may be open or locked elsewhere.')
  }

  // Esc cancels an in-progress edit first, otherwise closes the viewer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (editing) setEditing(false)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editing, onClose])

  const hasAnyFiles = (data?.groups.length ?? 0) > 0

  return (
    <section className="panel memory-view" aria-label="Project memory and context">
      <div className="panel-header memory-bar">
        <div className="memory-heading">
          <h1>Memory &amp; Context</h1>
          <span>{data?.available ? data.projectName || 'Selected project' : 'No project selected'}</span>
        </div>
        <button type="button" className="memory-close" onClick={onClose} aria-label="Close memory view">
          ✕
        </button>
      </div>

      <div className="memory-body">
        <aside className="memory-list">
          <input
            type="text"
            className="memory-filter"
            placeholder="Filter files"
            value={filter}
            spellCheck={false}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="memory-list-scroll">
            {loading ? (
              <div className="memory-msg">Loading…</div>
            ) : !hasAnyFiles ? (
              <div className="memory-msg">No memory or context files found for this project.</div>
            ) : groups.length === 0 ? (
              <div className="memory-msg">No files match “{filter}”.</div>
            ) : (
              groups.map((group) => (
                <div key={group.id} className="memory-group">
                  <div className="memory-group-head">
                    {group.label}
                    <span className="memory-group-count">{group.files.length}</span>
                  </div>
                  {group.files.map((file) => (
                    <button
                      key={file.id}
                      type="button"
                      className={`memory-file-row${file.id === selectedId ? ' active' : ''}`}
                      onClick={() => select(file.id)}
                    >
                      <span className="memory-file-name">{file.label}</span>
                      <span className="memory-file-size">{formatSize(file.sizeBytes)}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        <div className="memory-detail">
          {error ? (
            <div className="memory-msg error">{error}</div>
          ) : !selectedId || !selectedMeta ? (
            <div className="memory-msg">
              {hasAnyFiles ? 'Select a file to view it.' : 'Nothing to show yet.'}
            </div>
          ) : (
            <>
              <div className="memory-detail-head">
                <div className="memory-detail-title">
                  <span className="memory-detail-name" title={selectedMeta.label}>
                    {selectedMeta.label}
                  </span>
                  <span className="memory-detail-meta">
                    {formatSize(selectedMeta.sizeBytes)} · {formatModified(selectedMeta.modifiedMs)}
                  </span>
                </div>
                <div className="memory-detail-actions">
                  {editing ? (
                    <>
                      <button type="button" className="memory-action primary" onClick={() => void commit()} disabled={saving}>
                        {saving ? 'Saving…' : 'Save'}
                      </button>
                      <button type="button" className="memory-action" onClick={() => setEditing(false)} disabled={saving}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="memory-action" onClick={beginEdit} disabled={contentLoading || !content}>
                      Edit
                    </button>
                  )}
                </div>
              </div>
              {saveError ? <div className="memory-save-error">{saveError}</div> : null}
              <div className="memory-detail-body">
                {contentLoading ? (
                  <div className="memory-msg">Loading…</div>
                ) : content?.error ? (
                  <div className="memory-msg error">{content.error}</div>
                ) : editing ? (
                  <textarea
                    className="memory-editor"
                    value={draft}
                    spellCheck={false}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                ) : (
                  <div className="memory-markdown">
                    <HistoryMarkdown text={content?.text ?? ''} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
