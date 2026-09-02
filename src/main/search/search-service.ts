import type { WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import type { PlatformId } from '@shared/platform'
import type { AssistantSession } from '@shared/sessions'
import type { SearchQuery, SearchResultItem, SearchResults } from '@shared/search'
import { bestScore, buildSnippet, emptyResults, matchScore } from '@shared/search'
import { isTextLikeProjectFile, MAX_TEXT_PREVIEW_BYTES } from '@shared/project-files'
import { applyProjectAlias, applySessionAlias } from '@shared/session-metadata'
import { scanSessions } from '../sessions/session-scan'
import { getSessionHistory } from '../sessions/session-service'
import { getSessionMetadata } from '../sessions/session-metadata-service'
import { listDirectory, readFilePreview } from '../projects/project-files-service'
import { groupProjects, resolveLocation, type ProjectLocation } from '../projects/project-locator'
import { listProjectCatalog } from '../projects/project-catalog-service'
import { listMemorySearchTargets } from '../memory/memory-service'

// Result/work caps. Project + session matching is in-memory and cheap; the deep
// (file-content + history-content) pass walks the disk, so it is scoped to one
// project and bounded by a visit count, a match count, and a wall-clock budget.
const MAX_PROJECT_RESULTS = 20
const MAX_SESSION_RESULTS = 25
const MAX_FILE_RESULTS = 40
const MAX_HISTORY_RESULTS = 40
const MAX_FILES_VISITED = 2500
const MAX_HISTORY_SESSIONS = 25
const MAX_MEMORY_RESULTS = 25
const DEEP_SEARCH_BUDGET_MS = 1500
// Memory gets its own budget rather than a share of the deep one. It is a short,
// known list of markdown files, but some of it lives on a synced drive or across
// a WSL share, so a slow home must not be able to spend the file walk's time.
const MEMORY_SEARCH_BUDGET_MS = 800

// Directories never worth searching — large, generated, packaged output, VCS
// internals, or editor settings. Keeps the walk fast and results relevant
// (especially over the slow WSL UNC share). NOTE: we deliberately do NOT skip
// `.claude` / `.codex` / `.agents` — those hold the project's memory bank and
// context files, which the user wants to find via search. The subset of them the
// Memory viewer surfaces is reported under Memory instead and skipped here (see
// `covered` in searchFiles); the rest still belongs in Files. Only genuinely
// value-free dirs belong in this list.
const IGNORE_DIRS = new Set([
  '.cache',
  '.git',
  '.idea',
  '.next',
  '.nuxt',
  '.svn',
  '.turbo',
  '.venv',
  '.vscode',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'release',
  'target',
  'venv'
])

type DeepResult = { items: SearchResultItem[]; truncated: boolean }

// `covered` holds the project-relative paths already reported under Memory, so a
// frozen in-repo bank file is not listed twice under two different headings. The
// set is derived from the memory enumeration itself, never from a list of names
// restated here.
async function searchFiles(
  target: ProjectLocation,
  needle: string,
  deadline: number,
  covered: ReadonlySet<string>
): Promise<DeepResult> {
  const items: Array<{ score: number; item: SearchResultItem }> = []
  const lowerNeedle = needle.toLowerCase()
  let visited = 0
  let truncated = false

  // Breadth-first walk reusing listDirectory (handles WSL UNC + sorting for us).
  const dirQueue: string[] = ['']
  while (dirQueue.length > 0) {
    if (Date.now() > deadline || items.length >= MAX_FILE_RESULTS || visited >= MAX_FILES_VISITED) {
      truncated = true
      break
    }
    const rel = dirQueue.shift() as string
    const listing = await listDirectory({ rootPath: target.path, distro: target.distro, relPath: rel })
    if (listing.error) continue
    if (listing.truncated) truncated = true

    for (const entry of listing.entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.kind === 'dir') {
        if (!IGNORE_DIRS.has(entry.name)) dirQueue.push(childRel)
        continue
      }

      if (covered.has(childRel.toLowerCase())) continue

      visited += 1
      if (visited >= MAX_FILES_VISITED) {
        truncated = true
        break
      }

      const nameScore = matchScore(entry.name, needle)
      const pathHit = nameScore === 0 && childRel.toLowerCase().includes(lowerNeedle)

      let snippet = null
      if (entry.size <= MAX_TEXT_PREVIEW_BYTES && isTextLikeProjectFile(childRel)) {
        if (Date.now() > deadline) {
          truncated = true
          break
        }
        const preview = await readFilePreview({ rootPath: target.path, distro: target.distro, relPath: childRel })
        if (preview.kind === 'text' && preview.text) snippet = buildSnippet(preview.text, needle)
      }

      if (nameScore > 0 || pathHit || snippet) {
        items.push({
          score: (nameScore || (pathHit ? 10 : 0)) + (snippet ? 5 : 0),
          item: {
            kind: 'file',
            id: childRel,
            title: entry.name,
            subtitle: childRel,
            projectId: target.id,
            file: { rootPath: target.path, distro: target.distro, relPath: childRel },
            snippet: snippet ?? undefined
          }
        })
        if (items.length >= MAX_FILE_RESULTS) {
          truncated = true
          break
        }
      }
    }
  }

  items.sort((a, b) => b.score - a.score)
  return { items: items.map((entry) => entry.item), truncated }
}

type MemoryResult = DeepResult & {
  // Every memory file that lives inside the project folder, lowercased and
  // project-relative — whether or not it matched. The file walk skips these so a
  // file cannot appear under both Memory and Files.
  coveredRelPaths: Set<string>
}

async function searchMemory(target: ProjectLocation, needle: string, deadline: number): Promise<MemoryResult> {
  const coveredRelPaths = new Set<string>()
  const matches: Array<{ score: number; item: SearchResultItem }> = []
  let truncated = false

  let targets
  try {
    targets = await listMemorySearchTargets(target)
  } catch {
    // No resolvable memory for this project — nothing to search, and nothing for
    // the file walk to skip either.
    return { items: [], truncated: false, coveredRelPaths }
  }

  for (const file of targets) {
    if (file.projectRelPath) coveredRelPaths.add(file.projectRelPath.toLowerCase())
  }

  for (const file of targets) {
    if (Date.now() > deadline || matches.length >= MAX_MEMORY_RESULTS) {
      truncated = true
      break
    }

    const nameScore = matchScore(file.label, needle)
    let snippet = null
    if (file.sizeBytes <= MAX_TEXT_PREVIEW_BYTES) {
      try {
        snippet = buildSnippet(await readFile(file.path, 'utf-8'), needle)
      } catch {
        // Unreadable right now (locked, mid-sync, gone). A name match still counts.
      }
    }
    if (nameScore === 0 && !snippet) continue

    matches.push({
      score: nameScore + (snippet ? 30 : 0),
      item: {
        kind: 'memory',
        id: file.id,
        title: file.label,
        subtitle: file.groupLabel,
        projectId: target.id,
        memoryId: file.id,
        snippet: snippet ?? undefined
      }
    })
  }

  matches.sort((a, b) => b.score - a.score)
  return { items: matches.map((entry) => entry.item), truncated, coveredRelPaths }
}

async function searchHistory(
  platform: PlatformId,
  sessions: AssistantSession[],
  needle: string,
  deadline: number
): Promise<DeepResult> {
  const items: SearchResultItem[] = []
  let truncated = false

  const recent = [...sessions]
    .sort((a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'))
    .slice(0, MAX_HISTORY_SESSIONS)
  if (sessions.length > MAX_HISTORY_SESSIONS) truncated = true

  for (const session of recent) {
    if (Date.now() > deadline || items.length >= MAX_HISTORY_RESULTS) {
      truncated = true
      break
    }
    let history
    try {
      history = await getSessionHistory(platform, session.id)
    } catch {
      continue
    }
    for (const entry of history.entries) {
      const snippet = buildSnippet(entry.text, needle) ?? buildSnippet(entry.label, needle)
      if (!snippet) continue
      items.push({
        kind: 'history',
        id: `${session.id}:${entry.id}`,
        title: session.title,
        subtitle: entry.role,
        projectId: session.projectId,
        sessionId: session.id,
        entryId: entry.id,
        snippet
      })
      if (items.length >= MAX_HISTORY_RESULTS) {
        truncated = true
        break
      }
    }
  }

  return { items, truncated }
}

export async function searchWorkspace(query: SearchQuery, sender: WebContents): Promise<SearchResults> {
  const needle = query.query.trim()
  if (!needle) return emptyResults(query.query)

  const [sessions, metadata, catalog] = await Promise.all([
    scanSessions(query.platform, sender),
    getSessionMetadata(),
    listProjectCatalog(query.platform, sender)
  ])
  const aliased = sessions.map((session) => applySessionAlias(session, metadata.sessionAliases))
  const groups = groupProjects(aliased, metadata.projectAliases)

  // Projects — match name + path across the whole platform.
  const projectMatches: Array<{ score: number; item: SearchResultItem }> = []
  for (const group of groups.values()) {
    const score = bestScore([group.name, group.path], needle)
    if (score > 0) {
      projectMatches.push({
        score,
        item: { kind: 'project', id: group.id, title: group.name, subtitle: group.path, projectId: group.id }
      })
    }
  }
  for (const entry of catalog) {
    if (groups.has(entry.id)) continue
    const name = applyProjectAlias(entry.name, entry.id, metadata.projectAliases)
    const score = bestScore([name, entry.path], needle)
    if (score > 0) {
      projectMatches.push({
        score,
        item: { kind: 'project', id: entry.id, title: name, subtitle: entry.path, projectId: entry.id }
      })
    }
  }

  // Sessions — match title (alias-applied) + raw/inferred titles + branch.
  const sessionMatches: Array<{ score: number; item: SearchResultItem }> = []
  for (const session of aliased) {
    const score = bestScore([session.title, session.rawTitle, session.inferredTitle, session.branch], needle)
    if (score > 0) {
      sessionMatches.push({
        score,
        item: {
          kind: 'session',
          id: session.id,
          title: session.title,
          subtitle: groups.get(session.projectId)?.name ?? session.project,
          projectId: session.projectId,
          sessionId: session.id
        }
      })
    }
  }

  let memory: SearchResultItem[] = []
  let files: SearchResultItem[] = []
  let history: SearchResultItem[] = []
  let deepTruncated = false

  let target = await resolveLocation(query.projectId, groups, query.platform, metadata.projectAliases)
  if (!target && query.projectId) {
    const entry = catalog.find((project) => project.id === query.projectId)
    if (entry) {
      target = {
        id: entry.id,
        name: applyProjectAlias(entry.name, entry.id, metadata.projectAliases),
        path: entry.path,
        distro: entry.origin.distro,
        sessions: []
      }
    }
  }
  if (target) {
    // Memory runs first and on its own clock: it is the smallest, highest-signal
    // set, and the file walk needs its covered-path list before it starts.
    const memoryResult = await searchMemory(target, needle, Date.now() + MEMORY_SEARCH_BUDGET_MS)
    memory = memoryResult.items

    const deadline = Date.now() + DEEP_SEARCH_BUDGET_MS
    const fileResult = await searchFiles(target, needle, deadline, memoryResult.coveredRelPaths)
    files = fileResult.items
    const historyResult = await searchHistory(query.platform, target.sessions, needle, deadline)
    history = historyResult.items
    deepTruncated = memoryResult.truncated || fileResult.truncated || historyResult.truncated
  }

  const rank = (matches: Array<{ score: number; item: SearchResultItem }>, max: number): { items: SearchResultItem[]; truncated: boolean } => {
    matches.sort((a, b) => b.score - a.score)
    return { items: matches.slice(0, max).map((entry) => entry.item), truncated: matches.length > max }
  }

  const projects = rank(projectMatches, MAX_PROJECT_RESULTS)
  const sessionResults = rank(sessionMatches, MAX_SESSION_RESULTS)

  return {
    query: query.query,
    projects: projects.items,
    sessions: sessionResults.items,
    memory,
    files,
    history,
    truncated: projects.truncated || sessionResults.truncated || deepTruncated
  }
}
