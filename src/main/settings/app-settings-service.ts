import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  normalizeAppSettings,
  normalizeAppSettingsUpdate,
  type AppSettings,
  type AppSettingsUpdate
} from '@shared/app-settings'

const SETTINGS_FILENAME = 'settings.json'
let updateQueue: Promise<AppSettings> = Promise.resolve(normalizeAppSettings(null))

export function appSettingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILENAME)
}

export async function readAppSettings(path = appSettingsPath()): Promise<AppSettings> {
  try {
    return normalizeAppSettings(JSON.parse(await readFile(path, 'utf-8')))
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ENOENT' || error instanceof SyntaxError) return normalizeAppSettings(null)
    throw error
  }
}

async function writeAppSettings(settings: AppSettings, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.cadence.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
    await rename(temporaryPath, path)
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
}

export function updateAppSettings(update: AppSettingsUpdate, path = appSettingsPath()): Promise<AppSettings> {
  const normalizedUpdate = normalizeAppSettingsUpdate(update)
  updateQueue = updateQueue
    .catch(() => readAppSettings(path))
    .then(async () => {
      const current = await readAppSettings(path)
      const next = normalizeAppSettings({ ...current, ...normalizedUpdate })
      await writeAppSettings(next, path)
      return next
    })
  return updateQueue
}
