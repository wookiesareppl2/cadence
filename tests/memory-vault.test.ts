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

const { getProjectMemory, listMemorySearchTargets, writeMemoryFile } = await import(
  '../src/main/memory/memory-service'
)

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

// Resolving the route reads files synchronously on the main thread — the engine's
// callback interface is sync by design — so for a WSL project it stats a UNC path
// and can stall the window. Opening the viewer and clicking files asks the same
// question repeatedly, so the answer is cached briefly. What must NOT be cached is
// the decision that gates writing.
describe('route caching', () => {
  it('does not let a cached route decide that a locked file is writable', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nNo marker yet.\n')
    // Warm the cache while the project is still unmigrated and its bank editable.
    const before = await getProjectMemory('claude', 'p1', sender)
    expect(before.groups.find((group) => group.id === 'working')?.readOnly).toBe(false)

    // The project migrates. A cached answer would still call the bank editable.
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
    const result = await writeMemoryFile('claude', 'p1', 'working:HANDOFF.md', '# Tampered\n', sender)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(projectDir, '.claude', 'HANDOFF.md'), 'utf-8')).toBe('# Old handoff\n')
  })

  // Finding A. The marker is read from BOTH CLAUDE.md and .claude/CLAUDE.md, and
  // the second is an ordinary editable file in the `other` group. Invalidating only
  // on the `instructions` group left this write changing the routing without
  // clearing the answer — so the viewer kept showing the old routing afterwards.
  it('stops showing the old routing after any write that changes it', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nNo marker yet.\n')
    await getProjectMemory('claude', 'p1', sender) // warm the cache

    const write = await writeMemoryFile(
      'claude',
      'p1',
      'other:CLAUDE.md',
      `# Baseline\n\n${marker(vaultHome)}\n`,
      sender
    )
    expect(write.ok).toBe(true)

    const after = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(after.groups)).toContain('vault-hot')
  })

  // Finding B. The TTL must be measured on a monotonic clock: a backwards
  // wall-clock jump makes a Date-based age negative, so the entry never looks
  // expired and stays pinned until the clock catches up.
  it('expires on schedule even when the wall clock jumps backwards', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nNo marker yet.\n')
    vi.useFakeTimers()
    try {
      await getProjectMemory('claude', 'p1', sender) // warm

      // The project migrates, and the machine's clock is corrected backwards by an
      // hour. Under Date.now() the cached entry would now look an hour from expiry.
      writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
      vi.setSystemTime(new Date(Date.now() - 60 * 60 * 1000))
      vi.advanceTimersByTime(6_000)

      const after = await getProjectMemory('claude', 'p1', sender)
      expect(groupIds(after.groups)).toContain('vault-hot')
    } finally {
      vi.useRealTimers()
    }
  })

  // A write that throws can still have truncated or partly written the file, so
  // the routing resolved before it is no longer a statement about what is on
  // disk. The success path drops the entry; the failure path has to as well.
  //
  // Forcing a real failure: make the target a directory, so writeFile fails with
  // EISDIR. That is a failure before any bytes land rather than a partial write,
  // but it exercises the same path — the catch — and a partial write cannot be
  // provoked deterministically here.
  it('drops the cached routing when a write fails', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nNo marker yet.\n')
    mkdirSync(join(projectDir, '.claude', 'notes.md'))
    await getProjectMemory('claude', 'p1', sender) // warm the cache

    const failed = await writeMemoryFile('claude', 'p1', 'other:notes.md', '# Nope\n', sender)
    expect(failed.ok).toBe(false)

    // The project's routing changes while nothing else touches the cache. Only a
    // cache dropped by the failed write lets this be seen inside the TTL.
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
    const after = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(after.groups)).toContain('vault-hot')
  })

  it('still serves a warm read without re-resolving', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
    const first = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(first.groups)).toContain('vault-hot')

    // Remove the marker WITHOUT going through the service, so nothing invalidates.
    // Within the TTL the viewer should still show the routing it last resolved.
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nMarker removed.\n')
    const second = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(second.groups)).toContain('vault-hot')
  })

  it('stops showing the old routing once the marker file itself is edited', async () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Project\n\nNo marker yet.\n')
    await getProjectMemory('claude', 'p1', sender) // warm

    // Edit CLAUDE.md through the viewer, which is how a marker would be added.
    const write = await writeMemoryFile(
      'claude',
      'p1',
      'instructions:CLAUDE.md',
      `# Project\n\n${marker(vaultHome)}\n`,
      sender
    )
    expect(write.ok).toBe(true)

    const after = await getProjectMemory('claude', 'p1', sender)
    expect(groupIds(after.groups)).toContain('vault-hot')
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

// What global search indexes under "Memory". The point of the category is reach:
// a migrated project's live memory is not in the project folder, so the file walk
// that powers the Files category cannot see it at all. These pin both halves —
// that the out-of-project files are offered, and that the in-project ones are
// marked as such so the walk can skip them instead of listing them twice.
describe('memory search targets', () => {
  const location = (): { id: string; name: string; path: string; distro: null; sessions: [] } => ({
    id: 'p1',
    name: 'Fixture',
    path: projectDir,
    distro: null,
    sessions: []
  })

  describe('vault-routed project', () => {
    beforeEach(() => {
      writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(vaultHome)}\n`)
    })

    it('reaches the live vault memory the project file walk cannot see', async () => {
      const targets = await listMemorySearchTargets(location() as never)
      const ids = targets.map((entry) => entry.id)
      expect(ids).toContain('vault-hot:HANDOFF.md')
      expect(ids).toContain('vault-ondemand:Decisions.md')
      expect(ids).toContain('vault-archive:old-handoff.md')
    })

    it('marks vault files as outside the project, so nothing is skipped by mistake', async () => {
      const targets = await listMemorySearchTargets(location() as never)
      for (const entry of targets.filter((file) => file.group.startsWith('vault-'))) {
        expect(entry.projectRelPath, entry.id).toBeNull()
      }
    })

    // The frozen bank IS in the project folder, so the file walk would find it
    // too. The relative path is what lets the walk skip it and leave the row to
    // the Memory section instead of printing it under two headings.
    it('gives in-project memory a project-relative path the file walk can match', async () => {
      const targets = await listMemorySearchTargets(location() as never)
      const bank = targets.find((entry) => entry.id === 'working:HANDOFF.md')
      expect(bank?.projectRelPath).toBe('.claude/HANDOFF.md')

      const instructions = targets.find((entry) => entry.id === 'instructions:CLAUDE.md')
      expect(instructions?.projectRelPath).toBe('CLAUDE.md')
    })

    it('labels a result with the heading the viewer would show it under', async () => {
      const targets = await listMemorySearchTargets(location() as never)
      expect(targets.find((entry) => entry.id === 'working:HANDOFF.md')?.groupLabel).toContain('Frozen')
      expect(targets.find((entry) => entry.id === 'vault-hot:HANDOFF.md')?.groupLabel).not.toContain('Frozen')
    })

    // Two files named HANDOFF.md — one live, one frozen. They must stay separable,
    // or a search result opens the wrong one.
    it('keeps same-named live and frozen files distinct', async () => {
      const targets = await listMemorySearchTargets(location() as never)
      const handoffs = targets.filter((entry) => entry.label === 'HANDOFF.md')
      expect(handoffs).toHaveLength(2)
      expect(new Set(handoffs.map((entry) => entry.id)).size).toBe(2)
    })
  })

  describe('project whose vault home does not resolve here', () => {
    it('offers the frozen bank rather than nothing at all', async () => {
      const missing = join(root, 'vault', 'gone', 'memory')
      writeFileSync(join(projectDir, 'CLAUDE.md'), `# Project\n\n${marker(missing)}\n`)
      const targets = await listMemorySearchTargets(location() as never)
      expect(targets.map((entry) => entry.id)).toContain('working:HANDOFF.md')
      expect(targets.some((entry) => entry.group.startsWith('vault-'))).toBe(false)
    })
  })
})
