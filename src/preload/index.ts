import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudePlanUsage } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { PlatformId } from '@shared/platform'
import type { AssistantSession, AssistantSessionHistory } from '@shared/sessions'
import type { TerminalDataEvent, TerminalPlatform, TerminalStartResult } from '@shared/terminal'
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
    getClaudeSummary: (): Promise<ClaudeUsageSummary> => ipcRenderer.invoke('usage:claude-summary'),
    getClaudePlanUsage: (): Promise<ClaudePlanUsage> => ipcRenderer.invoke('usage:claude-plan'),
    getCodexPlanUsage: (): Promise<CodexPlanUsage> => ipcRenderer.invoke('usage:codex-plan')
  },
  sessions: {
    getClaudeSessions: (): Promise<AssistantSession[]> => ipcRenderer.invoke('sessions:claude'),
    getCodexSessions: (): Promise<AssistantSession[]> => ipcRenderer.invoke('sessions:codex'),
    getSessionHistory: (platform: PlatformId, sessionId: string): Promise<AssistantSessionHistory> =>
      ipcRenderer.invoke('sessions:history', platform, sessionId)
  },
  terminal: {
    start: (platform: TerminalPlatform): Promise<TerminalStartResult> => ipcRenderer.invoke('terminal:start', platform),
    restart: (platform: TerminalPlatform): Promise<TerminalStartResult> => ipcRenderer.invoke('terminal:restart', platform),
    input: (platform: TerminalPlatform, data: string): void => ipcRenderer.send('terminal:input', platform, data),
    resize: (platform: TerminalPlatform, cols: number, rows: number): void => {
      ipcRenderer.send('terminal:resize', platform, cols, rows)
    },
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => callback(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dashboard', api)

export type DashboardApi = typeof api
