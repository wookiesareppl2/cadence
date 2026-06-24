import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session, type Rectangle, type WebContentsConsoleMessageEventParams } from 'electron'
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
import { getSessionHistory } from './sessions/session-service'
import { invalidateSessionCache, scanSessions } from './sessions/session-scan'
import { getSessionTitleGenerationStatus } from './sessions/session-title-generation-service'
import {
  getSessionMetadata,
  setProjectAlias,
  setSessionAlias
} from './sessions/session-metadata-service'
import { deleteProject, deleteSession } from './sessions/session-delete-service'
import { getProjectWorkspace, saveProjectWorkspace } from './projects/project-workspace-service'
import {
  createEntry,
  deleteEntry,
  listDirectory,
  openExternally,
  readFilePreview,
  renameEntry,
  revealInExplorer,
  statProjectFile
} from './projects/project-files-service'
import { unwatchProjectFiles, watchProjectFiles } from './projects/project-file-watch-service'
import type { FileKind, FileRequest, ProjectFileWatchRequest } from '@shared/project-files'
import { attachWorkspace, listWorkspaces } from './workspaces/workspace-service'
import {
  chooseGithubImportDirectory,
  importGithubProject,
  syncProjectContextToVault
} from './github/github-import-service'
import {
  getGitHubAuthStatus,
  listGitHubRepositories,
  openGitHubDevicePage,
  pollGitHubDeviceFlow,
  signOutGitHub,
  startGitHubDeviceFlow
} from './github/github-auth-service'
import { searchWorkspace } from './search/search-service'
import type { SearchQuery } from '@shared/search'
import { getProjectMemory, readMemoryFile, writeMemoryFile } from './memory/memory-service'
import { disconnectPlatform, getSetupCommand, getSetupStatus } from './setup/setup-service'
import type { SetupAction } from '@shared/setup'
import type { GitHubContextSyncRequest, GitHubImportRequest } from '@shared/github-import'
import { initAutoUpdates } from './updater'
import { DEFAULT_WINDOW_BOUNDS } from './window-state-utils'
import { readWindowState, registerWindowStatePersistence } from './window-state'
import { PLATFORM_CONFIG, type PlatformId } from '@shared/platform'
import { APP_NAME } from '@shared/brand'
import {
  TERMINAL_DETACHED_CLOSED_CHANNEL,
  type TerminalDetachedEvent
} from '@shared/terminal'

let restoreBounds: Rectangle | null = null
const UI_ZOOM_FACTOR = 1.1
let dashboardWindow: BrowserWindow | null = null
const detachedTerminalWindows: Partial<Record<PlatformId, BrowserWindow>> = {}
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
}

if (!hasSingleInstanceLock) {
  app.quit()
}

function shouldForwardRendererConsole({ message, sourceId }: WebContentsConsoleMessageEventParams): boolean {
  if (sourceId.includes('/@vite/client') && message.startsWith('[vite] ')) return false
  if (message.includes('Download the React DevTools')) return false
  return true
}

function createMainWindow(): BrowserWindow {
  const savedWindowState = readWindowState()
  const initialBounds = savedWindowState?.bounds ?? DEFAULT_WINDOW_BOUNDS
  // Scale the whole UI up a notch so text reads comfortably. A browser-level zoom
  // keeps everything proportional and, unlike CSS zoom, leaves JS-positioned
  // overlays (tooltips, context menus) correctly placed.
  const mainWindow = new BrowserWindow({
    ...initialBounds,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    frame: false,
    backgroundColor: '#1e1b19',
    title: APP_NAME,
    // Packaged builds get the icon from electron-builder (build/icon.ico embedded in
    // the exe). In dev there's no packaged exe, so point the window/taskbar icon at
    // the source icon explicitly; otherwise it shows Electron's default.
    icon: is.dev ? join(app.getAppPath(), 'build', 'icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox stays false: with sandbox:true the renderer fails to launch
      // (render-process-gone 'launch-failed', exit 18) whenever the app runs
      // elevated/as Administrator — Chromium's sandbox can't initialize under
      // elevation (electron/electron#49167). The app keeps its other protections
      // (contextIsolation, nodeIntegration:false, strict script CSP, navigation +
      // window-open guards, deny-all permissions). Re-enabling sandbox would also
      // require a CommonJS preload (this is an ESM project).
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Disable middle-click auxclick so it can't open links in new windows,
      // beyond the setWindowOpenHandler deny in hardenWindow().
      disableBlinkFeatures: 'Auxclick'
    }
  })
  dashboardWindow = mainWindow
  hardenWindow(mainWindow)

  if (savedWindowState?.isFullScreen) {
    mainWindow.setFullScreen(true)
  } else if (savedWindowState?.isMaximized) {
    mainWindow.maximize()
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  registerWindowStatePersistence(mainWindow)

  mainWindow.on('close', () => {
    closeDetachedTerminalWindows({ force: true })
  })

  mainWindow.on('closed', () => {
    if (dashboardWindow === mainWindow) dashboardWindow = null
    closeDetachedTerminalWindows({ force: true })
    if (process.platform !== 'darwin') app.quit()
  })

  mainWindow.webContents.on('console-message', (details) => {
    if (!shouldForwardRendererConsole(details)) return
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process exited', details)
  })

  // Re-apply the zoom after every load; a full reload (incl. dev HMR) resets it.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.setZoomFactor(UI_ZOOM_FACTOR)
  })

  // Wire up zoom keyboard shortcuts (a frameless window with no menu has none by
  // default): Ctrl+= / Ctrl++ to zoom in, Ctrl+- to zoom out, Ctrl+0 to reset.
  const clampZoom = (factor: number): number => Math.min(2.5, Math.max(0.6, Math.round(factor * 10) / 10))
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt) return
    const contents = mainWindow.webContents
    if (input.key === '=' || input.key === '+') {
      contents.setZoomFactor(clampZoom(contents.getZoomFactor() + 0.1))
      event.preventDefault()
    } else if (input.key === '-') {
      contents.setZoomFactor(clampZoom(contents.getZoomFactor() - 0.1))
      event.preventDefault()
    } else if (input.key === '0') {
      contents.setZoomFactor(UI_ZOOM_FACTOR)
      event.preventDefault()
    }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

function notifyDetachedTerminalClosed(platform: PlatformId): void {
  const payload: TerminalDetachedEvent = { platform }
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(TERMINAL_DETACHED_CLOSED_CHANNEL, payload)
  }
}

function closeDetachedTerminalWindows({ force = false }: { force?: boolean } = {}): void {
  for (const terminalWindow of Object.values(detachedTerminalWindows)) {
    if (!terminalWindow || terminalWindow.isDestroyed()) continue
    if (force) terminalWindow.destroy()
    else terminalWindow.close()
  }
}

function attachDetachedTerminalWindow(platform: PlatformId): boolean {
  notifyDetachedTerminalClosed(platform)
  const terminalWindow = detachedTerminalWindows[platform]
  if (terminalWindow && !terminalWindow.isDestroyed()) terminalWindow.close()
  return true
}

function loadRenderer(window: BrowserWindow, query: Record<string, string> = {}): void {
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value)
    }
    window.loadURL(url.toString())
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { query })
  }
}

// Lock a window down per the Electron security checklist: refuse renderer-initiated
// new windows and block any navigation away from the app. Our UI is a local
// single-page app that never navigates its top frame or opens child windows
// (detached terminals are created here in the main process), so both are pure
// denials — except same-origin dev-server reloads, which must still work under HMR.
function hardenWindow(window: BrowserWindow): void {
  const devOrigin =
    is.dev && process.env.ELECTRON_RENDERER_URL ? new URL(process.env.ELECTRON_RENDERER_URL).origin : null

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (devOrigin) {
      try {
        if (new URL(url).origin === devOrigin) return
      } catch {
        // Unparseable URL → fall through and block.
      }
    }
    event.preventDefault()
  })
}

function openDetachedTerminalWindow(platform: PlatformId): boolean {
  const existing = detachedTerminalWindows[platform]
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return true
  }

  const owner = BrowserWindow.getFocusedWindow()
  const workArea = (owner ? screen.getDisplayMatching(owner.getBounds()) : screen.getPrimaryDisplay()).workArea
  const width = Math.min(1180, Math.max(900, Math.floor(workArea.width * 0.72)))
  const height = Math.min(820, Math.max(640, Math.floor(workArea.height * 0.76)))
  const terminalWindow = new BrowserWindow({
    x: workArea.x + Math.max(0, Math.floor((workArea.width - width) / 2)),
    y: workArea.y + Math.max(0, Math.floor((workArea.height - height) / 2)),
    width,
    height,
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: false,
    backgroundColor: '#1e1b19',
    title: `${PLATFORM_CONFIG[platform].label} Terminals`,
    icon: is.dev ? join(app.getAppPath(), 'build', 'icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox stays false: with sandbox:true the renderer fails to launch
      // (render-process-gone 'launch-failed', exit 18) whenever the app runs
      // elevated/as Administrator — Chromium's sandbox can't initialize under
      // elevation (electron/electron#49167). The app keeps its other protections
      // (contextIsolation, nodeIntegration:false, strict script CSP, navigation +
      // window-open guards, deny-all permissions). Re-enabling sandbox would also
      // require a CommonJS preload (this is an ESM project).
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Disable middle-click auxclick so it can't open links in new windows,
      // beyond the setWindowOpenHandler deny in hardenWindow().
      disableBlinkFeatures: 'Auxclick'
    }
  })

  detachedTerminalWindows[platform] = terminalWindow
  hardenWindow(terminalWindow)

  terminalWindow.on('ready-to-show', () => {
    terminalWindow.show()
  })
  terminalWindow.on('closed', () => {
    if (detachedTerminalWindows[platform] === terminalWindow) delete detachedTerminalWindows[platform]
    notifyDetachedTerminalClosed(platform)
  })
  terminalWindow.webContents.on('console-message', (details) => {
    if (!shouldForwardRendererConsole(details)) return
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`)
  })
  terminalWindow.webContents.on('did-finish-load', () => {
    terminalWindow.webContents.setZoomFactor(UI_ZOOM_FACTOR)
  })

  loadRenderer(terminalWindow, { view: 'terminals', platform })
  return true
}

function focusExistingWindow(): BrowserWindow | null {
  const mainWindow = dashboardWindow && !dashboardWindow.isDestroyed() ? dashboardWindow : BrowserWindow.getAllWindows()[0] ?? null
  if (!mainWindow) return null

  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()

  return mainWindow
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    const mainWindow = focusExistingWindow()
    const options = {
      type: 'info' as const,
      title: `${APP_NAME} is already running`,
      message: `${APP_NAME} is already running.`,
      detail: 'Use the existing window instead of launching another instance.',
      buttons: ['OK'],
      defaultId: 0,
      noLink: true
    }

    const notice = mainWindow ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options)
    notice.catch(() => undefined)
  })
}

// Last-resort logging so an unexpected error in the main process is recorded
// instead of vanishing (the renderer already has its own error boundary + global
// handlers). We log rather than quit: an unhandled rejection is rarely fatal, and
// abruptly exiting would be a worse experience than carrying on.
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main process', error)
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection in main process', reason)
})

if (hasSingleInstanceLock) app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.cadence.app')

  // Deny every renderer permission request (camera, mic, geolocation, notifications,
  // etc.). The UI needs none — native usage alerts use the main-process Notification
  // API, not the renderer's. (Electronegativity: missing permission request handler.)
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

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
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window === dashboardWindow) closeDetachedTerminalWindows({ force: true })
    window.close()
  })

  ipcMain.handle('app:version', () => app.getVersion())
  // Clipboard moved to the main process so the renderer can run under sandbox:true
  // (the sandboxed preload can't import electron's clipboard module directly).
  ipcMain.handle('clipboard:read', () => clipboard.readText())
  ipcMain.on('clipboard:write', (_event, text: string) => {
    if (typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.on('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })

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
  ipcMain.handle('sessions:claude', (event) => scanSessions('claude', event.sender))
  ipcMain.handle('sessions:codex', (event) => scanSessions('codex', event.sender))
  ipcMain.handle('sessions:history', (_event, platform: PlatformId, sessionId: string) => getSessionHistory(platform, sessionId))
  ipcMain.handle('sessions:title-generation-status', () => getSessionTitleGenerationStatus())
  ipcMain.handle('sessions:metadata', () => getSessionMetadata())
  ipcMain.handle('sessions:set-project-alias', (_event, projectId: string, name: string | null) =>
    setProjectAlias(projectId, name)
  )
  ipcMain.handle('sessions:set-session-alias', (_event, platform: PlatformId, sessionId: string, title: string | null) =>
    setSessionAlias(platform, sessionId, title)
  )
  ipcMain.handle('sessions:delete-session', async (_event, platform: PlatformId, sessionId: string) => {
    const result = await deleteSession(platform, sessionId)
    // Drop the cache so the renderer's follow-up refresh doesn't show the trashed
    // session resurface from a warm full-scan cache.
    invalidateSessionCache(platform)
    return result
  })
  ipcMain.handle('sessions:delete-project', async (_event, platform: PlatformId, projectId: string) => {
    const result = await deleteProject(platform, projectId)
    invalidateSessionCache(platform)
    return result
  })
  ipcMain.handle('search:query', (event, query: SearchQuery) => searchWorkspace(query, event.sender))
  ipcMain.handle('memory:list', (event, platform: PlatformId, projectId: string | null) =>
    getProjectMemory(platform, projectId, event.sender)
  )
  ipcMain.handle('memory:read', (event, platform: PlatformId, projectId: string | null, id: string) =>
    readMemoryFile(platform, projectId, id, event.sender)
  )
  ipcMain.handle('memory:write', (event, platform: PlatformId, projectId: string | null, id: string, text: string) =>
    writeMemoryFile(platform, projectId, id, text, event.sender)
  )
  ipcMain.handle('setup:status', () => getSetupStatus())
  ipcMain.handle('setup:command', (_event, platform: PlatformId, action: SetupAction) =>
    getSetupCommand(platform, action)
  )
  ipcMain.handle('setup:disconnect', (_event, platform: PlatformId) => disconnectPlatform(platform))

  ipcMain.handle('workspaces:list', () => listWorkspaces())
  ipcMain.handle('workspaces:attach', (event) => attachWorkspace(BrowserWindow.fromWebContents(event.sender)))
  ipcMain.handle('github:auth-status', () => getGitHubAuthStatus())
  ipcMain.handle('github:auth-start-device-flow', (_event, clientId?: string | null) =>
    startGitHubDeviceFlow(clientId)
  )
  ipcMain.handle('github:auth-poll-device-flow', () => pollGitHubDeviceFlow())
  ipcMain.handle('github:auth-open-device-page', () => openGitHubDevicePage())
  ipcMain.handle('github:auth-sign-out', () => signOutGitHub())
  ipcMain.handle('github:list-repositories', (_event, page?: number) => listGitHubRepositories(page))
  ipcMain.handle('github:choose-import-directory', (event) =>
    chooseGithubImportDirectory(BrowserWindow.fromWebContents(event.sender))
  )
  ipcMain.handle('github:import-project', (event, request: GitHubImportRequest) =>
    importGithubProject(request, event.sender)
  )
  ipcMain.handle('github:sync-project-context', (event, request: GitHubContextSyncRequest) =>
    syncProjectContextToVault(request, event.sender)
  )
  ipcMain.handle('project-workspace:get', (_event, projectId: string) => getProjectWorkspace(projectId))
  ipcMain.handle('project-workspace:save', (_event, projectId: string, data: unknown) =>
    saveProjectWorkspace(projectId, data)
  )
  ipcMain.handle('project-files:list', (_event, req: FileRequest) => listDirectory(req))
  ipcMain.handle('project-files:preview', (_event, req: FileRequest) => readFilePreview(req))
  ipcMain.handle('project-files:exists', (_event, req: FileRequest) => statProjectFile(req))
  ipcMain.handle('project-files:watch', (event, req: ProjectFileWatchRequest) =>
    watchProjectFiles(req, event.sender)
  )
  ipcMain.on('project-files:unwatch', (event) => unwatchProjectFiles(event.sender))
  ipcMain.handle('project-files:rename', (_event, req: FileRequest, newName: string) => renameEntry(req, newName))
  ipcMain.handle('project-files:create', (_event, req: FileRequest, name: string, kind: FileKind) =>
    createEntry(req, name, kind)
  )
  ipcMain.handle('project-files:delete', (_event, req: FileRequest) => deleteEntry(req))
  ipcMain.handle('project-files:reveal', (_event, req: FileRequest) => revealInExplorer(req))
  ipcMain.handle('project-files:open', (_event, req: FileRequest) => openExternally(req))
  ipcMain.handle('terminal:start', (event, terminalId: string, platform: string, cwd?: string, wslDistro?: string) =>
    startTerminal(terminalId, platform, event.sender, cwd, wslDistro)
  )
  ipcMain.handle('terminal:open-detached', (_event, platform: PlatformId) => {
    if (!PLATFORM_CONFIG[platform]) return false
    return openDetachedTerminalWindow(platform)
  })
  ipcMain.handle('terminal:attach-detached', (_event, platform: PlatformId) => {
    if (!PLATFORM_CONFIG[platform]) return false
    return attachDetachedTerminalWindow(platform)
  })
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
