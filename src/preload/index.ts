import { contextBridge, ipcRenderer } from 'electron'

const api = {
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:maximize-toggle'),
    close: (): void => ipcRenderer.send('window:close')
  },
  app: {
    platform: process.platform
  }
}

contextBridge.exposeInMainWorld('dashboard', api)

export type DashboardApi = typeof api
