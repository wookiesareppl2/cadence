import { app } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AssistantSession } from '@shared/sessions'

type ClaudeSessionDraft = {
  id: string
  sourcePath: string
  cwd: string | null
  branch: string | null
  title: string | null
  updatedAtMs: number
  tokenTotal: number
}

const MAX_SESSIONS = 80

async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        return
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }))
  }

  await visit(root)
  return files
}

function relativeAge(timestampMs: number): string {
  const diffMs = Math.max(0, Date.now() - timestampMs)
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function formatTokenLabel(value: number): string | null {
  if (!value) return null
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function projectLabel(cwd: string | null, sourcePath: string): string {
  if (cwd) return basename(cwd)
  return basename(dirname(sourcePath)).replaceAll('-', ' ')
}

function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null

  const text = value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text
      return null
    })
    .filter(Boolean)
    .join(' ')
    .trim()

  return text || null
}

function readableTitle(text: string | null, fallback: string): string {
  if (!text) return fallback
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized
}

function sessionTitle(title: string | null, cwd: string | null): string {
  return readableTitle(title, cwd ? basename(cwd) : 'Claude session')
}

async function readClaudeSession(path: string): Promise<ClaudeSessionDraft | null> {
  const stats = await stat(path)
  const draft: ClaudeSessionDraft = {
    id: basename(path, '.jsonl'),
    sourcePath: path,
    cwd: null,
    branch: null,
    title: null,
    updatedAtMs: stats.mtimeMs,
    tokenTotal: 0
  }

  const raw = await readFile(path, 'utf-8')
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      if (typeof row.sessionId === 'string') draft.id = row.sessionId
      if (typeof row.cwd === 'string') draft.cwd = row.cwd
      if (typeof row.gitBranch === 'string') draft.branch = row.gitBranch
      if (!draft.title && row.type === 'user') draft.title = contentText(row.message?.content)
      if (typeof row.timestamp === 'string') {
        const parsed = Date.parse(row.timestamp)
        if (!Number.isNaN(parsed)) draft.updatedAtMs = Math.max(draft.updatedAtMs, parsed)
      }

      const usage = row.message?.usage
      if (usage) {
        draft.tokenTotal +=
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0)
      }
    } catch {
      // Ignore malformed JSONL rows. The usage parser owns detailed diagnostics.
    }
  }

  return draft
}

// Claude Code reuses one sessionId across multiple .jsonl files when a session
// is resumed/continued, so several drafts can share the same id. Merge them into
// a single entry — summing usage and keeping the freshest metadata — so the list
// has unique ids (avoids duplicate React keys and dropped/duplicated rows).
function dedupeById(drafts: ClaudeSessionDraft[]): ClaudeSessionDraft[] {
  const byId = new Map<string, ClaudeSessionDraft>()

  for (const draft of drafts) {
    const existing = byId.get(draft.id)
    if (!existing) {
      byId.set(draft.id, { ...draft })
      continue
    }

    existing.tokenTotal += draft.tokenTotal
    existing.title = existing.title ?? draft.title
    if (draft.updatedAtMs >= existing.updatedAtMs) {
      existing.updatedAtMs = draft.updatedAtMs
      existing.sourcePath = draft.sourcePath
      existing.cwd = draft.cwd ?? existing.cwd
      existing.branch = draft.branch ?? existing.branch
    } else {
      existing.cwd = existing.cwd ?? draft.cwd
      existing.branch = existing.branch ?? draft.branch
    }
  }

  return [...byId.values()]
}

export async function getClaudeSessions(): Promise<AssistantSession[]> {
  const root = join(app.getPath('home'), '.claude', 'projects')
  const files = await findJsonlFiles(root)
  const sessions = await Promise.all(files.map(readClaudeSession))

  const drafts = sessions.filter((session): session is ClaudeSessionDraft => Boolean(session))

  return dedupeById(drafts)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, MAX_SESSIONS)
    .map((session) => ({
      id: session.id,
      platform: 'claude',
      title: sessionTitle(session.title, session.cwd),
      project: projectLabel(session.cwd, session.sourcePath),
      branch: session.branch,
      usageLabel: formatTokenLabel(session.tokenTotal),
      status: 'local',
      age: relativeAge(session.updatedAtMs),
      updatedAt: new Date(session.updatedAtMs).toISOString()
    }))
}

export async function getCodexSessions(): Promise<AssistantSession[]> {
  const indexPath = join(app.getPath('home'), '.codex', 'session_index.jsonl')
  let raw = ''
  try {
    raw = await readFile(indexPath, 'utf-8')
  } catch {
    return []
  }

  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line): AssistantSession | null => {
      try {
        const row = JSON.parse(line)
        const updatedAtMs = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : NaN
        const updatedAt = Number.isNaN(updatedAtMs) ? null : new Date(updatedAtMs).toISOString()
        return {
          id: row.id,
          platform: 'codex',
          title: row.thread_name || `Codex ${String(row.id).slice(0, 8)}`,
          project: '',
          branch: null,
          usageLabel: null,
          status: '',
          age: updatedAt ? relativeAge(Date.parse(updatedAt)) : 'unknown',
          updatedAt
        }
      } catch {
        return null
      }
    })
    .filter((session): session is AssistantSession => Boolean(session?.id))
    .sort((a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'))
    .slice(0, MAX_SESSIONS)
}
