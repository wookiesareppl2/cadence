import { app, BrowserWindow, ipcMain, screen, type Rectangle, type WebContentsConsoleMessageEventParams } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import {
  closeAllTerminals,
  closeTerminal,
  resizeTerminal,
  restartTerminal,
  startTerminal,
  writeTerminal
} from './terminal/terminal-service'
import { closeClaudeUsageStore, refreshClaudeUsageSummary } from './usage/claude-usage-service'
import { getCachedClaudePlanUsage, getCachedCodexPlanUsage } from './usage/usage-plan-cache'
import { notifyUsageThresholds } from './usage/usage-alerts'
import { getClaudeSessions, getCodexSessions, getSessionHistory } from './sessions/session-service'
import {
  getSessionMetadata,
  setProjectAlias,
  setSessionAlias
} from './sessions/session-metadata-service'
import { deleteProject, deleteSession } from './sessions/session-delete-service'
import { attachWorkspace, listWorkspaces } from './workspaces/workspace-service'
import { initAutoUpdates } from './updater'
import type { PlatformId } from '@shared/platform'

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

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('usage:claude-summary', () => refreshClaudeUsageSummary())
  ipcMain.handle('usage:claude-plan', async () => {
    const usage = await getCachedClaudePlanUsage()
    notifyUsageThresholds('claude', usage.fiveHour, usage.sevenDay)
    return usage
  })
  ipcMain.handle('usage:codex-plan', async () => {
    const usage = await getCachedCodexPlanUsage()
    notifyUsageThresholds('codex', usage.fiveHour, usage.sevenDay)
    return usage
  })
  ipcMain.handle('sessions:claude', () => getClaudeSessions())
  ipcMain.handle('sessions:codex', () => getCodexSessions())
  ipcMain.handle('sessions:history', (_event, platform: PlatformId, sessionId: string) => getSessionHistory(platform, sessionId))
  ipcMain.handle('sessions:metadata', () => getSessionMetadata())
  ipcMain.handle('sessions:set-project-alias', (_event, projectId: string, name: string | null) =>
    setProjectAlias(projectId, name)
  )
  ipcMain.handle('sessions:set-session-alias', (_event, platform: PlatformId, sessionId: string, title: string | null) =>
    setSessionAlias(platform, sessionId, title)
  )
  ipcMain.handle('sessions:delete-session', (_event, platform: PlatformId, sessionId: string) =>
    deleteSession(platform, sessionId)
  )
  ipcMain.handle('sessions:delete-project', (_event, platform: PlatformId, projectId: string) =>
    deleteProject(platform, projectId)
  )
  ipcMain.handle('workspaces:list', () => listWorkspaces())
  ipcMain.handle('workspaces:attach', (event) => attachWorkspace(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('terminal:start', (event, terminalId: string, platform: string, cwd?: string) =>
    startTerminal(terminalId, platform, event.sender, cwd)
  )
  ipcMain.handle('terminal:restart', (event, terminalId: string) => restartTerminal(terminalId, event.sender))
  ipcMain.on('terminal:input', (_event, terminalId: string, data: string) => writeTerminal(terminalId, data))
  ipcMain.on('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    resizeTerminal(terminalId, cols, rows)
  })
  ipcMain.on('terminal:close', (_event, terminalId: string) => closeTerminal(terminalId))

  createMainWindow()

  // Background auto-update — only meaningful in a packaged build.
  if (app.isPackaged) initAutoUpdates()

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
