import electronUpdater from 'electron-updater'

const { autoUpdater } = electronUpdater

// Wires up background auto-updates. The app pulls releases from the public
// `ai-dashboard-releases` repo (configured under build.publish), so no token is
// embedded. New versions download in the background and install on next quit.
export function initAutoUpdates(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => console.log('[auto-update] checking for updates'))
  autoUpdater.on('update-available', (info) => console.log(`[auto-update] update available: ${info.version}`))
  autoUpdater.on('update-not-available', () => console.log('[auto-update] up to date'))
  autoUpdater.on('download-progress', (p) => console.log(`[auto-update] downloading ${Math.round(p.percent)}%`))
  autoUpdater.on('update-downloaded', (info) =>
    console.log(`[auto-update] downloaded ${info.version} — will install on quit`)
  )
  autoUpdater.on('error', (err) => console.error('[auto-update] error', err))

  autoUpdater.checkForUpdatesAndNotify().catch((err) => console.error('[auto-update] check failed', err))
}
