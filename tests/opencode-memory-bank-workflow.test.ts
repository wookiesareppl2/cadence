import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installManagedOpenCodeMemoryBankWorkflow,
  MANAGED_OPENCODE_WORKFLOW_FILES
} from '../src/main/opencode/opencode-memory-bank-workflow'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cadence-opencode-workflow-'))
  temporaryDirectories.push(path)
  return path
}

function portable(path: string): string {
  return path.replace(/\\/g, '/')
}

function managedContent(relativePath: string): string {
  const match = MANAGED_OPENCODE_WORKFLOW_FILES.find(
    (file) => portable(file.relativePath) === relativePath
  )
  if (!match) throw new Error(`Missing managed workflow resource: ${relativePath}`)
  return match.content
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

// The routing block is the load-bearing part of both skills: it decides whether a
// save writes to the live vault or to a project's frozen .claude/ bank. String
// assertions cannot catch a behavioural regression in it (swapping the branch
// order, or mis-extracting the path, reads just as well), so extract the real
// block and execute it.
function routingBlock(skill: string): string {
  const match = skill.match(/```bash\n([\s\S]*?)\n```/)
  if (!match) throw new Error('No bash routing block found in skill')
  return match[1]
}

// Resolve a POSIX shell explicitly. A bare 'bash' on Windows can resolve to the
// WSL launcher (C:\Windows\System32\bash.exe), which blocks indefinitely under
// execFileSync. Every call is also given a timeout so this suite can never hang.
function resolveBash(): string | undefined {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Git\\usr\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']
      : ['/bin/bash', '/usr/bin/bash', 'bash']
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-c', 'exit 0'], { stdio: 'pipe', timeout: 10_000 })
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}

const BASH = resolveBash()
const HAS_BASH = BASH !== undefined

function sh(args: string[], cwd: string): string {
  // Git Bash invoked non-interactively inherits Node's Windows PATH, which omits
  // Git's usr/bin — awk, grep and sed would all be "command not found". Put the
  // shell's own bin directory on PATH rather than using a login shell, which
  // could change the working directory out from under the fixture.
  const binDir = dirname(BASH as string)
  return execFileSync(BASH as string, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` }
  })
}

function posixPath(directory: string): string {
  return sh(['-c', 'pwd -P'], directory).trim()
}

function route(block: string, cwd: string): { route: string; home: string } {
  const out = sh(['-c', block], cwd)
  return {
    route: out.match(/MEMORY_ROUTE=([a-z-]+)/)?.[1] ?? '',
    home: out.match(/MEMORY_HOME=(.*)/)?.[1]?.trim() ?? ''
  }
}

function marker(wslPath: string): string {
  return `Felix memory home — Windows: \`C:\\x\` · WSL: \`${wslPath}\`\n`
}

describe('Cadence-managed OpenCode workflow', () => {
  it('bundles the canonical memory commands and merge-review gate', () => {
    expect(MANAGED_OPENCODE_WORKFLOW_FILES.map((file) => portable(file.relativePath))).toEqual([
      'skills/start/SKILL.md',
      'skills/save/SKILL.md',
      'commands/start.md',
      'commands/save.md',
      'skills/cadence-merge-review/SKILL.md',
      'scripts/collect-vault-save.mjs'
    ])

    const startSkill = managedContent('skills/start/SKILL.md')
    const saveSkill = managedContent('skills/save/SKILL.md')
    expect(startSkill).toMatch(/^---\nname: start\n/)
    expect(saveSkill).toMatch(/^---\nname: save\n/)
    expect(startSkill).toContain('subagent_type="deep-fixer"')
    expect(saveSkill).toContain('subagent_type="deep-fixer"')
    expect(startSkill).toContain('run_in_background=false')
    expect(saveSkill).toContain('run_in_background=false')
    expect(startSkill).toContain('load_skills=[]')
    expect(saveSkill).toContain('load_skills=[]')
    expect(startSkill).not.toContain('run_in_background=true')
    expect(saveSkill).not.toContain('run_in_background=true')
    expect(startSkill).toContain('START_ABORTED_NO_WORKER')
    expect(saveSkill).toContain('SAVE_ABORTED_NO_WORKER')

    expect(managedContent('commands/start.md')).toContain('`start` skill')
    expect(managedContent('commands/save.md')).toContain('`save` skill')
    expect(managedContent('commands/start.md')).toContain('$ARGUMENTS')
    expect(managedContent('commands/save.md')).toContain('$ARGUMENTS')
    expect(managedContent('skills/cadence-merge-review/SKILL.md')).toContain(
      'CADENCE_MERGE_REVIEW_ENABLED'
    )
  })

  it('routes start and save to the Felix vault memory home, not the frozen .claude bank', () => {
    const startSkill = managedContent('skills/start/SKILL.md')
    const saveSkill = managedContent('skills/save/SKILL.md')

    // Routing must be COMPUTED, not inferred. A model running these skills once
    // skipped the marker check, tested `.claude/HANDOFF.md` first, and routed to
    // Legacy Bank Mode on a vault project — which on a save would write this
    // session's memory into the frozen bank. The route is therefore emitted by a
    // mandatory first command whose output the worker must use verbatim.
    for (const skill of [startSkill, saveSkill]) {
      expect(skill).toContain('MANDATORY FIRST TOOL CALL')
      expect(skill).toContain('Felix memory home')
      expect(skill).toContain('<MEMORY_HOME>')
      expect(skill).toContain('MEMORY_ROUTE=vault')
      expect(skill).toContain('MEMORY_ROUTE=legacy-bank')
      expect(skill).toContain('MEMORY_ROUTE=legacy-root')
      expect(skill).toContain('MEMORY_ROUTE=abort')
      expect(skill).toContain('Legacy Bank Mode')
      expect(skill).toContain('Legacy Root Mode')
      // The regression guard: a vault route must win even though the frozen
      // bank's HANDOFF.md exists alongside it.
      expect(skill).toContain('is **forbidden** in this case')
      // The contract must be copied, not remembered. Paraphrasing it is how the
      // forbidden port-3000 fallback reappeared in a delegated worker prompt.
      expect(skill).toContain('verbatim')
      expect(skill).toContain('do not paraphrase')
    }

    expect(startSkill).toContain('START_ABORTED_BAD_ROUTE')
    expect(saveSkill).toContain('SAVE_ABORTED_BAD_ROUTE')
    // The save skill carries the stronger no-write wording, since it is the one
    // that can destroy memory by routing wrong.
    expect(saveSkill).toContain('never write to it')

    // Fidelity resolves to exactly two values. `high` is an input alias only and
    // must never be reported back, which a shipped build did on every run.
    expect(startSkill).toContain('Resolved fidelity')
    expect(startSkill).toContain('deprecated alias')
    expect(startSkill).toContain('report the fidelity as `high`')
    expect(startSkill).toContain('`lean` and `max` are the only two resolved values')

    // Save must drive the shared collector engine end to end and never hand-edit.
    expect(saveSkill).toContain('scripts/collect-vault-save.mjs')
    expect(saveSkill).toContain('--mode state')
    expect(saveSkill).toContain('--mode apply')
    expect(saveSkill).toContain('--mode validate')
    expect(saveSkill).toContain('SAVE_VALIDATION=PASS')
    expect(saveSkill).toContain('NEVER hand-edits')
  })

  it('keeps the start and save routing blocks byte-identical', () => {
    // Divergence here is a defect: save is the copy that can destroy memory, so a
    // one-sided edit to start would leave the dangerous path unprotected.
    expect(routingBlock(managedContent('skills/save/SKILL.md'))).toBe(
      routingBlock(managedContent('skills/start/SKILL.md'))
    )
  })

  it.runIf(HAS_BASH)('resolves the memory route correctly when executed', async () => {
    const block = routingBlock(managedContent('skills/start/SKILL.md'))
    const root = await temporaryDirectory()
    const base = posixPath(root)

    const fixture = async (
      name: string,
      files: Record<string, string>,
      dirs: string[] = []
    ): Promise<string> => {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      for (const d of dirs) await mkdir(join(dir, d), { recursive: true })
      for (const [rel, body] of Object.entries(files)) {
        const target = join(dir, rel)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, body, 'utf-8')
      }
      return dir
    }

    // The production regression: a vault marker and the frozen bank's HANDOFF.md
    // both present. A shipped build routed this to legacy-bank, which on a save
    // would have written the session's memory into the frozen bank.
    const both = await fixture(
      'both',
      { 'CLAUDE.md': marker(`${base}/both/mem`), '.claude/HANDOFF.md': 'x\n' },
      ['mem']
    )
    expect(route(block, both).route).toBe('vault')

    // A project nested below an outer directory must use its OWN baseline.
    const nested = await fixture(
      'outer/inner',
      { 'CLAUDE.md': marker(`${base}/outer/inner/mem`), '.claude/HANDOFF.md': 'x\n' },
      ['mem']
    )
    expect(route(block, nested).route).toBe('vault')

    // Running from a subdirectory must still find the project baseline above it.
    await mkdir(join(both, 'src', 'deep'), { recursive: true })
    expect(route(block, join(both, 'src', 'deep')).route).toBe('vault')

    // An earlier backticked absolute path must not hijack the extraction — the
    // path after the WSL: label is the only valid one.
    const hijack = await fixture(
      'hijack',
      {
        'CLAUDE.md': `Felix memory home — see \`/etc\` first · Windows: \`C:\\x\` · WSL: \`${base}/hijack/mem\`\n`
      },
      ['mem']
    )
    const hijackResult = route(block, hijack)
    expect(hijackResult.route).toBe('vault')
    expect(hijackResult.home).toBe(`${base}/hijack/mem`)

    // A marker inside a fenced code block is documentation, not configuration.
    const fenced = await fixture(
      'fenced',
      {
        'CLAUDE.md': `\`\`\`\n${marker(`${base}/fenced/mem`)}\`\`\`\n`,
        '.claude/HANDOFF.md': 'x\n'
      },
      ['mem']
    )
    expect(route(block, fenced).route).toBe('legacy-bank')

    // Marker-like text that fails to parse must abort, never silently fall back
    // to the frozen bank — that fallback is the original failure mode.
    const reworded = await fixture('reworded', {
      'CLAUDE.md': 'FELIX MEMORY HOME - Windows: `C:\\x` WSL: `/nope`\n',
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(route(block, reworded).route).toBe('abort')

    // A marker pointing at a nonexistent home aborts rather than guessing.
    const missing = await fixture('missing', {
      'CLAUDE.md': marker(`${base}/missing/not-there`),
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(route(block, missing).route).toBe('abort')

    // Legacy routes still work.
    const bank = await fixture('bank', {
      'CLAUDE.md': '# no marker\n',
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(route(block, bank).route).toBe('legacy-bank')

    const rootOnly = await fixture('rootonly', { 'CLAUDE.md': '# no marker\n' })
    expect(route(block, rootOnly).route).toBe('legacy-root')

    // Paths containing spaces are real: the live memory home has them.
    const spaced = await fixture(
      'spaced',
      { 'CLAUDE.md': marker(`${base}/spaced/04 - Personal Projects/mem`) },
      ['04 - Personal Projects/mem']
    )
    const spacedResult = route(block, spaced)
    expect(spacedResult.route).toBe('vault')
    expect(spacedResult.home).toBe(`${base}/spaced/04 - Personal Projects/mem`)
  })

  it('ships the canonical vault save collector as pure LF, content intact', async () => {
    const managed = managedContent('scripts/collect-vault-save.mjs')
    const source = await readFile(
      join(__dirname, '..', 'src', 'main', 'opencode', 'managed-workflow', 'scripts', 'collect-vault-save.mjs'),
      'utf-8'
    )
    // Git checks this out with CRLF under core.autocrlf, so assert the delivered
    // file is pure LF with content otherwise intact. That is what keeps the
    // installed collector byte-identical to the Claude and Codex copies.
    expect(managed).not.toContain('\r')
    expect(managed.endsWith('\n')).toBe(true)
    expect(managed).toBe(`${source.replace(/\r\n/g, '\n').trimEnd()}\n`)
    // Spot-check the engine surface the save skill depends on.
    expect(managed).toContain("mode === 'apply'")
    expect(managed).toContain("mode === 'validate'")
    expect(managed).toContain('APPLIED_CHANGED=')
  })

  it('installs, leaves current resources untouched, and repairs stale resources', async () => {
    const configDir = await temporaryDirectory()
    const first = await installManagedOpenCodeMemoryBankWorkflow(configDir)
    expect(first.changed.map(portable)).toEqual([
      'skills/start/SKILL.md',
      'skills/save/SKILL.md',
      'commands/start.md',
      'commands/save.md',
      'skills/cadence-merge-review/SKILL.md',
      'scripts/collect-vault-save.mjs'
    ])

    const second = await installManagedOpenCodeMemoryBankWorkflow(configDir)
    expect(second.changed).toEqual([])

    const startCommandPath = join(configDir, 'commands', 'start.md')
    await writeFile(startCommandPath, 'stale\n', 'utf-8')
    const repaired = await installManagedOpenCodeMemoryBankWorkflow(configDir)
    expect(repaired.changed.map(portable)).toEqual(['commands/start.md'])
    expect(await readFile(startCommandPath, 'utf-8')).toBe(managedContent('commands/start.md'))
  })
})

