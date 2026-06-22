import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { unwatchProjectFiles, watchProjectFiles } from '../src/main/projects/project-file-watch-service'
import type { ProjectFileChangedEvent } from '../src/shared/project-files'

type SentChange = {
  channel: string
  payload: ProjectFileChangedEvent
}

function makeWebContents() {
  const sent: SentChange[] = []
  return {
    sent,
    webContents: {
      id: Math.floor(Math.random() * 1_000_000),
      isDestroyed: () => false,
      once: () => undefined,
      send: (channel: string, payload: ProjectFileChangedEvent) => {
        sent.push({ channel, payload })
      }
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2500): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return predicate()
}

describe('watchProjectFiles', () => {
  it('emits a change when a text file is created in the watched root', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'cadence-watch-'))
    const fake = makeWebContents()

    try {
      const result = await watchProjectFiles({ rootPath, distro: null }, fake.webContents as never)
      expect(result.ok).toBe(true)

      await writeFile(join(rootPath, 'follow-edits-smoke.ts'), 'export const value = 1\n')

      const received = await waitFor(() =>
        fake.sent.some(
          (event) =>
            event.channel === 'project-files:changed' &&
            event.payload.relPath === 'follow-edits-smoke.ts'
        )
      )
      expect(received).toBe(true)
    } finally {
      unwatchProjectFiles(fake.webContents as never)
      await rm(rootPath, { recursive: true, force: true })
    }
  })
})
