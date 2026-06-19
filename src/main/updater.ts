import electronUpdater from 'electron-updater'
import { BrowserWindow, dialog } from 'electron'
import { APP_NAME } from '@shared/brand'

const { autoUpdater } = electronUpdater

// Background auto-updates with an explicit, user-consented install. The app pulls
// releases from the public `cadence-releases` repo (build.publish), so no
// token is embedded. A new version downloads in the background; the user is then
// PROMPTED to restart & install — we never install silently on quit.
export function initAutoUpdates(): void {
  autoUpdater.autoDownload = true
  // Do NOT install silently when the app quits — the user decides via the prompt.
  autoUpdater.autoInstallOnAppQuit = false

  let promptedVersion: string | null = null

  autoUpdater.on('checking-for-update', () => console.log('[auto-update] checking for updates'))
  autoUpdater.on('update-available', (info) => console.log(`[auto-update] update available: ${info.version} (downloading)`))
  autoUpdater.on('update-not-available', () => console.log('[auto-update] up to date'))
  autoUpdater.on('download-progress', (p) => console.log(`[auto-update] downloading ${Math.round(p.percent)}%`))
  autoUpdater.on('error', (err) => console.error('[auto-update] error', err))

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[auto-update] downloaded ${info.version}`)
    // Guard against re-prompting for the same version within a session.
    if (promptedVersion === info.version) return
    promptedVersion = info.version
    promptToInstall(info.version)
  })

  // Use checkForUpdates (not checkForUpdatesAndNotify): with autoDownload on, the
  // update still downloads and fires `update-downloaded`, but we avoid the native
  // notification whose default text ("…will be automatically installed on exit")
  // contradicts our prompt-to-install flow.
  autoUpdater.checkForUpdates().catch((err) => console.error('[auto-update] check failed', err))
}

function promptToInstall(version: string): void {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options: Electron.MessageBoxSyncOptions = {
    type: 'info',
    buttons: ['Restart & Install', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: `${APP_NAME} ${version} is ready to install.`,
    detail: 'The app will restart to apply the update. Choose Later to keep working — you\'ll be prompted again next time you open the app.'
  }

  const choice = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options)
  if (choice === 0) {
    // Quit and run the already-downloaded installer.
    autoUpdater.quitAndInstall()
  }
}
