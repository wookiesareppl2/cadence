import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import type { FileEntry, FileKind } from '@shared/project-files'
import { FilePreviewModal } from './file-preview-modal'
import { useProjectFileTree, type FileTreeState } from './use-project-file-tree'
import './file-tree-panel.css'

type MenuState = { x: number; y: number; relPath: string; entry: FileEntry }
type DeleteState = { relPath: string; name: string }
type CreateState = { parentRel: string; kind: FileKind }

function rowIndent(depth: number): CSSProperties {
  return { paddingLeft: `${8 + depth * 14}px` }
}

function joinRel(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileTreePanel({
  rootPath,
  distro,
  projectId,
  projectName,
  open,
  onToggle
}: {
  rootPath: string | null
  distro: string | null
  projectId: string | null
  projectName: string | null
  open: boolean
  onToggle: () => void
}): JSX.Element {
  const tree = useProjectFileTree(rootPath, distro, projectId)
  const [preview, setPreview] = useState<{ relPath: string; name: string } | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<DeleteState | null>(null)
  const [creating, setCreating] = useState<CreateState | null>(null)

  const displayPath = (relPath: string): string =>
    distro ? `${rootPath}/${relPath}` : `${rootPath}\\${relPath.replace(/\//g, '\\')}`

  if (!open) {
    return (
      <div className="files-panel-shell closed">
        <button type="button" className="files-panel-rail" onClick={onToggle} title="Show files">
          <span className="files-panel-rail-icon" aria-hidden="true">
            ▸
          </span>
          <span className="files-panel-rail-label">Files</span>
        </button>
      </div>
    )
  }

  const startCreate = (parentRel: string, kind: FileKind): void => {
    setMenu(null)
    // The inline input renders inside its parent level, so that folder must be
    // expanded first (the root level is always rendered).
    if (parentRel && !tree.isExpanded(parentRel)) tree.toggleDir(parentRel)
    setCreating({ parentRel, kind })
  }

  return (
    <div className="files-panel-shell open">
      <section className="panel files-panel" aria-label="Project files">
        <div className="panel-header files-panel-header">
          <div className="files-panel-heading">
            <h1>Files</h1>
            {projectName ? <span title={rootPath ?? undefined}>{projectName}</span> : null}
          </div>
          <div className="files-panel-actions">
            <button type="button" onClick={() => rootPath && startCreate('', 'file')} disabled={!rootPath} title="New file" aria-label="New file">
              ＋
            </button>
            <button type="button" onClick={() => rootPath && startCreate('', 'dir')} disabled={!rootPath} title="New folder" aria-label="New folder">
              ＋▸
            </button>
            <button type="button" onClick={() => tree.refresh('')} disabled={!rootPath} title="Refresh" aria-label="Refresh">
              ⟳
            </button>
            <button
              type="button"
              className="files-panel-collapse"
              onClick={onToggle}
              title="Hide files"
              aria-label="Hide files"
            >
              ◂
            </button>
          </div>
        </div>

        <div className="files-panel-tree" onClick={() => menu && setMenu(null)}>
          {!rootPath ? (
            <div className="files-empty">Select a project to browse its files.</div>
          ) : tree.rootError ? (
            <div className="files-empty error">{tree.rootError}</div>
          ) : (
            <FileTreeLevel
              parentRel=""
              depth={0}
              tree={tree}
              renaming={renaming}
              creating={creating}
              onRenameCommit={async (relPath, name) => {
                setRenaming(null)
                if (name) await tree.rename(relPath, name)
              }}
              onRenameCancel={() => setRenaming(null)}
              onCreateCommit={async (parentRel, name, kind) => {
                setCreating(null)
                if (name) await tree.create(parentRel, name, kind)
              }}
              onCreateCancel={() => setCreating(null)}
              onPreview={(relPath, name) => setPreview({ relPath, name })}
              onMenu={(event, relPath, entry) => {
                event.preventDefault()
                setMenu({ x: event.clientX, y: event.clientY, relPath, entry })
              }}
            />
          )}
        </div>
      </section>

      {menu ? (
        <FileContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onPreview={() => {
            setPreview({ relPath: menu.relPath, name: menu.entry.name })
            setMenu(null)
          }}
          onOpen={() => {
            void tree.openExternally(menu.relPath)
            setMenu(null)
          }}
          onReveal={() => {
            tree.reveal(menu.relPath)
            setMenu(null)
          }}
          onCopyPath={() => {
            void navigator.clipboard?.writeText(displayPath(menu.relPath)).catch(() => undefined)
            setMenu(null)
          }}
          onRename={() => {
            setRenaming(menu.relPath)
            setMenu(null)
          }}
          onDelete={() => {
            setDeleting({ relPath: menu.relPath, name: menu.entry.name })
            setMenu(null)
          }}
          onNewFile={() => startCreate(menu.relPath, 'file')}
          onNewFolder={() => startCreate(menu.relPath, 'dir')}
        />
      ) : null}

      {deleting ? (
        <DeleteConfirm
          name={deleting.name}
          isWsl={Boolean(distro)}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const target = deleting.relPath
            setDeleting(null)
            await tree.remove(target)
          }}
        />
      ) : null}

      {preview ? (
        <FilePreviewModal
          request={{ rootPath: rootPath ?? '', distro, relPath: preview.relPath }}
          onOpenExternally={() => tree.openExternally(preview.relPath)}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  )
}

function FileTreeLevel({
  parentRel,
  depth,
  tree,
  renaming,
  creating,
  onRenameCommit,
  onRenameCancel,
  onCreateCommit,
  onCreateCancel,
  onPreview,
  onMenu
}: {
  parentRel: string
  depth: number
  tree: FileTreeState
  renaming: string | null
  creating: CreateState | null
  onRenameCommit: (relPath: string, name: string) => void
  onRenameCancel: () => void
  onCreateCommit: (parentRel: string, name: string, kind: FileKind) => void
  onCreateCancel: () => void
  onPreview: (relPath: string, name: string) => void
  onMenu: (event: React.MouseEvent, relPath: string, entry: FileEntry) => void
}): JSX.Element {
  const entries = tree.childrenOf(parentRel)
  const loading = tree.isLoading(parentRel)

  return (
    <>
      {creating && creating.parentRel === parentRel ? (
        <NameInputRow
          depth={depth}
          placeholder={creating.kind === 'dir' ? 'New folder name' : 'New file name'}
          onCommit={(name) => onCreateCommit(parentRel, name, creating.kind)}
          onCancel={onCreateCancel}
        />
      ) : null}

      {entries === undefined ? (
        loading ? (
          <div className="files-muted" style={rowIndent(depth)}>
            Loading…
          </div>
        ) : null
      ) : entries.length === 0 ? (
        <div className="files-muted" style={rowIndent(depth)}>
          empty
        </div>
      ) : (
        entries.map((entry) => {
          const relPath = joinRel(parentRel, entry.name)
          return (
            <Fragment key={relPath}>
              {renaming === relPath ? (
                <NameInputRow
                  depth={depth}
                  initial={entry.name}
                  onCommit={(name) => onRenameCommit(relPath, name)}
                  onCancel={onRenameCancel}
                />
              ) : (
                <TreeRow entry={entry} relPath={relPath} depth={depth} tree={tree} onPreview={onPreview} onMenu={onMenu} />
              )}
              {entry.kind === 'dir' && tree.isExpanded(relPath) ? (
                <FileTreeLevel
                  parentRel={relPath}
                  depth={depth + 1}
                  tree={tree}
                  renaming={renaming}
                  creating={creating}
                  onRenameCommit={onRenameCommit}
                  onRenameCancel={onRenameCancel}
                  onCreateCommit={onCreateCommit}
                  onCreateCancel={onCreateCancel}
                  onPreview={onPreview}
                  onMenu={onMenu}
                />
              ) : null}
            </Fragment>
          )
        })
      )}
    </>
  )
}

function TreeRow({
  entry,
  relPath,
  depth,
  tree,
  onPreview,
  onMenu
}: {
  entry: FileEntry
  relPath: string
  depth: number
  tree: FileTreeState
  onPreview: (relPath: string, name: string) => void
  onMenu: (event: React.MouseEvent, relPath: string, entry: FileEntry) => void
}): JSX.Element {
  const isDir = entry.kind === 'dir'
  const expanded = isDir && tree.isExpanded(relPath)
  const title = `${entry.name}${entry.size ? ` · ${formatSize(entry.size)}` : ''}${
    entry.modifiedMs ? ` · ${new Date(entry.modifiedMs).toLocaleString()}` : ''
  }`

  const activate = (): void => {
    tree.select(relPath)
    if (isDir) tree.toggleDir(relPath)
  }

  return (
    <div
      className={`files-row ${tree.selected === relPath ? 'selected' : ''} ${isDir ? 'dir' : 'file'}`}
      style={rowIndent(depth)}
      title={title}
      onContextMenu={(event) => onMenu(event, relPath, entry)}
    >
      <button
        type="button"
        className="files-row-main"
        onClick={activate}
        onDoubleClick={() => {
          if (!isDir) onPreview(relPath, entry.name)
        }}
      >
        <span className="files-row-twisty" aria-hidden="true">
          {isDir ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className="files-row-name">{entry.name}</span>
      </button>
      <button
        type="button"
        className="files-row-menu"
        onClick={(event) => onMenu(event, relPath, entry)}
        aria-label={`Actions for ${entry.name}`}
        title="Actions"
      >
        ⋯
      </button>
    </div>
  )
}

function NameInputRow({
  depth,
  initial = '',
  placeholder,
  onCommit,
  onCancel
}: {
  depth: number
  initial?: string
  placeholder?: string
  onCommit: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCommit(value.trim())
  }
  const cancel = (): void => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }

  return (
    <div className="files-row" style={rowIndent(depth)}>
      <input
        ref={inputRef}
        className="files-name-input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          }
        }}
      />
    </div>
  )
}

function FileContextMenu({
  menu,
  onClose,
  onPreview,
  onOpen,
  onReveal,
  onCopyPath,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder
}: {
  menu: MenuState
  onClose: () => void
  onPreview: () => void
  onOpen: () => void
  onReveal: () => void
  onCopyPath: () => void
  onRename: () => void
  onDelete: () => void
  onNewFile: () => void
  onNewFolder: () => void
}): JSX.Element {
  useEffect(() => {
    const dismiss = (): void => onClose()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const isDir = menu.entry.kind === 'dir'
  const left = Math.min(menu.x, window.innerWidth - 200)
  const top = Math.min(menu.y, window.innerHeight - 240)

  return (
    <>
      <div className="files-menu-backdrop" onMouseDown={onClose} onContextMenu={(event) => event.preventDefault()} />
      <div className="files-menu" style={{ left, top }} role="menu">
        {!isDir ? (
          <button type="button" role="menuitem" onClick={onPreview}>
            Preview
          </button>
        ) : null}
        {!isDir ? (
          <button type="button" role="menuitem" onClick={onOpen}>
            Open
          </button>
        ) : null}
        <button type="button" role="menuitem" onClick={onReveal}>
          Reveal in File Explorer
        </button>
        <button type="button" role="menuitem" onClick={onCopyPath}>
          Copy path
        </button>
        {isDir ? <div className="files-menu-sep" /> : null}
        {isDir ? (
          <button type="button" role="menuitem" onClick={onNewFile}>
            New file…
          </button>
        ) : null}
        {isDir ? (
          <button type="button" role="menuitem" onClick={onNewFolder}>
            New folder…
          </button>
        ) : null}
        <div className="files-menu-sep" />
        <button type="button" role="menuitem" onClick={onRename}>
          Rename…
        </button>
        <button type="button" role="menuitem" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </>
  )
}

function DeleteConfirm({
  name,
  isWsl,
  onCancel,
  onConfirm
}: {
  name: string
  isWsl: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="files-modal-backdrop" onMouseDown={onCancel}>
      <div className="files-confirm" role="dialog" aria-label="Confirm delete" onMouseDown={(event) => event.stopPropagation()}>
        <h2>Delete “{name}”?</h2>
        <p>
          {isWsl
            ? 'This WSL item will be deleted permanently — the Recycle Bin does not cover the WSL share, so it cannot be recovered.'
            : 'This will be moved to the Recycle Bin.'}
        </p>
        <div className="files-confirm-actions">
          <button type="button" className="files-confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="files-confirm-delete" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
