import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { join } from 'node:path'
import { closeClaudeUsageStore, refreshClaudeUsageSummary } from './usage/claude-usage-service'

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
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeClaudeUsageStore()
})
