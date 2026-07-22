import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import startSkill from './managed-workflow/skills/start/SKILL.md?raw'
import saveSkill from './managed-workflow/skills/save/SKILL.md?raw'
import saveCollector from './managed-workflow/scripts/collect-vault-save.mjs?raw'
import routeResolver from './managed-workflow/scripts/resolve-memory-route.mjs?raw'
import vaultBootstrap from './managed-workflow/scripts/bootstrap-vault-memory.mjs?raw'
import startCommand from './managed-workflow/commands/start.md?raw'
import saveCommand from './managed-workflow/commands/save.md?raw'
import mergeReviewSkill from '../merge-review/managed-workflow/SKILL.md?raw'

export type ManagedOpenCodeWorkflowFile = {
  relativePath: string
  content: string
}

function normalizedContent(content: string): string {
  return `${content.replace(/\r\n/g, '\n').trimEnd()}\n`
}

export const MANAGED_OPENCODE_WORKFLOW_FILES: readonly ManagedOpenCodeWorkflowFile[] = [
  { relativePath: join('skills', 'start', 'SKILL.md'), content: normalizedContent(startSkill) },
  { relativePath: join('skills', 'save', 'SKILL.md'), content: normalizedContent(saveSkill) },
  { relativePath: join('commands', 'start.md'), content: normalizedContent(startCommand) },
  { relativePath: join('commands', 'save.md'), content: normalizedContent(saveCommand) },
  { relativePath: join('skills', 'cadence-merge-review', 'SKILL.md'), content: normalizedContent(mergeReviewSkill) },
  // The canonical vault save engine, shared byte-identically with the Claude and
  // Codex skills. OpenCode's save drives this same collector so all three
  // platforms cannot diverge in write behaviour. Keep it in sync with
  // ~/.claude/skills/save/scripts/ and ~/.codex/skills/save/scripts/.
  { relativePath: join('scripts', 'collect-vault-save.mjs'), content: normalizedContent(saveCollector) },
  // Memory-home routing for both skills. Kept as a script rather than inline in
  // the skills because two prose-embedded shell versions each misrouted on
  // well-formed input; here it is unit-tested directly and cannot drift between
  // the start and save copies.
  { relativePath: join('scripts', 'resolve-memory-route.mjs'), content: normalizedContent(routeResolver) },
  // Creates a project's vault memory home on its first save. Without this, an
  // unmigrated project had nowhere legitimate to save to, which is what made a
  // legacy-bank write destination necessary in the first place.
  { relativePath: join('scripts', 'bootstrap-vault-memory.mjs'), content: normalizedContent(vaultBootstrap) }
]

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

export async function installManagedOpenCodeMemoryBankWorkflow(
  configDir: string
): Promise<{ changed: string[] }> {
  const results = await Promise.all(
    MANAGED_OPENCODE_WORKFLOW_FILES.map(async (file) => ({
      relativePath: file.relativePath,
      changed: await writeManagedFile(join(configDir, file.relativePath), file.content)
    }))
  )
  return {
    changed: results.filter((result) => result.changed).map((result) => result.relativePath)
  }
}

