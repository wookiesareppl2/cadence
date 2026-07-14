import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import startSkill from './managed-workflow/skills/start/SKILL.md?raw'
import saveSkill from './managed-workflow/skills/save/SKILL.md?raw'
import startCommand from './managed-workflow/commands/start.md?raw'
import saveCommand from './managed-workflow/commands/save.md?raw'

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
  { relativePath: join('commands', 'save.md'), content: normalizedContent(saveCommand) }
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

