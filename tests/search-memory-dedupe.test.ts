import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Global search reports memory in its own category and has the project file walk
// skip whatever the memory pass already covered, so nothing is listed twice. The
// handshake between those two passes is the risky part: cover too little and a
// file shows up under two headings, cover too much and a file the memory pass
// never actually looked at is dropped from Files as well — findable in neither
// place, with nothing on screen to say so. These pin that boundary.
//
// Everything below search-service is mocked except the memory service itself,
// which runs for real against a temp project so the routing, the enumeration, and
// the project-relative paths the walk matches on are all genuinely exercised.

let root: string
let projectDir: string
let vaultHome: string

const location = (): { id: string; name: string; path: string; distro: null; sessions: [] } => ({
  id: 'p1',
  name: 'Fixture',
  path: projectDir,
  distro: null,
  sessions: []
})

vi.mock('../src/main/sessions/session-scan', () => ({ scanSessions: vi.fn(async () => []) }))
vi.mock('../src/main/sessions/session-service', () => ({
  getSessionHistory: vi.fn(async () => ({ entries: [] }))
}))
vi.mock('../src/main/sessions/session-metadata-service', () => ({
  getSessionMetadata: vi.fn(async () => ({ sessionAliases: {}, projectAliases: {} }))
}))
vi.mock('../src/main/projects/project-catalog-service', () => ({ listProjectCatalog: vi.fn(async () => []) }))
vi.mock('../src/main/usage/claude-jsonl', () => ({
  getDefaultClaudeProjectsRoot: (): string => join(root, 'central')
}))
vi.mock('../src/main/projects/project-locator', () => ({
  groupProjects: vi.fn(() => new Map([['p1', location()]])),
  resolveLocation: vi.fn(async () => location()),
  resolveProjectLocation: vi.fn(async () => location())
}))

// A real (tiny) file walk over the temp project, so the skip is exercised against
// paths produced the way the app produces them rather than ones written by hand.
vi.mock('../src/main/projects/project-files-service', () => ({
  listDirectory: async ({ relPath }: { relPath: string }) => {
    const dir = relPath ? join(projectDir, relPath) : projectDir
    try {
      return {
        entries: readdirSync(dir, { withFileTypes: true }).map((entry) => ({
          name: entry.name,
          kind: entry.isDirectory() ? 'dir' : 'file',
          size: entry.isDirectory() ? 0 : statSync(join(dir, entry.name)).size
        })),
        truncated: false
      }
    } catch {
      return { entries: [], truncated: false, error: 'unreadable' }
    }
  },
  readFilePreview: async ({ relPath }: { relPath: string }) => {
    try {
      return { kind: 'text', text: readFileSync(join(projectDir, relPath), 'utf-8') }
    } catch {
      return { kind: 'text', text: '' }
    }
  }
}))

const { searchWorkspace } = await import('../src/main/search/search-service')

const sender = {} as never

function marker(home: string): string {
  return `Felix memory home — Windows: \`${home}\` · WSL: \`/mnt/c/nope\``
}

async function search(query: string): Promise<{
  memory: string[]
  files: string[]
  truncated: boolean
}> {
  const results = await searchWorkspace({ platform: 'claude', projectId: 'p1', query }, sender)
  return {
    memory: results.memory.map((item) => item.id),
    files: results.files.map((item) => item.id),
    truncated: results.truncated
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cadence-memsearch-'))
  projectDir = join(root, 'project')
  vaultHome = join(root, 'vault', 'memory')
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  mkdirSync(vaultHome, { recursive: true })
  writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('memory results and file results do not overlap', () => {
  beforeEach(() => {
    writeFileSync(join(projectDir, '.claude', 'HANDOFF.md'), '# Old handoff\n\nmentions zeta once\n')
    writeFileSync(join(vaultHome, 'HANDOFF.md'), '# Live handoff\n\nmentions zeta too\n')
  })

  it('reports an in-repo memory file once, under Memory rather than Files', async () => {
    const results = await search('zeta')
    expect(results.memory).toContain('working:HANDOFF.md')
    expect(results.files).not.toContain('.claude/HANDOFF.md')
  })

  it('still reaches the live vault memory, which is not in the project at all', async () => {
    const results = await search('zeta')
    expect(results.memory).toContain('vault-hot:HANDOFF.md')
  })

  it('leaves ordinary project files to the file walk', async () => {
    writeFileSync(join(projectDir, 'notes.md'), 'zeta lives here as well\n')
    const results = await search('zeta')
    expect(results.files).toContain('notes.md')
  })

  // The file walk scores a path substring, so covering a file in Memory has to
  // score one too. Otherwise moving a file between the two categories quietly
  // narrows how it can be found.
  it('keeps matching an in-repo memory file by its path', async () => {
    const results = await search('.claude')
    expect(results.memory).toContain('working:HANDOFF.md')
  })
})

// The regression this file exists for. When the memory pass stops early — its
// time budget or its result cap — the files it never examined must stay in the
// file walk's hands. Claiming them up front made them disappear from both.
describe('memory pass that stops before examining everything', () => {
  beforeEach(() => {
    // Enumeration reads the vault home before the in-repo bank, so more matching
    // vault files than the memory result cap guarantees the loop ends before it
    // ever reaches `.claude/`.
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(vaultHome, `zeta-${String(index).padStart(2, '0')}.md`), '# vault entry\n')
    }
    writeFileSync(join(projectDir, '.claude', 'HANDOFF.md'), '# Old handoff\n\nmentions zeta once\n')
  })

  it('stops at the cap and says the results were truncated', async () => {
    const results = await search('zeta')
    expect(results.memory).toHaveLength(25)
    expect(results.truncated).toBe(true)
  })

  it('leaves the files it never examined findable under Files', async () => {
    const results = await search('zeta')
    expect(results.memory).not.toContain('working:HANDOFF.md')
    expect(results.files).toContain('.claude/HANDOFF.md')
  })
})
