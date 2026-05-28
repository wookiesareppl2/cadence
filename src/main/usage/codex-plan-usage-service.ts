import { app } from 'electron'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CodexPlanUsage } from '@shared/codex-plan-usage'
import type { UsageWindow } from '@shared/claude-plan-usage'

type RawRateLimitWindow = {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
}

type RawRateLimits = {
  limit_id?: unknown
  plan_type?: unknown
  primary?: RawRateLimitWindow
  secondary?: RawRateLimitWindow
}

type LatestRateLimits = {
  timestampMs: number
  timestamp: string
  sourcePath: string
  rateLimits: RawRateLimits
}

async function findJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = []

  async function visit(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await visit(path)
          return
        }
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
      })
    )
  }

  await visit(root)
  return files
}

function parseUsageWindow(raw: RawRateLimitWindow | undefined, expectedWindowMinutes: number): UsageWindow | null {
  if (!raw || raw.window_minutes !== expectedWindowMinutes || typeof raw.used_percent !== 'number') return null

  return {
    utilization: raw.used_percent,
    resetsAt: typeof raw.resets_at === 'number' ? new Date(raw.resets_at * 1000).toISOString() : null
  }
}

async function scanRateLimitFile(sourcePath: string): Promise<LatestRateLimits | null> {
  let raw = ''
  try {
    raw = await readFile(sourcePath, 'utf-8')
  } catch {
    return null
  }

  let latest: LatestRateLimits | null = null

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      const rateLimits = row.payload?.rate_limits
      if (!rateLimits || rateLimits.limit_id !== 'codex') continue

      const timestamp = typeof row.timestamp === 'string' ? row.timestamp : null
      const timestampMs = timestamp ? Date.parse(timestamp) : NaN
      if (!timestamp || Number.isNaN(timestampMs)) continue

      if (!latest || timestampMs > latest.timestampMs) {
        latest = { timestampMs, timestamp, sourcePath, rateLimits }
      }
    } catch {
      // Ignore malformed append-only log rows.
    }
  }

  return latest
}

export async function fetchCodexPlanUsage(): Promise<CodexPlanUsage> {
  const root = join(app.getPath('home'), '.codex', 'sessions')
  const latestByFile = await Promise.all((await findJsonlFiles(root)).map(scanRateLimitFile))
  const latest = latestByFile
    .filter((entry): entry is LatestRateLimits => entry !== null)
    .sort((a, b) => b.timestampMs - a.timestampMs)[0]

  if (!latest) {
    return {
      fiveHour: null,
      sevenDay: null,
      planType: null,
      sourcePath: null,
      sourceTimestamp: null,
      fetchedAt: new Date().toISOString()
    }
  }

  return {
    fiveHour: parseUsageWindow(latest.rateLimits.primary, 300),
    sevenDay: parseUsageWindow(latest.rateLimits.secondary, 10_080),
    planType: typeof latest.rateLimits.plan_type === 'string' ? latest.rateLimits.plan_type : null,
    sourcePath: latest.sourcePath,
    sourceTimestamp: latest.timestamp,
    fetchedAt: new Date().toISOString()
  }
}
