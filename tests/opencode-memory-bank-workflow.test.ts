import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

