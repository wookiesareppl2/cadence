import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, screen, type BrowserWindow } from 'electron'
import { captureWindowState, parseWindowState, type PersistedWindowState } from './window-state-utils'

const WINDOW_STATE_WRITE_DELAY_MS = 250

function windowStatePath(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

export function readWindowState(): PersistedWindowState | null {
  try {
    return parseWindowState(readFileSync(windowStatePath(), 'utf-8'), screen.getAllDisplays())
  } catch {
    return null
  }
}

function writeWindowState(window: BrowserWindow): void {
  try {
    const path = windowStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(captureWindowState(window), null, 2)}\n`)
  } catch {
    // Window state is a convenience preference. Ignore filesystem failures.
  }
}

export function registerWindowStatePersistence(window: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null

  const clearPendingWrite = () => {
    if (!timer) return
    clearTimeout(timer)
    timer = null
  }

  const persistNow = () => {
    clearPendingWrite()
    if (!window.isDestroyed()) writeWindowState(window)
  }

  const persistSoon = () => {
    clearPendingWrite()
    timer = setTimeout(() => {
      timer = null
      if (!window.isDestroyed()) writeWindowState(window)
    }, WINDOW_STATE_WRITE_DELAY_MS)
  }

  window.on('resize', persistSoon)
  window.on('move', persistSoon)
  window.on('maximize', persistNow)
  window.on('unmaximize', persistNow)
  window.on('enter-full-screen', persistNow)
  window.on('leave-full-screen', persistNow)
  window.on('close', persistNow)
  window.on('closed', clearPendingWrite)
}
