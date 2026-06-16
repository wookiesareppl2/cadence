import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import { explainExample, type ExamplePart } from './command-glossary'
import { filterCommands, type CheatCommand, type CommandShell } from './terminal-commands'
import { useCheatSheetCommands, type CheatCommandDraft } from './use-cheat-sheet-commands'
import './cheat-sheet.css'

const TOOLTIP_LOCK_MS = 2000

const SHELL_TABS: { id: CommandShell; label: string; sublabel: string }[] = [
  { id: 'powershell', label: 'PowerShell', sublabel: 'Windows' },
  { id: 'wsl', label: 'WSL · Ubuntu', sublabel: 'bash' }
]

type HoverState = { command: CheatCommand; rect: DOMRect }
type EditorState = { mode: 'new' } | { mode: 'edit'; command: CheatCommand }

export function CheatSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const { commands, addCommand, updateCommand, removeCommand, resetDefaults } = useCheatSheetCommands()
  const [shell, setShell] = useState<CommandShell>('powershell')
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<HoverState | null>(null)
  const [locked, setLocked] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)

  const total = useMemo(() => commands.filter((entry) => entry.shell === shell).length, [commands, shell])
  const filtered = useMemo(() => filterCommands(commands, shell, query), [commands, shell, query])

  // The hover tooltip pins after TOOLTIP_LOCK_MS of continuous hover, becoming
  // interactive so its example variations can themselves be hovered.
  const lockTimerRef = useRef<number | null>(null)
  const lockedRef = useRef(false)
  useEffect(() => {
    lockedRef.current = locked
  }, [locked])
  const clearLockTimer = (): void => {
    if (lockTimerRef.current !== null) {
      window.clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }
  }
  useEffect(() => clearLockTimer, [])

  const openTooltip = (command: CheatCommand, rect: DOMRect): void => {
    clearLockTimer()
    setActive({ command, rect })
    setLocked(false)
    lockTimerRef.current = window.setTimeout(() => setLocked(true), TOOLTIP_LOCK_MS)
  }
  const leaveRow = (id: string): void => {
    if (lockedRef.current) return
    clearLockTimer()
    setActive((current) => (current?.command.id === id ? null : current))
  }
  const closeTooltip = (): void => {
    clearLockTimer()
    setLocked(false)
    setActive(null)
  }
  const openEditor = (next: EditorState): void => {
    closeTooltip()
    setEditor(next)
  }

  const closeEditor = (): void => setEditor(null)
  const saveEditor = (draft: CheatCommandDraft): void => {
    if (editor?.mode === 'edit') updateCommand(editor.command.id, draft)
    else addCommand(draft)
    setEditor(null)
  }

  return (
    <section className="panel cheat-sheet" aria-label="Terminal commands cheat sheet">
      <div className="panel-header cheat-sheet-bar">
        <div className="cheat-sheet-heading">
          <h1>Terminal Commands</h1>
          <span>{filtered.length === total ? `${total} commands` : `${filtered.length} of ${total}`}</span>
        </div>
        <button type="button" className="cheat-sheet-close" onClick={onClose} aria-label="Close cheat sheet">
          ✕
        </button>
      </div>

      <div className="cheat-sheet-controls">
        <div className="cheat-sheet-tabs" role="tablist" aria-label="Shell">
          {SHELL_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={shell === tab.id}
              className={shell === tab.id ? 'active' : ''}
              onClick={() => setShell(tab.id)}
            >
              {tab.label}
              <span className="cheat-sheet-tab-sub">{tab.sublabel}</span>
            </button>
          ))}
        </div>
        <input
          className="cheat-sheet-search"
          type="search"
          placeholder="Filter commands"
          aria-label="Filter commands"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="cheat-sheet-add" onClick={() => openEditor({ mode: 'new' })}>
          + Add command
        </button>
      </div>

      <div className="cheat-sheet-list" role="list">
        {filtered.length === 0 ? (
          <div className="cheat-sheet-empty">
            {query.trim() ? `No commands match “${query.trim()}”.` : 'No commands yet — add one.'}
          </div>
        ) : (
          filtered.map((entry) => (
            <CommandRow
              key={entry.id}
              entry={entry}
              arming={active?.command.id === entry.id && !locked}
              lockMs={TOOLTIP_LOCK_MS}
              onHover={(rect) => openTooltip(entry, rect)}
              onLeave={() => leaveRow(entry.id)}
              onEdit={() => openEditor({ mode: 'edit', command: entry })}
              onDelete={() => removeCommand(entry.id)}
            />
          ))
        )}
      </div>

      <div className="cheat-sheet-footer">
        <span className="cheat-sheet-hint">Hover a command for the full name and examples.</span>
        <button type="button" className="cheat-sheet-reset" onClick={resetDefaults}>
          Restore defaults
        </button>
      </div>

      {active ? (
        <CommandTooltip active={active} locked={locked} commands={commands} onClose={closeTooltip} />
      ) : null}
      {editor ? (
        <CommandEditor
          shell={shell}
          command={editor.mode === 'edit' ? editor.command : null}
          onCancel={closeEditor}
          onSave={saveEditor}
        />
      ) : null}
    </section>
  )
}

function CommandRow({
  entry,
  arming,
  lockMs,
  onHover,
  onLeave,
  onEdit,
  onDelete
}: {
  entry: CheatCommand
  arming: boolean
  lockMs: number
  onHover: (rect: DOMRect) => void
  onLeave: () => void
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      className="cheat-sheet-row"
      role="listitem"
      onMouseEnter={(event) => onHover(event.currentTarget.getBoundingClientRect())}
      onMouseLeave={onLeave}
    >
      <div className="cheat-sheet-row-main">
        <code className="cheat-sheet-command">{entry.name}</code>
        <span className="cheat-sheet-desc">{entry.description}</span>
      </div>
      {arming ? <LockRing lockMs={lockMs} /> : null}
      <div className="cheat-sheet-row-actions">
        {confirming ? (
          <>
            <button
              type="button"
              className="cheat-sheet-icon danger"
              onClick={() => {
                setConfirming(false)
                onDelete()
              }}
              aria-label={`Confirm delete ${entry.name}`}
              title="Delete"
            >
              ✓
            </button>
            <button
              type="button"
              className="cheat-sheet-icon"
              onClick={() => setConfirming(false)}
              aria-label="Cancel delete"
              title="Cancel"
            >
              ✕
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="cheat-sheet-icon"
              onClick={onEdit}
              aria-label={`Edit ${entry.name}`}
              title="Edit"
            >
              ✎
            </button>
            <button
              type="button"
              className="cheat-sheet-icon"
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${entry.name}`}
              title="Delete"
            >
              🗑
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// Circular countdown that fills over the lock window, so the pin delay is visible.
// CSS drives the fill; the duration is set inline to stay in sync with the timer.
function LockRing({ lockMs }: { lockMs: number }): JSX.Element {
  return (
    <svg className="cheat-sheet-lock-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="cheat-sheet-lock-ring-track" cx="10" cy="10" r="8" />
      <circle className="cheat-sheet-lock-ring-fill" cx="10" cy="10" r="8" style={{ animationDuration: `${lockMs}ms` }} />
    </svg>
  )
}

function CommandTooltip({
  active,
  locked,
  commands,
  onClose
}: {
  active: HoverState
  locked: boolean
  commands: CheatCommand[]
  onClose: () => void
}): JSX.Element {
  const { command, rect } = active
  const rootRef = useRef<HTMLDivElement>(null)
  const [sub, setSub] = useState<{ parts: ExamplePart[]; rect: DOMRect } | null>(null)

  // A breakdown only makes sense for the pinned command; drop it when the tooltip
  // unpins or switches to a different command.
  useEffect(() => {
    if (!locked) setSub(null)
  }, [locked])
  useEffect(() => {
    setSub(null)
  }, [command.id])

  // Once pinned, dismiss on Escape or a click outside the tooltip.
  useEffect(() => {
    if (!locked) return
    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [locked, onClose])

  const showBelow = rect.bottom < window.innerHeight - 260
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - 380))
  const style: CSSProperties = showBelow
    ? { left, top: rect.bottom + 6 }
    : { left, bottom: window.innerHeight - rect.top + 6 }

  return (
    <>
      <div ref={rootRef} className={`cheat-sheet-tooltip ${locked ? 'locked' : ''}`} style={style} role="tooltip">
        <div className="cheat-sheet-tooltip-head">
          <code className="cheat-sheet-tooltip-name">{command.name}</code>
          {command.fullName ? <span className="cheat-sheet-tooltip-full">{command.fullName}</span> : null}
          {locked ? (
            <button type="button" className="cheat-sheet-tooltip-close" onClick={onClose} aria-label="Unpin" title="Unpin">
              ✕
            </button>
          ) : null}
        </div>
        <p className="cheat-sheet-tooltip-desc">{command.description}</p>
        {command.examples.length ? (
          <div className="cheat-sheet-tooltip-examples">
            {command.examples.map((example, index) => (
              <code
                key={index}
                className="cheat-sheet-tooltip-example"
                onMouseEnter={(event) =>
                  locked && setSub({ parts: explainExample(example, command.shell, commands), rect: event.currentTarget.getBoundingClientRect() })
                }
                onMouseLeave={() => setSub(null)}
              >
                {example}
              </code>
            ))}
          </div>
        ) : null}
        <p className="cheat-sheet-tooltip-note">
          {locked ? 'Hover an example for a breakdown.' : 'Keep hovering to pin this.'}
        </p>
        {command.shell === 'powershell' && command.fullName ? (
          <p className="cheat-sheet-tooltip-note">In scripts, use the full cmdlet name.</p>
        ) : null}
      </div>
      {sub && sub.parts.length ? <ExampleBreakdown parts={sub.parts} anchor={sub.rect} /> : null}
    </>
  )
}

function ExampleBreakdown({ parts, anchor }: { parts: ExamplePart[]; anchor: DOMRect }): JSX.Element {
  const width = 320
  let left = anchor.right + 8
  if (left + width > window.innerWidth) left = Math.max(8, anchor.left - width - 8)
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 260))

  return (
    <div className="cheat-sheet-subtip" style={{ left, top, width }} role="tooltip">
      {parts.map((part, index) => (
        <div key={index} className="cheat-sheet-subtip-row">
          <code className="cheat-sheet-subtip-token">{part.text}</code>
          <span className="cheat-sheet-subtip-meaning">{part.meaning}</span>
        </div>
      ))}
    </div>
  )
}

function CommandEditor({
  shell,
  command,
  onCancel,
  onSave
}: {
  shell: CommandShell
  command: CheatCommand | null
  onCancel: () => void
  onSave: (draft: CheatCommandDraft) => void
}): JSX.Element {
  const [name, setName] = useState(command?.name ?? '')
  const [fullName, setFullName] = useState(command?.fullName ?? '')
  const [description, setDescription] = useState(command?.description ?? '')
  const [examples, setExamples] = useState((command?.examples ?? []).join('\n'))
  const [draftShell, setDraftShell] = useState<CommandShell>(command?.shell ?? shell)

  const canSave = name.trim().length > 0 && description.trim().length > 0

  const submit = (): void => {
    if (!canSave) return
    onSave({
      shell: draftShell,
      name: name.trim(),
      fullName: fullName.trim() || undefined,
      description: description.trim(),
      examples: examples
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    })
  }

  return (
    <div className="cheat-sheet-modal-backdrop" onMouseDown={onCancel}>
      <div
        className="cheat-sheet-modal"
        role="dialog"
        aria-label={command ? 'Edit command' : 'Add command'}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      >
        <h2>{command ? 'Edit command' : 'Add command'}</h2>

        <label className="cheat-sheet-field">
          <span>Command</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="ls" autoFocus />
        </label>

        <label className="cheat-sheet-field">
          <span>Full name / cmdlet (optional)</span>
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Get-ChildItem" />
        </label>

        <label className="cheat-sheet-field">
          <span>Description</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="List files and folders in a directory."
          />
        </label>

        <label className="cheat-sheet-field">
          <span>Examples (one per line)</span>
          <textarea
            rows={3}
            value={examples}
            onChange={(event) => setExamples(event.target.value)}
            placeholder={'ls\nls -Recurse -Filter *.ts'}
          />
        </label>

        <label className="cheat-sheet-field">
          <span>Shell</span>
          <select value={draftShell} onChange={(event) => setDraftShell(event.target.value as CommandShell)}>
            <option value="powershell">PowerShell</option>
            <option value="wsl">WSL · Ubuntu</option>
          </select>
        </label>

        <div className="cheat-sheet-modal-actions">
          <button type="button" className="cheat-sheet-modal-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="cheat-sheet-modal-save" disabled={!canSave} onClick={submit}>
            {command ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
