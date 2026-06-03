import { basename } from 'node:path'

// Codex writes each session transcript to a rollout file named
// `rollout-<local-timestamp>-<session-id>.jsonl`, e.g.
// `rollout-2026-06-02T16-43-53-019e86a5-326e-7011-aaf3-f96de9f03e81.jsonl`.
// We discover sessions by scanning these files directly because Codex no longer
// maintains `session_index.jsonl` (it froze on 2026-05-05 once session metadata
// moved into SQLite), so the index silently drops every recent session.
const ROLLOUT_FILENAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-fA-F-]+)\.jsonl$/

export type CodexRolloutRef = {
  path: string
  id: string
  // Parsed from the filename so we can rank files by recency without reading any
  // of them. The authoritative last-updated time is recomputed from row
  // timestamps once the chosen files are read.
  startedAtMs: number
}

export function parseCodexRolloutFile(path: string): CodexRolloutRef | null {
  const match = basename(path).match(ROLLOUT_FILENAME)
  if (!match) return null

  const [, year, month, day, hour, minute, second, id] = match
  const startedAtMs = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}`)

  return { path, id, startedAtMs: Number.isNaN(startedAtMs) ? 0 : startedAtMs }
}

// Cheap pre-filter: rank every rollout file by the timestamp embedded in its name
// and keep the most recent `limit`. This lets the caller read details for only the
// freshest sessions instead of parsing every (potentially multi-megabyte) file.
export function rankRolloutFiles(paths: string[], limit: number): CodexRolloutRef[] {
  return paths
    .map(parseCodexRolloutFile)
    .filter((ref): ref is CodexRolloutRef => ref !== null)
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(0, Math.max(0, limit))
}
