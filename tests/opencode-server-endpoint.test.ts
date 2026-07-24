import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVER_ENDPOINT_FILE, formatServerEndpoint } from '../src/main/opencode/opencode-runtime'

// The managed OpenCode server runs on a fresh random port every start. The bug this
// guards against: the terminal's `opencode` wrapper baked that port at creation
// time, so any server move (a health restart, or a second Cadence instance) left
// the terminal attached to a dead port — a spinner that never resolves and an
// interrupt that never lands. The fix publishes the live address to a file and has
// the wrapper read it at launch time. Writer and reader must agree on that format.

describe('OpenCode server endpoint file', () => {
  it('formats a two-line KEY=value file', () => {
    expect(formatServerEndpoint('http://127.0.0.1:53383', 'deadbeef')).toBe(
      'CADENCE_OPENCODE_URL=http://127.0.0.1:53383\nCADENCE_OPENCODE_PASSWORD=deadbeef\n'
    )
  })

  it('round-trips through the exact extraction the wrapper performs', () => {
    // Mirror of the wrapper's `sed -n 's/^KEY=//p'` on each line.
    const content = formatServerEndpoint('http://127.0.0.1:49812', 'a1b2c3')
    const extract = (key: string): string | undefined =>
      content.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]
    expect(extract('CADENCE_OPENCODE_URL')).toBe('http://127.0.0.1:49812')
    expect(extract('CADENCE_OPENCODE_PASSWORD')).toBe('a1b2c3')
  })
})

describe('OpenCode terminal wrapper (terminal-worker.cjs)', () => {
  const worker = readFileSync(
    join(__dirname, '..', 'src', 'main', 'terminal', 'terminal-worker.cjs'),
    'utf-8'
  )

  it('resolves the endpoint at launch time under the shared filename', () => {
    // Reader and writer must reference the same file.
    expect(worker).toContain(`$OPENCODE_CONFIG_DIR/${SERVER_ENDPOINT_FILE}`)
    expect(worker).toContain("sed -n 's/^CADENCE_OPENCODE_URL=//p'")
    expect(worker).toContain('command opencode attach "$__url"')
  })

  it('never freezes a concrete server URL into the shell (the original bug)', () => {
    expect(worker).not.toContain('export CADENCE_OPENCODE_URL=')
    expect(worker).not.toMatch(/attach "\$CADENCE_OPENCODE_URL"/)
  })
})
