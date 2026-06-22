import { clipboard, contextBridge, ipcRenderer } from 'electron'
import type { ClaudePlanUsage } from '@shared/claude-plan-usage'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { PlatformId } from '@shared/platform'
import type {
  AssistantSession,
  AssistantSessionHistory,
  SessionsUpdatedPayload,
  SessionTitleGenerationStatus
} from '@shared/sessions'
import type { SessionMetadata } from '@shared/session-metadata'
import type { ProjectWorkspace } from '@shared/project-workspace'
import type {
  DirListing,
  FileKind,
  FileOpResult,
  FilePreview,
  FileRequest,
  ProjectFileStat,
  ProjectFileChangedEvent,
  ProjectFileWatchRequest,
  ProjectFileWatchResult
} from '@shared/project-files'
import type { SearchQuery, SearchResults } from '@shared/search'
import type { SetupAction, SetupCommand, SetupStatus } from '@shared/setup'
import type { MemoryFileContent, MemoryWriteResult, ProjectMemory } from '@shared/memory'
import {
  TERMINAL_DETACHED_CLOSED_CHANNEL,
  type TerminalDataEvent,
  type TerminalDetachedEvent,
  type TerminalPlatform,
  type TerminalStartResult
} from '@shared/terminal'
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
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
    // Relaunch so a freshly-installed CLI is picked up on the new process's PATH.
    relaunch: (): void => ipcRenderer.send('app:relaunch')
  },
  clipboard: {
    readText: (): string => clipboard.readText(),
    writeText: (text: string): void => clipboard.writeText(text)
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
      ipcRenderer.invoke('sessions:delete-project', platform, projectId),
    // Background full scans (including slow WSL origins) push the complete list
    // here after the fast Windows-only first paint. Channel must match
    // SESSIONS_UPDATED_CHANNEL in main/sessions/session-scan.ts.
    onSessionsUpdated: (callback: (payload: SessionsUpdatedPayload) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: SessionsUpdatedPayload): void => callback(payload)
      ipcRenderer.on('sessions:updated', listener)
      return () => ipcRenderer.removeListener('sessions:updated', listener)
    }
  },
  search: {
    query: (query: SearchQuery): Promise<SearchResults> => ipcRenderer.invoke('search:query', query)
  },
  setup: {
    getStatus: (): Promise<SetupStatus> => ipcRenderer.invoke('setup:status'),
    getCommand: (platform: PlatformId, action: SetupAction): Promise<SetupCommand> =>
      ipcRenderer.invoke('setup:command', platform, action)
  },
  memory: {
    list: (platform: PlatformId, projectId: string | null): Promise<ProjectMemory> =>
      ipcRenderer.invoke('memory:list', platform, projectId),
    read: (platform: PlatformId, projectId: string | null, id: string): Promise<MemoryFileContent> =>
      ipcRenderer.invoke('memory:read', platform, projectId, id),
    write: (platform: PlatformId, projectId: string | null, id: string, text: string): Promise<MemoryWriteResult> =>
      ipcRenderer.invoke('memory:write', platform, projectId, id, text)
  },
  workspaces: {
    list: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:list'),
    attach: (): Promise<Workspace | null> => ipcRenderer.invoke('workspaces:attach')
  },
  projectWorkspace: {
    get: (projectId: string): Promise<ProjectWorkspace> => ipcRenderer.invoke('project-workspace:get', projectId),
    save: (projectId: string, data: ProjectWorkspace): Promise<ProjectWorkspace> =>
      ipcRenderer.invoke('project-workspace:save', projectId, data)
  },
  projectFiles: {
    list: (req: FileRequest): Promise<DirListing> => ipcRenderer.invoke('project-files:list', req),
    preview: (req: FileRequest): Promise<FilePreview> => ipcRenderer.invoke('project-files:preview', req),
    exists: (req: FileRequest): Promise<ProjectFileStat> => ipcRenderer.invoke('project-files:exists', req),
    rename: (req: FileRequest, newName: string): Promise<FileOpResult> =>
      ipcRenderer.invoke('project-files:rename', req, newName),
    create: (req: FileRequest, name: string, kind: FileKind): Promise<FileOpResult> =>
      ipcRenderer.invoke('project-files:create', req, name, kind),
    delete: (req: FileRequest): Promise<FileOpResult> => ipcRenderer.invoke('project-files:delete', req),
    reveal: (req: FileRequest): Promise<FileOpResult> => ipcRenderer.invoke('project-files:reveal', req),
    open: (req: FileRequest): Promise<FileOpResult> => ipcRenderer.invoke('project-files:open', req),
    watch: (req: ProjectFileWatchRequest): Promise<ProjectFileWatchResult> =>
      ipcRenderer.invoke('project-files:watch', req),
    unwatch: (): void => ipcRenderer.send('project-files:unwatch'),
    onChanged: (callback: (event: ProjectFileChangedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ProjectFileChangedEvent): void => callback(payload)
      ipcRenderer.on('project-files:changed', listener)
      return () => ipcRenderer.removeListener('project-files:changed', listener)
    }
  },
  terminal: {
    openDetached: (platform: TerminalPlatform): Promise<boolean> =>
      ipcRenderer.invoke('terminal:open-detached', platform),
    attachDetached: (platform: TerminalPlatform): Promise<boolean> =>
      ipcRenderer.invoke('terminal:attach-detached', platform),
    start: (
      terminalId: string,
      platform: TerminalPlatform,
      cwd?: string,
      wslDistro?: string
    ): Promise<TerminalStartResult> => ipcRenderer.invoke('terminal:start', terminalId, platform, cwd, wslDistro),
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
    },
    onDetachedClosed: (callback: (event: TerminalDetachedEvent) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TerminalDetachedEvent): void => callback(payload)
      ipcRenderer.on(TERMINAL_DETACHED_CLOSED_CHANNEL, listener)
      return () => ipcRenderer.removeListener(TERMINAL_DETACHED_CLOSED_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('dashboard', api)

export type DashboardApi = typeof api
