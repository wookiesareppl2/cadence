import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClaudeSession } from '../src/main/sessions/session-service'

// A session's project is derived from the `cwd` recorded in its transcript. Claude
// writes a cwd on every row, and the shell can `cd` mid-session, so the session
// must be pinned to the LAUNCH directory (first cwd), never the last — otherwise a
// stray `cd` (e.g. into `~/.claude/...`) makes the whole session hop projects.
describe('readClaudeSession cwd attribution', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cadence-cwd-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeTranscript(lines: object[]): Promise<string> {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n'), 'utf-8')
    return path
  }

  it('pins to the launch cwd even when the shell cd-s away later', async () => {
    const launch = 'C:\\Projects\\cadence'
    const path = await writeTranscript([
      { type: 'user', cwd: launch, timestamp: '2026-07-01T01:00:00.000Z', message: { content: 'start' } },
      { type: 'assistant', cwd: launch, timestamp: '2026-07-01T01:00:01.000Z', message: { content: 'ok' } },
      // A diagnostic / skill `cd` drags the shell into the agent-metadata tree.
      { type: 'user', cwd: 'C:\\Users\\sheld\\.claude\\projects\\x', timestamp: '2026-07-01T01:05:00.000Z', message: { content: 'more' } }
    ])

    const draft = await readClaudeSession(path)
    expect(draft?.cwd).toBe(launch)
  })

  it('uses the first cwd row when the earliest rows have none', async () => {
    const launch = 'C:\\Projects\\cadence'
    const path = await writeTranscript([
      { type: 'summary', summary: 'no cwd here' },
      { type: 'user', cwd: launch, timestamp: '2026-07-01T01:00:00.000Z', message: { content: 'start' } },
      { type: 'user', cwd: 'C:\\Somewhere\\else', timestamp: '2026-07-01T01:05:00.000Z', message: { content: 'later' } }
    ])

    const draft = await readClaudeSession(path)
    expect(draft?.cwd).toBe(launch)
  })
})
