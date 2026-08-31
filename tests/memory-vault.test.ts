import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The viewer used to assume every project's memory lived in its own `.claude/`
// folder. Once a project's memory moved to the vault, that folder became the
// FROZEN bank — so the Memory button showed stale, non-authoritative files and
// its Edit button wrote into a bank nothing reads. These tests pin the routing
// and the read-only rule that replaced that behaviour.
//
// project-locator reaches electron through its session-scan chain, so it is
// mocked: the service under test only needs a resolved folder, and mocking the
// locator keeps this a real end-to-end exercise of everything below it.

let root: string
let projectDir: string
let vaultHome: string

vi.mock('../src/main/projects/project-locator', () => ({
  resolveProjectLocation: vi.fn(async () => ({
    id: 'p1',
    name: 'Fixture',
    path: projectDir,
    distro: null,
    sessions: []
  }))
}))

vi.mock('../src/main/usage/claude-jsonl', () => ({
  getDefaultClaudeProjectsRoot: (): string => join(root, 'central')
}))

const { getProjectMemory, writeMemoryFile } = await import('../src/main/memory/memory-service')

const sender = {} as never

function marker(home: string): string {
  // The marker records a native path, backslashes and all — use it verbatim.
  const win = home
  return `Felix memory home — Windows: \`${win}\` · WSL: \`/mnt/c/nope\``
}

function groupIds(groups: { id: string }[]): string[] {
  return groups.map((group) => group.id)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cadence-memview-'))
  projectDir = join(root, 'project')
  vaultHome = join(root, 'vault', 'memory')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(join(projectDir, '.claude'), { recursive: true })
  mkdirSync(join(vaultHome, 'Archive'), { recursive: true })

  // The frozen in-repo bank.
  writeFileSync(join(projectDir, '.claude', 'HANDOFF.md'), '# Old handoff\n')
  writeFileSync(join(projectDir, '.claude', 'context-pins.md'), '# Old pins\n')

  // The live vault memory home.
  writeFileSync(join(vaultHome, '_Index.md'), '# Index\n')
  writeFileSync(join(vaultHome, 'HANDOFF.md'), '# Live handoff\n')
  writeFileSync(join(vaultHome, 'Pins.md'), '# Pins\n')
  writeFileSync(join(vaultHome, 'Decisions.md'), '# Decisions\n')
  writeFileSync(join(vaultHome, 'Archive', 'old-handoff.md'), '# Archived\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('vault-routed project', () => {
  beforeEach(() => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
  })

  it('lists the vault memory home, not just the in-repo bank', async () => {
    const memory = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(memory.groups)).toContain('vault-hot')

    const hot = memory.groups.find((group) => group.id === 'vault-hot')
    expect(hot?.files.map((file) => file.label).sort()).toEqual(['HANDOFF.md', 'Pins.md', '_Index.md'])

    const deeper = memory.groups.find((group) => group.id === 'vault-ondemand')
    expect(deeper?.files.map((file) => file.label)).toEqual(['Decisions.md'])

    const archive = memory.groups.find((group) => group.id === 'vault-archive')
    expect(archive?.files.map((file) => file.label)).toEqual(['old-handoff.md'])
  })

  it('keeps the old bank visible but relabels it as frozen', async () => {
    const memory = await getProjectMemory('claude', 'p1', sender)
    const working = memory.groups.find((group) => group.id === 'working')
    expect(working?.files.map((file) => file.label)).toEqual(['HANDOFF.md'])
    expect(working?.label).toContain('Frozen')
    expect(working?.readOnly).toBe(true)
  })

  it('marks vault memory read-only and says why', async () => {
    const memory = await getProjectMemory('claude', 'p1', sender)
    for (const id of ['vault-hot', 'vault-ondemand', 'vault-archive']) {
      const group = memory.groups.find((entry) => entry.id === id)
      expect(group?.readOnly, id).toBe(true)
      expect(group?.readOnlyReason, id).toBeTruthy()
    }
  })

  // The renderer hiding a button is a suggestion. This is the rule.
  it('refuses a write to vault memory even when the renderer asks', async () => {
    const before = readFileSync(join(vaultHome, 'HANDOFF.md'), 'utf-8')
    const result = await writeMemoryFile('claude', 'p1', 'vault-hot:HANDOFF.md', '# Tampered\n', sender)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('/save')
    expect(readFileSync(join(vaultHome, 'HANDOFF.md'), 'utf-8')).toBe(before)
  })

  it('refuses a write to the frozen bank', async () => {
    const result = await writeMemoryFile('claude', 'p1', 'working:HANDOFF.md', '# Tampered\n', sender)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(projectDir, '.claude', 'HANDOFF.md'), 'utf-8')).toBe('# Old handoff\n')
  })

  it('still allows editing the project instructions', async () => {
    const result = await writeMemoryFile('claude', 'p1', 'instructions:CLAUDE.md', '# Edited\n', sender)
    expect(result.ok).toBe(true)
  })
})

// The route that made the first attempt at this change a no-op. A project can
// carry a valid marker whose home does not resolve HERE — a second machine, a
// drive still syncing, WSL not running, an unclosed code fence swallowing the
// marker line. Treating that as "never migrated" shows the frozen bank under its
// ordinary heading, editable, with nothing to say the live memory is missing:
// the original defect, reachable in ordinary multi-machine use.
describe('vault marker that does not resolve here', () => {
  beforeEach(() => {
    const missing = join(root, 'vault', 'gone', 'memory')
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(missing)}\n`)
  })

  it('shows no vault groups, because there are none to show', async () => {
    const memory = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(memory.groups)).not.toContain('vault-hot')
  })

  it('still treats the old bank as frozen rather than as live memory', async () => {
    const memory = await getProjectMemory('claude', 'p1', sender)
    const working = memory.groups.find((group) => group.id === 'working')
    expect(working?.label).toContain('Frozen')
    expect(working?.readOnly).toBe(true)
  })

  it('refuses to write to the bank, so a stale edit cannot land', async () => {
    const result = await writeMemoryFile('claude', 'p1', 'working:HANDOFF.md', '# Tampered\n', sender)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(projectDir, '.claude', 'HANDOFF.md'), 'utf-8')).toBe('# Old handoff\n')
  })

  // The engine composes this message to name what it tried and what to fix.
  // Dropping it leaves the user with a frozen bank and no way to know why.
  it('surfaces the engine reason so the user knows what to fix', async () => {
    const memory = await getProjectMemory('claude', 'p1', sender)
    expect(memory.unresolvedVaultReason).toBeTruthy()
    expect(memory.unresolvedVaultReason).toContain('no memory home resolved')
  })
})

describe('marker-shaped text that is not a marker', () => {
  // resolveRoute aborts rather than falling back, precisely so a damaged marker
  // cannot silently demote a migrated project to its frozen bank.
  it('aborts rather than treating the project as never migrated', async () => {
    writeFileSync(
      join(projectDir, 'CLAUDE.md'),
      '# Project\n\nFelix memory home - Windows: nowhere\n'
    )
    const memory = await getProjectMemory('claude', 'p1', sender)
    const working = memory.groups.find((group) => group.id === 'working')
    expect(working?.readOnly).toBe(true)
    expect(memory.unresolvedVaultReason).toBeTruthy()
  })
})

describe('legacy-root project', () => {
  // No marker and no `.claude/HANDOFF.md`: the engine routes to legacy-root. The
  // viewer must not invent a vault or lock anything.
  it('leaves everything editable and unlabelled', async () => {
    rmSync(join(projectDir, '.claude', 'HANDOFF.md'))
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n')
    const memory = await getProjectMemory('claude', 'p1', sender)
    expect(memory.unresolvedVaultReason).toBeUndefined()
    const pins = memory.groups.find((group) => group.id === 'pins')
    expect(pins?.readOnly).toBe(false)
    expect(pins?.label).not.toContain('Frozen')
  })
})

describe('project that has not migrated', () => {
  it('behaves exactly as before: live bank, editable, no vault groups', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nNo marker here.\n')

    const memory = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(memory.groups)).not.toContain('vault-hot')

    const working = memory.groups.find((group) => group.id === 'working')
    expect(working?.label).toBe('Working memory')
    expect(working?.readOnly).toBe(false)

    const result = await writeMemoryFile('claude', 'p1', 'working:HANDOFF.md', '# Edited\n', sender)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(projectDir, '.claude', 'HANDOFF.md'), 'utf-8')).toBe('# Edited\n')
  })
})
