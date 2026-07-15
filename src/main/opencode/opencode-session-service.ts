import type {
  AssistantMessage,
  Message,
  OpencodeClient,
  Part,
  Session,
  SessionStatus,
  UserMessage
} from '@opencode-ai/sdk'
import { posix, win32 } from 'node:path'
import type {
  AssistantSession,
  AssistantSessionHistory,
  AssistantSessionHistoryEntry,
  SessionOrigin
} from '@shared/sessions'
import type { OpenCodeActivitySnapshot, OpenCodeAgentActivity } from '@shared/opencode'
import { WINDOWS_ORIGIN } from '@shared/sessions'
import { workspaceProjectId } from '../workspaces/workspace-utils'
import { detectOpenCodeRuntime, getOpenCodeClient, wslPathToWindows } from './opencode-runtime'

type MessageWithParts = { info: Message; parts: Part[] }

const MAX_SESSIONS = 80
const MESSAGE_SUMMARY_LIMIT = 12

function relativeAge(timestampMs: number): string {
  const diff = Math.max(0, Date.now() - timestampMs)
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return `${Math.floor(days / 30)}mo`
}

function fallbackContextWindow(model: string | null): number | null {
  if (!model) return null
  if (/kimi-k2\.7|kimi-k2\.6/i.test(model)) return 256_000
  if (/glm-5|qwen3\.7|deepseek-v4|minimax-m3/i.test(model)) return 1_000_000
  if (/mimo-v2\.5/i.test(model)) return 256_000
  return 200_000
}

function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant'
}

function isUserMessage(message: Message): message is UserMessage {
  return message.role === 'user'
}

function sessionLocation(directory: string, distro: string): {
  path: string
  origin: SessionOrigin
  projectId: string
  project: string
} {
  const windowsPath = wslPathToWindows(directory)
  if (windowsPath) {
    const path = win32.normalize(windowsPath)
    return {
      path,
      origin: WINDOWS_ORIGIN,
      projectId: workspaceProjectId('opencode', path),
      project: win32.basename(path) || path
    }
  }

  const path = directory.replace(/\\/g, '/')
  const origin: SessionOrigin = { id: `wsl:${distro}`, kind: 'wsl', label: distro, distro }
  return {
    path,
    origin,
    projectId: `opencode:${origin.id}:${path.toLowerCase()}`,
    project: posix.basename(path) || path
  }
}

async function sessionMessages(session: Session, limit?: number): Promise<MessageWithParts[]> {
  const client = await getOpenCodeClient(session.directory)
  const response = await client.session.messages({
    path: { id: session.id },
    query: { directory: session.directory, ...(limit ? { limit } : {}) }
  })
  return response.data ?? []
}

function latestAssistant(messages: MessageWithParts[]): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index].info
    if (isAssistantMessage(info)) return info
  }
  return null
}

function latestUser(messages: MessageWithParts[]): UserMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index].info
    if (isUserMessage(info)) return info
  }
  return null
}

function totalCost(messages: MessageWithParts[]): number {
  return messages.reduce((sum, row) => sum + (isAssistantMessage(row.info) ? row.info.cost : 0), 0)
}

function statusLabel(status: SessionStatus | undefined): string {
  if (!status) return 'local'
  if (status.type === 'busy') return 'running'
  if (status.type === 'retry') return `retry ${status.attempt}`
  return 'idle'
}

// A bare `/session` list is scoped to the OpenCode server's own working directory.
// The managed server inherits Cadence's process cwd, which is the project folder in
// dev but the install folder in a packaged build — so the bare list comes back empty
// for real users even though their sessions are on disk. `/project`, by contrast, is
// not cwd-scoped, so enumerate every known project and list its sessions by directory.
// The result is then independent of where the managed server happened to be launched.
async function collectOpenCodeSessions(
  client: OpencodeClient
): Promise<{ sessions: Session[]; statuses: Record<string, SessionStatus | undefined> }> {
  const projectResponse = await client.project.list()
  const projects = projectResponse.data ?? []
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const directory = project.worktree
      try {
        const [sessionResponse, statusResponse] = await Promise.all([
          client.session.list({ query: { directory } }),
          client.session.status({ query: { directory } })
        ])
        return { sessions: sessionResponse.data ?? [], statuses: statusResponse.data ?? {} }
      } catch {
        // One project's store can fail (removed worktree, migration) without
        // dropping the others.
        return { sessions: [] as Session[], statuses: {} as Record<string, SessionStatus> }
      }
    })
  )
  const statuses: Record<string, SessionStatus | undefined> = {}
  const byId = new Map<string, Session>()
  for (const group of perProject) {
    Object.assign(statuses, group.statuses)
    for (const session of group.sessions) {
      if (!byId.has(session.id)) byId.set(session.id, session)
    }
  }
  return { sessions: [...byId.values()], statuses }
}

export async function getOpenCodeSessions(): Promise<AssistantSession[]> {
  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro || !runtime.installed || !runtime.connected || !runtime.configured) return []
  const client = await getOpenCodeClient()
  const [collected, providerResponse] = await Promise.all([
    collectOpenCodeSessions(client),
    client.provider.list()
  ])
  const statuses = collected.statuses
  const goProvider = providerResponse.data?.all.find((provider) => provider.id === 'opencode-go')
  const contextWindows = new Map(
    Object.values(goProvider?.models ?? {}).map((model) => [model.id, model.limit.context])
  )
  const sessions = collected.sessions
    .filter((session) => !session.parentID)
    .sort((a, b) => b.time.updated - a.time.updated)
    .slice(0, MAX_SESSIONS)

  return Promise.all(
    sessions.map(async (session): Promise<AssistantSession> => {
      const location = sessionLocation(session.directory, runtime.distro!)
      let messages: MessageWithParts[] = []
      try {
        messages = await sessionMessages(session, MESSAGE_SUMMARY_LIMIT)
      } catch {
        // A deleted or concurrently-updating session can fail independently.
      }
      const latest = latestAssistant(messages)
      const contextTokens = latest
        ? latest.tokens.input + latest.tokens.cache.read + latest.tokens.cache.write
        : null
      return {
        id: session.id,
        platform: 'opencode',
        projectId: location.projectId,
        title: session.title || 'OpenCode session',
        rawTitle: session.title || null,
        inferredTitle: null,
        generatedTitle: null,
        titleSource: session.title ? 'raw' : 'fallback',
        titleStatus: null,
        titleUpdatedAt: new Date(session.time.updated).toISOString(),
        project: location.project,
        projectPath: location.path,
        branch: null,
        origin: location.origin,
        usageLabel: null,
        status: statusLabel(statuses[session.id]),
        age: relativeAge(session.time.updated),
        updatedAt: new Date(session.time.updated).toISOString(),
        model: latest ? `${latest.providerID}/${latest.modelID}` : null,
        contextTokens,
        contextWindow: latest
          ? contextWindows.get(latest.modelID) ?? fallbackContextWindow(latest.modelID)
          : null
      }
    })
  )
}

function partText(part: Part): string | null {
  if (part.type === 'text') return part.text
  if (part.type === 'subtask') return `${part.description}\n\nAssigned to @${part.agent}`
  if (part.type === 'tool') return `${part.tool}`
  if (part.type === 'patch') return `Changed ${part.files.join(', ')}`
  if (part.type === 'compaction') return part.auto ? 'Context compacted automatically' : 'Context compacted'
  if (part.type === 'retry') return `Retry ${part.attempt}: ${part.error.data.message}`
  return null
}

function historyEntries(messages: MessageWithParts[]): AssistantSessionHistoryEntry[] {
  const entries: AssistantSessionHistoryEntry[] = []
  for (const row of messages) {
    const timestamp = new Date(row.info.time.created).toISOString()
    const role = row.info.role === 'user' ? 'user' : 'assistant'
    const label = row.info.role === 'user' ? 'You' : isAssistantMessage(row.info) ? row.info.mode || 'OpenCode' : 'OpenCode'
    const text = row.parts
      .map(partText)
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n\n')
    if (text) entries.push({ id: row.info.id, role, label, text, timestamp })
  }
  return entries
}

export async function getOpenCodeSessionHistory(sessionId: string): Promise<AssistantSessionHistory> {
  const client = await getOpenCodeClient()
  const sessionResponse = await client.session.get({ path: { id: sessionId } })
  const session = sessionResponse.data
  if (!session) {
    return { sessionId, platform: 'opencode', title: 'OpenCode session', project: 'Unavailable', entries: [] }
  }
  const runtime = await detectOpenCodeRuntime()
  const location = sessionLocation(session.directory, runtime.distro ?? 'WSL')
  const messages = await sessionMessages(session)
  return {
    sessionId,
    platform: 'opencode',
    title: session.title || 'OpenCode session',
    project: location.project,
    entries: historyEntries(messages)
  }
}

export async function deleteOpenCodeSession(sessionId: string): Promise<{ trashed: number }> {
  const client = await getOpenCodeClient()
  const sessionResponse = await client.session.get({ path: { id: sessionId } })
  const session = sessionResponse.data
  if (!session) return { trashed: 0 }
  const scoped = await getOpenCodeClient(session.directory)
  const response = await scoped.session.delete({
    path: { id: sessionId },
    query: { directory: session.directory }
  })
  return { trashed: response.data ? 1 : 0 }
}

export async function deleteOpenCodeProject(projectId: string): Promise<{ trashed: number }> {
  const runtime = await detectOpenCodeRuntime()
  if (!runtime.distro) return { trashed: 0 }
  const client = await getOpenCodeClient()
  const { sessions } = await collectOpenCodeSessions(client)
  const targets = sessions.filter(
    (session) => !session.parentID && sessionLocation(session.directory, runtime.distro!).projectId === projectId
  )
  const results = await Promise.all(targets.map((session) => deleteOpenCodeSession(session.id)))
  return { trashed: results.reduce((sum, result) => sum + result.trashed, 0) }
}

function activityStatus(status: SessionStatus | undefined): OpenCodeAgentActivity['status'] {
  if (!status) return 'unknown'
  return status.type
}

export async function getOpenCodeActivity(sessionId: string): Promise<OpenCodeActivitySnapshot> {
  const client = await getOpenCodeClient()
  const parentResponse = await client.session.get({ path: { id: sessionId } })
  const parent = parentResponse.data
  if (!parent) throw new Error('OpenCode session not found')
  const scoped = await getOpenCodeClient(parent.directory)
  const [childrenResponse, statusesResponse, todosResponse] = await Promise.all([
    scoped.session.children({ path: { id: sessionId }, query: { directory: parent.directory } }),
    scoped.session.status({ query: { directory: parent.directory } }),
    scoped.session.todo({ path: { id: sessionId }, query: { directory: parent.directory } })
  ])
  const statuses = statusesResponse.data ?? {}
  const children = childrenResponse.data ?? []
  const jobs = await Promise.all(
    children.map(async (child): Promise<OpenCodeAgentActivity> => {
      let messages: MessageWithParts[] = []
      try {
        messages = await sessionMessages(child, MESSAGE_SUMMARY_LIMIT)
      } catch {
        // Report the child even when its messages are still being written.
      }
      const latest = latestAssistant(messages)
      const user = latestUser(messages)
      return {
        sessionId: child.id,
        parentSessionId: child.parentID ?? null,
        title: child.title || 'Background task',
        agent: user?.agent ?? latest?.mode ?? null,
        model: latest ? `${latest.providerID}/${latest.modelID}` : user ? `${user.model.providerID}/${user.model.modelID}` : null,
        status: activityStatus(statuses[child.id]),
        updatedAt: new Date(child.time.updated).toISOString(),
        cost: totalCost(messages)
      }
    })
  )
  const todos = todosResponse.data ?? []
  return {
    sessionId,
    jobs: jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    pendingTodos: todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled').length,
    completedTodos: todos.filter((todo) => todo.status === 'completed').length,
    fetchedAt: new Date().toISOString()
  }
}

export async function listAllOpenCodeMessages(): Promise<MessageWithParts[]> {
  const client = await getOpenCodeClient()
  const { sessions } = await collectOpenCodeSessions(client)
  const groups = await Promise.all(
    sessions.map(async (session) => {
      try {
        return await sessionMessages(session)
      } catch {
        return []
      }
    })
  )
  return groups.flat()
}
