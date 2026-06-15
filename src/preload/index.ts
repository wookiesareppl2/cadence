import { contextBridge, ipcRenderer } from 'electron'
import type { ClaudePlanUsage } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { PlatformId } from '@shared/platform'
import type { AssistantSession, AssistantSessionHistory, SessionTitleGenerationStatus } from '@shared/sessions'
import type { SessionMetadata } from '@shared/session-metadata'
import type { TerminalDataEvent, TerminalPlatform, TerminalStartResult } from '@shared/terminal'
import type { ClaudeUsageSummary } from '@shared/usage'
import type { Workspace } from '@shared/workspaces'

const api = {
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:maximize-toggle'),
    close: (): void => ipcRenderer.send('window:close')
  },
  app: {
    platform: process.platform,
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:version')
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
      ipcRenderer.invoke('sessions:history', platform, sessionId),
    getTitleGenerationStatus: (): Promise<SessionTitleGenerationStatus> =>
      ipcRenderer.invoke('sessions:title-generation-status'),
    getMetadata: (): Promise<SessionMetadata> => ipcRenderer.invoke('sessions:metadata'),
    setProjectAlias: (projectId: string, name: string | null): Promise<SessionMetadata> =>
      ipcRenderer.invoke('sessions:set-project-alias', projectId, name),
    setSessionAlias: (platform: PlatformId, sessionId: string, title: string | null): Promise<SessionMetadata> =>
      ipcRenderer.invoke('sessions:set-session-alias', platform, sessionId, title),
    deleteSession: (platform: PlatformId, sessionId: string): Promise<{ trashed: number }> =>
      ipcRenderer.invoke('sessions:delete-session', platform, sessionId),
    deleteProject: (platform: PlatformId, projectId: string): Promise<{ trashed: number }> =>
      ipcRenderer.invoke('sessions:delete-project', platform, projectId)
  },
  workspaces: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
    attach: (): Promise<Workspace | null> => ipcRenderer.invoke('workspaces:attach')
  },
  terminal: {
    start: (terminalId: string, platform: TerminalPlatform, cwd?: string): Promise<TerminalStartResult> =>
      ipcRenderer.invoke('terminal:start', terminalId, platform, cwd),
    restart: (terminalId: string): Promise<TerminalStartResult> => ipcRenderer.invoke('terminal:restart', terminalId),
    input: (terminalId: string, data: string): void => ipcRenderer.send('terminal:input', terminalId, data),
    resize: (terminalId: string, cols: number, rows: number): void => {
      ipcRenderer.send('terminal:resize', terminalId, cols, rows)
    },
    close: (terminalId: string): void => ipcRenderer.send('terminal:close', terminalId),
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => callback(payload)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    }
  }
}

contextBridge.exposeInMainWorld('dashboard', api)

export type DashboardApi = typeof api
