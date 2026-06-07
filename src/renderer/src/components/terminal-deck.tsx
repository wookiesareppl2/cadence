import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { TerminalPlatform, TerminalStartResult } from '@shared/terminal'

export type TerminalTab = {
  id: string
  title: string
  cwd: string | null
}

export type TerminalDeckState = {
  tabs: TerminalTab[]
  addTerminal: (cwd?: string | null, title?: string) => void
  closeTerminal: (id: string) => void
  resetTerminals: (cwd?: string | null, title?: string) => void
}

const TERMINAL_THEME = {
  background: '#191614',
  foreground: '#e7ded7',
  cursor: '#e07a5f',
  selectionBackground: '#3b322d',
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

function loadTabs(platform: TerminalPlatform): TerminalTab[] {
  try {
    const raw = window.localStorage.getItem(storageKey(platform))
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.every(isTerminalTab)) {
        // Terminals are only ever opened into a project folder, so restore just
        // the project-scoped tabs and drop any legacy directoryless (home) shell.
        return parsed
          .filter((tab): tab is TerminalTab => typeof tab.cwd === 'string' && tab.cwd.length > 0)
          .map((tab) => ({ id: tab.id, title: tab.title, cwd: tab.cwd }))
      }
    }
  } catch {
    // Corrupt or unavailable storage simply starts with no terminals.
  }
  return []
}

function nextDefaultTitle(tabs: TerminalTab[]): string {
  const used = tabs
    .map((tab) => tab.title.match(/^Terminal (\d+)$/)?.[1])
    .map((value) => (value ? Number.parseInt(value, 10) : 0))
  const max = used.length ? Math.max(...used, 0) : 0
  return `Terminal ${max + 1}`
}

// Terminal tabs are persisted so a renderer reload restores the same ids — the
// worker keeps each pty alive across reloads, so restoring the id reconnects to
// the live shell (with its scrollback) instead of orphaning it.
export function useTerminalDeck(platform: TerminalPlatform): TerminalDeckState {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => loadTabs(platform))
  const tabsRef = useRef(tabs)

  useEffect(() => {
    tabsRef.current = tabs
    try {
      window.localStorage.setItem(storageKey(platform), JSON.stringify(tabs))
    } catch {
      // Persistence is best-effort; ignore quota/availability failures.
    }
  }, [platform, tabs])

  const addTerminal = useCallback(
    (cwd?: string | null, title?: string) => {
      setTabs((prev) => [
        ...prev,
        { id: makeTerminalId(platform), title: title?.trim() || nextDefaultTitle(prev), cwd: cwd ?? null }
      ])
    },
    [platform]
  )

  const closeTerminal = useCallback((id: string) => {
    window.dashboard?.terminal?.close(id)
    setTabs((prev) => prev.filter((tab) => tab.id !== id))
  }, [])

  // Starting a fresh session wipes the working set back to a single new shell —
  // every prior terminal (and its pty) is closed so nothing from the old session
  // bleeds into the new one.
  const resetTerminals = useCallback(
    (cwd?: string | null, title?: string) => {
      for (const tab of tabsRef.current) window.dashboard?.terminal?.close(tab.id)
      setTabs([{ id: makeTerminalId(platform), title: title?.trim() || 'Terminal 1', cwd: cwd ?? null }])
    },
    [platform]
  )

  return { tabs, addTerminal, closeTerminal, resetTerminals }
}

export function TerminalDeck({
  platform,
  tabs,
  defaultCwd,
  projectName,
  statusLabel,
  onAdd,
  onClose
}: {
  platform: TerminalPlatform
  tabs: TerminalTab[]
  defaultCwd: string | null
  projectName?: string | null
  statusLabel: string
  onAdd: (cwd?: string | null, title?: string) => void
  onClose: (id: string) => void
}): JSX.Element {
  return (
    <section className="panel terminal-panel" aria-label={`${platform} terminals`}>
      <div className="panel-header terminal-deck-bar">
        <div className="terminal-deck-heading">
          <h1>{platform === 'claude' ? 'Claude Terminals' : 'Codex Terminals'}</h1>
          <span>{tabs.length === 1 ? '1 terminal' : `${tabs.length} terminals`}</span>
        </div>
        <div className="terminal-actions">
          <span className="status-pill">{statusLabel}</span>
          <button
            type="button"
            className="terminal-action"
            onClick={() => onAdd(defaultCwd)}
            disabled={!defaultCwd}
            title={
              defaultCwd
                ? `Open a new terminal in ${defaultCwd}`
                : 'Select a project to open a terminal'
            }
          >
            + Add terminal
          </button>
        </div>
      </div>
      {tabs.length === 0 ? (
        <div className="terminal-empty">
          {defaultCwd ? (
            <>
              <span>No terminal open for {projectName ?? 'this project'}.</span>
              <button type="button" className="terminal-action" onClick={() => onAdd(defaultCwd)}>
                Open terminal in {projectName ?? 'project'}
              </button>
            </>
          ) : (
            <span>Select a project to open a terminal.</span>
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
              title={tab.title}
              onClose={() => onClose(tab.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function TerminalPane({
  terminalId,
  platform,
  cwd,
  title,
  onClose
}: {
  terminalId: string
  platform: TerminalPlatform
  cwd: string | null
  title: string
  onClose: () => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [session, setSession] = useState<TerminalStartResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fitTerminal = useCallback(() => {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    const host = hostRef.current
    if (!terminal || !fitAddon || !host) return
    // A tile that is momentarily zero-sized (e.g. mid-reflow) can't be fitted.
    if (host.clientWidth === 0 || host.clientHeight === 0) return

    fitAddon.fit()
    window.dashboard.terminal.resize(terminalId, terminal.cols, terminal.rows)
  }, [terminalId])

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

  useEffect(() => {
    if (!hostRef.current) return

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
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

    const dataDisposable = terminal.onData((data) => window.dashboard.terminal.input(terminalId, data))
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      window.dashboard.terminal.resize(terminalId, cols, rows)
    })
    const removeDataListener = window.dashboard.terminal.onData((event) => {
      if (event.terminalId === terminalId) terminal.write(event.data)
    })
    const observer = new ResizeObserver(() => window.requestAnimationFrame(fitTerminal))

    observer.observe(hostRef.current)
    window.requestAnimationFrame(fitTerminal)
    window.dashboard.terminal
      .start(terminalId, platform, cwd ?? undefined)
      .then((result) => {
        setSession(result)
        if (result.replay) terminal.write(result.replay)
        fitTerminal()
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Terminal failed to start')
      })

    return () => {
      observer.disconnect()
      removeDataListener()
      dataDisposable.dispose()
      resizeDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [terminalId, platform, cwd, fitTerminal])

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
