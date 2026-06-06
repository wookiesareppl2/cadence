import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PlatformId } from '@shared/platform'
import { emptyMetadata, sessionAliasKey, type SessionMetadata } from '@shared/session-metadata'

// Display-name overrides for projects/sessions. Kept in the app's userData dir
// (never inside ~/.claude or ~/.codex) so it can't be mistaken for CLI state and
// never touches the real transcript files. Mirrors the workspaces.json store.
function storePath(): string {
  return join(app.getPath('userData'), 'session-metadata.json')
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.trim()) out[key] = entry
  }
  return out
}

function parseMetadata(raw: string): SessionMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyMetadata()
  }
  if (!parsed || typeof parsed !== 'object') return emptyMetadata()
  const record = parsed as Record<string, unknown>
  return {
    projectAliases: asStringRecord(record.projectAliases),
    sessionAliases: asStringRecord(record.sessionAliases)
  }
}

async function readStore(): Promise<SessionMetadata> {
  try {
    return parseMetadata(await readFile(storePath(), 'utf-8'))
  } catch {
    return emptyMetadata()
  }
}

async function writeStore(metadata: SessionMetadata): Promise<void> {
  const path = storePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(metadata, null, 2), 'utf-8')
}

// An empty/blank alias means "revert to the inferred name" — delete the key
// rather than persisting a blank string.
function setAlias(map: Record<string, string>, key: string, value: string | null): void {
  const trimmed = value?.trim()
  if (trimmed) map[key] = trimmed
  else delete map[key]
}

export async function getSessionMetadata(): Promise<SessionMetadata> {
  return readStore()
}

export async function setProjectAlias(projectId: string, name: string | null): Promise<SessionMetadata> {
  const metadata = await readStore()
  setAlias(metadata.projectAliases, projectId, name)
  await writeStore(metadata)
  return metadata
}

export async function setSessionAlias(
  platform: PlatformId,
  sessionId: string,
  title: string | null
): Promise<SessionMetadata> {
  const metadata = await readStore()
  setAlias(metadata.sessionAliases, sessionAliasKey(platform, sessionId), title)
  await writeStore(metadata)
  return metadata
}

export async function clearProjectAlias(projectId: string): Promise<void> {
  await setProjectAlias(projectId, null)
}

export async function clearSessionAlias(platform: PlatformId, sessionId: string): Promise<void> {
  await setSessionAlias(platform, sessionId, null)
}
