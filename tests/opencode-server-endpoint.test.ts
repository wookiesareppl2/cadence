import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatServerEndpoint, serverEndpointFile } from '../src/main/opencode/opencode-runtime'

// The managed OpenCode server runs on a fresh random port every start. The bug this
// guards against: the terminal's `opencode` wrapper baked that port at creation
// time, so any server move (a health restart, or a second Cadence instance) left
// the terminal attached to a dead port — a spinner that never resolves and an
// interrupt that never lands. The fix publishes the live address to a file and has
// the wrapper read it at launch time. Writer and reader must agree on that format.
//
// The file is per-instance: a dev build and the packaged app run side by side, each
// with its own server, and a single shared file let them overwrite and delete each
// other's address.

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

  it('names a distinct file per instance', () => {
    expect(serverEndpointFile('a1b2c3d4e5f6')).toBe('server-endpoint.a1b2c3d4e5f6.env')
    expect(serverEndpointFile('a1b2c3d4e5f6')).not.toBe(serverEndpointFile('0f1e2d3c4b5a'))
  })

  it('never reuses the shared name two instances fought over', () => {
    expect(serverEndpointFile('a1b2c3d4e5f6')).not.toBe('server-endpoint.env')
  })
})

describe('OpenCode terminal wrapper (terminal-worker.cjs)', () => {
  const worker = readFileSync(
    join(__dirname, '..', 'src', 'main', 'terminal', 'terminal-worker.cjs'),
    'utf-8'
  )

  it('resolves the endpoint at launch time from the instance filename it was given', () => {
    expect(worker).toContain('shellSingleQuote(openCodeRuntime.endpointFile)')
    expect(worker).toContain('local __ep="$OPENCODE_CONFIG_DIR/"')
    expect(worker).toContain("sed -n 's/^CADENCE_OPENCODE_URL=//p'")
    expect(worker).toContain('command opencode attach "$__url"')
  })

  it('never hard-codes an endpoint filename (that is what let two instances collide)', () => {
    // The name must arrive from the launching instance, not be baked in here.
    expect(worker).not.toContain('server-endpoint.env')
  })

  it('never freezes a concrete server URL into the shell (the original bug)', () => {
    expect(worker).not.toContain('export CADENCE_OPENCODE_URL=')
    expect(worker).not.toMatch(/attach "\$CADENCE_OPENCODE_URL"/)
  })
})
