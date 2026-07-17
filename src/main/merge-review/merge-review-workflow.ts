import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import mergeReviewSkill from './managed-workflow/SKILL.md?raw'

export const CADENCE_MERGE_REVIEW_SKILL_NAME = 'cadence-merge-review'

function normalizedContent(content: string): string {
  return `${content.replace(/\r\n/g, '\n').trimEnd()}\n`
}

async function writeManagedFile(path: string, content: string): Promise<boolean> {
  try {
    if ((await readFile(path, 'utf-8')) === content) return false
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code !== 'ENOENT') throw error
  }

  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.cadence.tmp`
  try {
    await writeFile(temporaryPath, content, 'utf-8')
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  return true
}

export function mergeReviewSkillTargets(home = homedir()): string[] {
  return [
    join(home, '.codex', 'skills', CADENCE_MERGE_REVIEW_SKILL_NAME, 'SKILL.md'),
    join(home, '.claude', 'skills', CADENCE_MERGE_REVIEW_SKILL_NAME, 'SKILL.md')
  ]
}

export async function installManagedMergeReviewWorkflow(home = homedir()): Promise<{ changed: string[] }> {
  const content = normalizedContent(mergeReviewSkill)
  const targets = mergeReviewSkillTargets(home)
  const results = await Promise.all(
    targets.map(async (path) => ({ path, changed: await writeManagedFile(path, content) }))
  )
  return { changed: results.filter((result) => result.changed).map((result) => result.path) }
}
