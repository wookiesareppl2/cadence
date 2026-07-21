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

    // Vault Mode must be the first-choice route in both skills, selecting the WSL
    // path form (OpenCode runs under WSL). Without this, a save would silently
    // target the project's frozen .claude/ bank instead of the vault.
    for (const skill of [startSkill, saveSkill]) {
      expect(skill).toContain('Felix memory home')
      expect(skill).toContain('<MEMORY_HOME>')
      expect(skill).toContain('select the WSL path')
      expect(skill).toContain('Legacy Bank Mode')
      expect(skill).toContain('Legacy Root Mode')
    }

    // Fidelity naming must match the Claude/Codex skills: lean default, high is a
    // deprecated alias, max is the only full-read authorisation.
    expect(startSkill).toContain('/start lean')
    expect(startSkill).toContain('deprecated compatibility alias')
    expect(startSkill).toContain('/start max')

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

