import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installManagedMergeReviewWorkflow,
  mergeReviewSkillTargets
} from '../src/main/merge-review/merge-review-workflow'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cadence-merge-review-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Cadence-managed merge-review workflow', () => {
  it('installs the same dormant, environment-gated skill for Codex and Claude', async () => {
    const home = await temporaryDirectory()
    const targets = mergeReviewSkillTargets(home)
    const first = await installManagedMergeReviewWorkflow(home)

    expect(first.changed).toEqual(targets)
    const contents = await Promise.all(targets.map((path) => readFile(path, 'utf-8')))
    expect(new Set(contents).size).toBe(1)
    expect(contents[0]).toMatch(/^---\nname: cadence-merge-review\n/)
    expect(contents[0]).toContain('CADENCE_MERGE_REVIEW_ENABLED')
    expect(contents[0]).toContain('exact head commit SHA')
    expect(contents[0]).toContain('`PASS`, `BLOCK`, or `ESCALATE`')

    expect((await installManagedMergeReviewWorkflow(home)).changed).toEqual([])
  })

  it('repairs a stale provider copy without rewriting the current copy', async () => {
    const home = await temporaryDirectory()
    const targets = mergeReviewSkillTargets(home)
    await installManagedMergeReviewWorkflow(home)
    const current = await readFile(targets[1], 'utf-8')
    await writeFile(targets[0], 'stale\n', 'utf-8')

    const repaired = await installManagedMergeReviewWorkflow(home)
    expect(repaired.changed).toEqual([targets[0]])
    expect(await readFile(targets[0], 'utf-8')).toBe(current)
    expect(dirname(targets[0])).toContain('cadence-merge-review')
  })
})
