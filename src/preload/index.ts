import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudeUsageSummary } from '@shared/usage'

const api = {
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:maximize-toggle'),
    close: (): void => ipcRenderer.send('window:close')
  },
  app: {
    platform: process.platform
  },
  usage: {
    getClaudeSummary: (): Promise<ClaudeUsageSummary> => ipcRenderer.invoke('usage:claude-summary')
  }
}

contextBridge.exposeInMainWorld('dashboard', api)

export type DashboardApi = typeof api
