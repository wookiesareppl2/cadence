import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, JSX } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { FileRequest } from '@shared/project-files'
import { findFilePathCandidates, offsetToCell } from '@shared/terminal-links'
import { backgroundTerminalSessions, restorableTabs } from '@shared/terminal'
import type { TerminalBackgroundLocation, TerminalPlatform, TerminalStartResult, TerminalTab } from '@shared/terminal'

export type { TerminalTab } from '@shared/terminal'

export type TerminalDeckState = {
  tabs: TerminalTab[]
  addTerminal: (
    sessionKey: string,
    cwd?: string | null,
    title?: string,
    wslDistro?: string | null,
    initialInput?: string | null
  ) => void
  closeTerminal: (id: string) => void
  // Re-point a started session's terminals from their pending id onto the real
  // session id once the transcript is discovered, so they follow the session.
  retagSession: (fromSessionKey: string, toSessionKey: string) => void
}

const TERMINAL_THEME = {
  background: '#191614',
  foreground: '#e7ded7',
  // Keep the cursor visible without using the accent block, which flickers as
  // Codex rewrites animated status lines.
  cursor: '#cbbdb4',
  // A clearly visible translucent highlight (the old near-black #3b322d was almost
  // invisible against the terminal background, so drag-selection looked broken).
  // Translucent keeps the selected text readable on top.
  selectionBackground: 'rgba(224, 122, 95, 0.40)',
  selectionInactiveBackground: 'rgba(224, 122, 95, 0.26)',
  black: '#1e1b19',
  blue: '#7aa2d6',
  brightBlack: '#5e544d',
  brightBlue: '#9dc1ee',
  brightCyan: '#9ad7d4',
  brightGreen: '#a7cbb8',
  brightMagenta: '#d7a8c7',
  brightRed: '#e07a5f',
  brightWhite: '#f2ebe6',
  brightYellow: '#e2c178',
  cyan: '#81bfc0',
  green: '#81b29a',
  magenta: '#c793b7',
  red: '#c95f4c',
  white: '#e7ded7',
  yellow: '#d5aa5f'
}

// Codex on native Windows reads console INPUT_RECORD key events (via crossterm),
// not raw VT bytes, so neither a raw LF (Ctrl+J) nor CSI-u reaches it as a key
// event through ConPTY. The protocol ConPTY understands is win32-input-mode:
// ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ . We inject a Shift+Enter key-down then
// key-up (Vk=13 VK_RETURN, Sc=28, Uc=13, Cs=16 SHIFT_PRESSED), which ConPTY turns
// into a real Shift+Enter event that Codex maps to insert_newline.
const CODEX_PROMPT_NEWLINE = '\x1b[13;28;13;1;16_\x1b[13;28;13;0;16_'

// Claude Code (Node/Ink) submits on Enter; it inserts a newline when it receives
// Meta+Enter as ESC+CR ("\x1b\r") — the same sequence its /terminal-setup writes
// for Shift+Enter. Unlike Codex it reads a byte stream (via libuv), so a raw escape
// sequence works where a win32-input key record would be collapsed to a bare CR.
const CLAUDE_PROMPT_NEWLINE = '\x1b\r'

// The prompt-newline shortcut differs per CLI: Codex uses Shift+Enter, Claude uses
// Ctrl+Enter. Returns the bytes to inject for a newline, or null if the keydown is
// not a newline shortcut (so Enter and everything else fall through unchanged).
function promptNewlineSequence(platform: TerminalPlatform, event: KeyboardEvent): string | null {
  if (event.key !== 'Enter' || event.altKey || event.metaKey) return null
  if (platform === 'codex' && event.shiftKey && !event.ctrlKey) return CODEX_PROMPT_NEWLINE
  if (platform === 'claude' && event.ctrlKey && !event.shiftKey) return CLAUDE_PROMPT_NEWLINE
  return null
}

function storageKey(platform: TerminalPlatform): string {
  return `terminal-deck:${platform}`
}

function makeTerminalId(platform: TerminalPlatform): string {
  return `${platform}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isTerminalTab(value: unknown): value is TerminalTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TerminalTab).id === 'string' &&
    typeof (value as TerminalTab).title === 'string'
  )
}

// keepPending distinguishes a fresh app launch (drop unadopted pending tabs, which
// are transient) from a within-run remount such as a platform switch (keep them, so
// a brand-new session's live terminal isn't discarded before it can be adopted).
function parseStoredTabs(raw: string | null, keepPending: boolean): TerminalTab[] {
  try {
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isTerminalTab)) {
        return restorableTabs(parsed, { keepPending })
      }
    }
  } catch {
    // Corrupt or unavailable storage simply starts with no terminals.
  }
  return []
}

function loadTabs(platform: TerminalPlatform, keepPending: boolean): TerminalTab[] {
  return parseStoredTabs(window.localStorage.getItem(storageKey(platform)), keepPending)
}

function sameTabs(a: TerminalTab[], b: TerminalTab[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// Number a new terminal within its own session so every session's deck starts at
// "Terminal 1" (callers pass the tabs already filtered to that session).
function nextDefaultTitle(tabs: TerminalTab[]): string {
  const used = tabs
    .map((tab) => tab.title.match(/^Terminal (\d+)$/)?.[1])
    .map((value) => (value ? Number.parseInt(value, 10) : 0))
  const max = used.length ? Math.max(...used, 0) : 0
  return `Terminal ${max + 1}`
}

// Tracks which platform decks have already mounted in this app run. The first mount
// of a run drops pending-keyed tabs (an unadopted pending session is transient and
// is not re-adopted after a restart); a later remount within the same run — e.g. a
// platform switch, which unmounts the inactive workspace — keeps them so a brand-new
// session's live terminal survives the switch and can still be adopted. A renderer
// reload starts a fresh run and clears this, restoring restart semantics.
const deckMountedPlatforms = new Set<TerminalPlatform>()

// Terminal tabs are persisted so a renderer reload restores the same ids — the
// worker keeps each pty alive across reloads, so restoring the id reconnects to
// the live shell (with its scrollback) instead of orphaning it.
export function useTerminalDeck(platform: TerminalPlatform): TerminalDeckState {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => loadTabs(platform, deckMountedPlatforms.has(platform)))

  // Recorded after commit (never during render) so it is robust to double-invoked
  // initializers; left set on unmount so the next remount is treated as a remount.
  useEffect(() => {
    deckMountedPlatforms.add(platform)
  }, [platform])

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey(platform), JSON.stringify(tabs))
    } catch {
      // Persistence is best-effort; ignore quota/availability failures.
    }
  }, [platform, tabs])

  useEffect(() => {
    const key = storageKey(platform)
    const handleStorage = (event: StorageEvent): void => {
      if (event.storageArea !== window.localStorage || event.key !== key) return
      // A storage event only fires from another live window in the same run, so keep
      // pending tabs to stay in sync with that window rather than dropping them.
      const next = parseStoredTabs(event.newValue, true)
      setTabs((current) => (sameTabs(current, next) ? current : next))
    }

    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [platform])

  const addTerminal = useCallback(
    (
      sessionKey: string,
      cwd?: string | null,
      title?: string,
      wslDistro?: string | null,
      initialInput?: string | null
    ) => {
      setTabs((prev) => [
        ...prev,
        {
          id: makeTerminalId(platform),
          title: title?.trim() || nextDefaultTitle(prev.filter((tab) => tab.sessionKey === sessionKey)),
          cwd: cwd ?? null,
          sessionKey,
          wslDistro: wslDistro ?? null,
          initialInput: initialInput ?? null
        }
      ])
    },
    [platform]
  )

  const closeTerminal = useCallback((id: string) => {
    window.dashboard?.terminal?.close(id)
    setTabs((prev) => prev.filter((tab) => tab.id !== id))
  }, [])

  // Adoption: when a started session's transcript is discovered, its terminals are
  // moved from the pending key onto the real session id so they keep following it.
  // The ptys are keyed by terminal id and untouched — only the scoping tag changes.
  const retagSession = useCallback((fromSessionKey: string, toSessionKey: string) => {
    setTabs((prev) =>
      prev.some((tab) => tab.sessionKey === fromSessionKey)
        ? prev.map((tab) => (tab.sessionKey === fromSessionKey ? { ...tab, sessionKey: toSessionKey } : tab))
        : prev
    )
  }, [])

  return { tabs, addTerminal, closeTerminal, retagSession }
}

// xterm hands a link provider one buffer row at a time, but a long path wider
// than the terminal wraps onto several rows. Rebuild the full logical line by
// joining wrapped continuation rows so the path is detected as one token; the
// returned startRow + cols let the caller map character offsets back to cells
// (each wrapped row is exactly `cols` wide).
const MAX_WRAP_ROWS = 64
type LogicalLine = { text: string; startRow: number; cols: number }
function readLogicalLine(terminal: Terminal, bufferLineNumber: number): LogicalLine {
  const buffer = terminal.buffer.active
  const cols = Math.max(1, terminal.cols)
  let startRow = bufferLineNumber - 1
  while (startRow > 0 && buffer.getLine(startRow)?.isWrapped) startRow -= 1
  let text = ''
  for (let row = startRow; row < startRow + MAX_WRAP_ROWS; row += 1) {
    const line = buffer.getLine(row)
    if (!line) break
    text += line.translateToString(false)
    const next = buffer.getLine(row + 1)
    if (!next || !next.isWrapped) break
  }
  return { text, startRow, cols }
}

function fitAndRestoreViewport(terminal: Terminal, fitAddon: FitAddon): void {
  const { baseY, viewportY } = terminal.buffer.active
  const wasAtBottom = viewportY >= baseY

  fitAddon.fit()

  if (wasAtBottom) {
    terminal.scrollToBottom()
    return
  }

  terminal.scrollToLine(Math.min(viewportY, terminal.buffer.active.baseY))
}

export const TerminalDeck = memo(function TerminalDeck({
  platform,
  tabs,
  defaultCwd,
  defaultWslDistro,
  projectName,
  loading = false,
  backgroundTabCount = 0,
  backgroundSessionCount = 0,
  backgroundTerminals = [],
  onAdd,
  onClose,
  onSelectBackgroundTerminal,
  onOpenFile,
  onDetach
}: {
  platform: TerminalPlatform
  tabs: TerminalTab[]
  defaultCwd: string | null
  defaultWslDistro?: string | null
  projectName?: string | null
  // Open a file the user clicked inside a terminal session (a path the AI agent
  // printed) in a preview surface owned by the host window, optionally scrolled
  // to a 1-based line parsed from a `file.ts:42` mention.
  onOpenFile?: (request: FileRequest, line?: number) => void
  // The active project is still being resolved (e.g. a freshly opened detached
  // window scanning sessions). Distinguishes "loading" from "no project picked"
  // so the add control doesn't wrongly tell the user to select a project.
  loading?: boolean
  // Live terminals that belong to other sessions: kept running in the background
  // and surfaced here so they aren't silently lost while hidden.
  backgroundTabCount?: number
  backgroundSessionCount?: number
  backgroundTerminals?: TerminalBackgroundLocation[]
  onSelectBackgroundTerminal?: (terminal: TerminalBackgroundLocation) => void
  onAdd: (cwd?: string | null, title?: string, wslDistro?: string | null) => void
  onClose: (id: string) => void
  onDetach?: () => void
}): JSX.Element {
  const [backgroundMenuOpen, setBackgroundMenuOpen] = useState(false)
  const [backgroundButtonRect, setBackgroundButtonRect] = useState<DOMRect | null>(null)
  const backgroundButtonRef = useRef<HTMLButtonElement>(null)
  const noProjectLabel = loading ? 'Loading project…' : 'Select a project to open a terminal'
  const backgroundCount = backgroundTerminals.length || backgroundTabCount
  // One row per session, not per terminal: every terminal in a session jumps to
  // the same place, so the locator groups them and shows a per-session count.
  const backgroundSessions = useMemo(
    () => backgroundTerminalSessions(backgroundTerminals),
    [backgroundTerminals]
  )
  const backgroundNote =
    backgroundCount > 0
      ? `${backgroundCount} ${backgroundCount === 1 ? 'terminal' : 'terminals'} running in ` +
        `${backgroundSessionCount} other ${backgroundSessionCount === 1 ? 'session' : 'sessions'}`
      : null
  const backgroundMenuStyle = useMemo<CSSProperties | undefined>(() => {
    if (!backgroundButtonRect) return undefined
    const width = Math.min(520, Math.max(360, window.innerWidth - 16))
    return {
      top: backgroundButtonRect.bottom + 6,
      left: Math.max(8, Math.min(backgroundButtonRect.left, window.innerWidth - width - 8)),
      width
    }
  }, [backgroundButtonRect])

  useLayoutEffect(() => {
    if (!backgroundMenuOpen) return
    const update = (): void => {
      if (backgroundButtonRef.current) setBackgroundButtonRect(backgroundButtonRef.current.getBoundingClientRect())
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [backgroundMenuOpen])

  useEffect(() => {
    if (!backgroundMenuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (
        backgroundButtonRef.current?.contains(target) ||
        (target instanceof Element && target.closest('.terminal-bg-menu'))
      ) {
        return
      }
      setBackgroundMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setBackgroundMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [backgroundMenuOpen])

  return (
    <section className="panel terminal-panel" aria-label={`${platform} terminals`}>
      <div className="panel-header terminal-deck-bar">
        <div className="terminal-deck-heading">
          <h1>{platform === 'claude' ? 'Claude Terminals' : 'Codex Terminals'}</h1>
          <span>{tabs.length === 1 ? '1 terminal' : `${tabs.length} terminals`}</span>
          {backgroundNote ? (
            <button
              ref={backgroundButtonRef}
              type="button"
              className="terminal-bg-note"
              aria-expanded={backgroundMenuOpen}
              onClick={() => setBackgroundMenuOpen((open) => !open)}
              title="Show background terminals"
            >
              · {backgroundNote}
            </button>
          ) : null}
        </div>
        <div className="terminal-actions">
          {onDetach ? (
            <button type="button" className="terminal-action" onClick={onDetach} title="Detach terminals to a separate window">
              Detach
            </button>
          ) : null}
          <button
            type="button"
            className="terminal-action"
            onClick={() => onAdd(defaultCwd, undefined, defaultWslDistro)}
            disabled={!defaultCwd}
            title={defaultCwd ? `Open a new terminal in ${defaultCwd}` : noProjectLabel}
          >
            + Add terminal
          </button>
        </div>
      </div>
      {backgroundMenuOpen && backgroundNote ? (
        <div className="terminal-bg-menu" style={backgroundMenuStyle} role="menu" aria-label="Background terminals">
          <div className="terminal-bg-menu-head">{backgroundNote}</div>
          {backgroundSessions.length > 0 ? (
            backgroundSessions.map((session) => {
              const location = session.cwd ?? session.projectPath ?? 'No working directory'
              const selectable = Boolean(session.projectId)
              const countLabel = `${session.terminalCount} ${session.terminalCount === 1 ? 'terminal' : 'terminals'}`
              return (
                <button
                  key={session.sessionKey}
                  type="button"
                  role="menuitem"
                  className="terminal-bg-row"
                  disabled={!selectable}
                  onClick={() => {
                    if (!selectable) return
                    onSelectBackgroundTerminal?.(session.terminals[0])
                    setBackgroundMenuOpen(false)
                  }}
                  title={location}
                >
                  <span className="terminal-bg-row-main">
                    <span className="terminal-bg-row-title">{session.sessionTitle}</span>
                    <span className="terminal-bg-row-context">
                      {session.projectName} · {countLabel}
                    </span>
                  </span>
                  <span className="terminal-bg-row-cwd">{location}</span>
                </button>
              )
            })
          ) : (
            <div className="terminal-bg-empty">Background terminal details unavailable.</div>
          )}
        </div>
      ) : null}
      {tabs.length === 0 ? (
        <div className="terminal-empty">
          {defaultCwd ? (
            <>
              <span>No terminal open for {projectName ?? 'this project'}.</span>
              <button
                type="button"
                className="terminal-action"
                onClick={() => onAdd(defaultCwd, undefined, defaultWslDistro)}
              >
                Open terminal in {projectName ?? 'project'}
              </button>
            </>
          ) : (
            <span>{noProjectLabel}.</span>
          )}
        </div>
      ) : (
        <div className="terminal-grid" data-count={tabs.length}>
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              terminalId={tab.id}
              platform={platform}
              cwd={tab.cwd}
              wslDistro={tab.wslDistro ?? null}
              initialInput={tab.initialInput ?? undefined}
              title={tab.title}
              onClose={() => onClose(tab.id)}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </section>
  )
})

export function TerminalPane({
  terminalId,
  platform,
  cwd,
  wslDistro,
  title,
  onClose,
  onOpenFile,
  initialInput
}: {
  terminalId: string
  platform: TerminalPlatform
  cwd: string | null
  wslDistro: string | null
  title: string
  onClose: () => void
  onOpenFile?: (request: FileRequest, line?: number) => void
  // Optional command auto-typed into the shell once it's ready (onboarding runs the
  // install / sign-in command this way). Sent only on a fresh start, never on a
  // reconnect that replays existing scrollback.
  initialInput?: string
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const resizeFitTimerRef = useRef<number | null>(null)
  const [session, setSession] = useState<TerminalStartResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Held in a ref so the (re)render-unstable callback never forces the terminal
  // open effect to re-run, which would tear down and respawn the pty.
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile

  // Held in a ref so the command can't retrigger the terminal open effect.
  const initialInputRef = useRef(initialInput)
  initialInputRef.current = initialInput

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    const host = hostRef.current
    if (!terminal || !fitAddon || !host) return
    // A tile that is momentarily zero-sized (e.g. mid-reflow) can't be fitted.
    if (host.clientWidth === 0 || host.clientHeight === 0) return

    fitAndRestoreViewport(terminal, fitAddon)
    window.dashboard.terminal.resize(terminalId, terminal.cols, terminal.rows)
  }, [terminalId])

  const scheduleResizeFit = useCallback(() => {
    if (resizeFitTimerRef.current !== null) {
      window.clearTimeout(resizeFitTimerRef.current)
    }

    resizeFitTimerRef.current = window.setTimeout(() => {
      resizeFitTimerRef.current = null
      window.requestAnimationFrame(fitTerminal)
    }, 70)
  }, [fitTerminal])

  const restartTerminal = useCallback(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.clear()
    setError(null)
    window.dashboard.terminal
      .restart(terminalId)
      .then((result) => {
        setSession(result)
        if (result.replay) terminal.write(result.replay)
        fitTerminal()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Terminal restart failed')
      })
  }, [fitTerminal, terminalId])

  const pasteClipboardText = useCallback(async () => {
    // Clipboard reads are async now (routed through the main process for sandboxing).
    const text = await window.dashboard.clipboard.readText()
    const terminal = terminalRef.current
    if (!terminal || text.length === 0) return

    terminal.paste(text)
  }, [])

  const copySelection = useCallback((): boolean => {
    const terminal = terminalRef.current
    if (!terminal || !terminal.hasSelection()) return false
    const selected = terminal.getSelection()
    if (!selected) return false
    window.dashboard.clipboard.writeText(selected)
    return true
  }, [])

  useEffect(() => {
    if (!hostRef.current) return

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: false,
      cursorInactiveStyle: 'none',
      cursorStyle: 'bar',
      cursorWidth: 1,
      fontFamily: '"Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      scrollback: 6000,
      theme: TERMINAL_THEME
    })
    const fitAddon = new FitAddon()

    terminal.loadAddon(fitAddon)
    terminal.open(hostRef.current)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      const promptNewline = promptNewlineSequence(platform, event)
      if (promptNewline !== null) {
        event.preventDefault()
        window.dashboard.terminal.input(terminalId, promptNewline)
        return false
      }

      const key = event.key.toLowerCase()
      const isPasteShortcut =
        ((event.ctrlKey || event.metaKey) && key === 'v') || (event.shiftKey && event.key === 'Insert')
      if (isPasteShortcut) {
        event.preventDefault()
        void pasteClipboardText()
        return false
      }

      // Copy on Ctrl+C when a selection exists; otherwise let Ctrl+C reach the
      // shell as SIGINT. Ctrl+Shift+C / Cmd+C keep working as explicit copy.
      const isCopyShortcut =
        (event.metaKey || (event.ctrlKey && (event.shiftKey || terminal.hasSelection()))) && key === 'c'
      if (isCopyShortcut && copySelection()) {
        event.preventDefault()
        return false
      }

      return true
    })

    const dataDisposable = terminal.onData((data) => window.dashboard.terminal.input(terminalId, data))
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      window.dashboard.terminal.resize(terminalId, cols, rows)
    })
    const removeDataListener = window.dashboard.terminal.onData((event) => {
      if (event.terminalId === terminalId) terminal.write(event.data)
    })
    // Make file paths the AI agent prints clickable: detect path-like tokens on
    // the hovered line, confirm each is a real file under the project root, and
    // open the preview on click. cwd is the terminal's project root.
    const linkProvider = terminal.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const root = cwd
        if (!root) {
          callback(undefined)
          return
        }
        const { text, startRow, cols } = readLogicalLine(terminal, bufferLineNumber)
        const candidates = findFilePathCandidates(text)
        if (candidates.length === 0) {
          callback(undefined)
          return
        }
        Promise.all(
          candidates.map(async (candidate) => {
            const request: FileRequest = { rootPath: root, distro: wslDistro, relPath: candidate.relPath }
            try {
              const result = await window.dashboard.projectFiles.exists(request)
              return result.exists && result.kind === 'file' ? { candidate, request } : null
            } catch {
              return null
            }
          })
        )
          .then((resolved) => {
            const links = resolved.flatMap((entry) => {
              if (entry === null) return []
              const { candidate, request } = entry
              // Map the offsets within the joined line back to (col, row) cells.
              // A range may span rows when the path crosses a wrap boundary.
              return [
                {
                  text: text.slice(candidate.start, candidate.end),
                  range: {
                    start: offsetToCell(candidate.start, cols, startRow),
                    end: offsetToCell(candidate.end - 1, cols, startRow)
                  },
                  decorations: { pointerCursor: true, underline: true },
                  activate: () => onOpenFileRef.current?.(request, candidate.line ?? undefined)
                }
              ]
            })
            callback(links.length > 0 ? links : undefined)
          })
          .catch(() => callback(undefined))
      }
    })

    const observer = new ResizeObserver(scheduleResizeFit)

    // Copying is explicit only (Ctrl+Shift+C, or Ctrl+C with a selection) — there
    // is deliberately no copy-on-select. Under the CLI fullscreen renderers a
    // drag-selection is a meaningful in-app gesture (e.g. select-to-delete), so
    // auto-copying every selection would silently clobber the user's clipboard.

    observer.observe(hostRef.current)
    window.requestAnimationFrame(fitTerminal)
    window.dashboard.terminal
      .start(terminalId, platform, cwd ?? undefined, wslDistro ?? undefined)
      .then((result) => {
        setSession(result)
        if (result.replay) terminal.write(result.replay)
        fitTerminal()
        // Auto-run the onboarding command on a fresh shell (no replayed scrollback
        // means this pty wasn't already running the command before a reload).
        if (initialInputRef.current && !result.replay) {
          window.dashboard.terminal.input(terminalId, `${initialInputRef.current}\r`)
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Terminal failed to start')
      })

    return () => {
      observer.disconnect()
      if (resizeFitTimerRef.current !== null) {
        window.clearTimeout(resizeFitTimerRef.current)
        resizeFitTimerRef.current = null
      }
      linkProvider.dispose()
      removeDataListener()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalId, platform, cwd, wslDistro, fitTerminal, scheduleResizeFit, pasteClipboardText, copySelection])

  const shellLabel = session ? `${session.shell} pid ${session.pid}` : 'starting'

  return (
    <div className="terminal-tile">
      <div className="panel-header terminal-header">
        <div className="terminal-heading">
          <h1>{title}</h1>
          <span>{shellLabel}</span>
        </div>
        <div className="terminal-actions">
          <span className="status-pill">{error ? 'error' : session ? 'ready' : 'starting'}</span>
          <button type="button" className="terminal-action" onClick={restartTerminal}>
            Restart
          </button>
          <button type="button" className="terminal-action terminal-close" onClick={onClose} aria-label={`Close ${title}`}>
            ✕
          </button>
        </div>
      </div>
      {error ? <div className="terminal-error">{error}</div> : null}
      <div ref={hostRef} className="terminal-surface" aria-label={title} />
    </div>
  )
}
