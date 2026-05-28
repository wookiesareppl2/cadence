import { app, BrowserWindow, ipcMain, screen, type Rectangle, type WebContentsConsoleMessageEventParams } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { closeAllTerminals, resizeTerminal, restartTerminal, startTerminal, writeTerminal } from './terminal/terminal-service'
import { closeClaudeUsageStore, refreshClaudeUsageSummary } from './usage/claude-usage-service'
import { fetchClaudePlanUsage } from './usage/claude-plan-usage-service'
import { fetchCodexPlanUsage } from './usage/codex-plan-usage-service'
import { getClaudeSessions, getCodexSessions } from './sessions/session-service'

let restoreBounds: Rectangle | null = null

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

function shouldForwardRendererConsole({ message, sourceId }: WebContentsConsoleMessageEventParams): boolean {
  if (sourceId.includes('/@vite/client') && message.startsWith('[vite] ')) return false
  if (message.includes('Download the React DevTools')) return false
  return true
}

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#1e1b19',
    title: 'AI Dashboard',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.on('console-message', (details) => {
    if (!shouldForwardRendererConsole(details)) return
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited', details)
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.ai-dashboard.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize-toggle', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    if (process.platform === 'linux') {
      if (restoreBounds) {
        window.setBounds(restoreBounds, true)
        restoreBounds = null
        return
      }

      restoreBounds = window.getBounds()
      window.setBounds(screen.getDisplayMatching(restoreBounds).workArea, true)
      return
    }

    if (window.isMaximized()) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('usage:claude-summary', () => refreshClaudeUsageSummary())
  ipcMain.handle('usage:claude-plan', () => fetchClaudePlanUsage())
  ipcMain.handle('usage:codex-plan', () => fetchCodexPlanUsage())
  ipcMain.handle('sessions:claude', () => getClaudeSessions())
  ipcMain.handle('sessions:codex', () => getCodexSessions())
  ipcMain.handle('terminal:start', (event, platform: string) => startTerminal(platform, event.sender))
  ipcMain.handle('terminal:restart', (event, platform: string) => restartTerminal(platform, event.sender))
  ipcMain.on('terminal:input', (_event, platform: string, data: string) => writeTerminal(platform, data))
  ipcMain.on('terminal:resize', (_event, platform: string, cols: number, rows: number) => {
    resizeTerminal(platform, cols, rows)
  })

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeAllTerminals()
  closeClaudeUsageStore()
})
