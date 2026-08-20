import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Two Node resolvers exist and they are NOT interchangeable:
//
//   nodeExecutable()           must stay ABI-compatible with the host platform,
//                              because the terminal pty host loads node-pty (a
//                              native module) through it.
//   tlsCapableNodeExecutable() may prefer a Windows node.exe under WSL, because
//                              the Codex backend edge rejects WSL Node's TLS
//                              fingerprint — safe only because that worker is
//                              plain JS with no native module.
//
// Wiring the TLS variant into the pty host shipped once and broke the terminal
// in exactly the configuration the WSL branch activates in: a Windows node.exe
// cannot dlopen a Linux-built native module, nor read a /mnt-style worker path.
// A comment did not prevent that, so assert the split instead.

const root = join(__dirname, '..')
const read = (relative: string): string => readFileSync(join(root, relative), 'utf-8')

const ABI_CRITICAL_CONSUMERS = ['src/main/terminal/terminal-service.ts']
const TLS_CONSUMER = 'src/main/usage/codex-plan-usage-service.ts'

describe('Node resolver split', () => {
  it('keeps the TLS-preferring resolver away from native-module consumers', () => {
    for (const consumer of ABI_CRITICAL_CONSUMERS) {
      const source = read(consumer)
      expect(source, `${consumer} must not use the TLS resolver`).not.toContain(
        'tlsCapableNodeExecutable'
      )
      expect(source, `${consumer} must resolve Node`).toContain('nodeExecutable')
    }
  })

  it('uses the TLS-preferring resolver only for the Codex usage fetch', () => {
    const source = read(TLS_CONSUMER)
    expect(source).toContain('tlsCapableNodeExecutable')
    // It must not also reach for the ABI-critical one, whose resolution differs.
    expect(source).not.toMatch(/\bimport \{ nodeExecutable \}/)
  })

  it('never lets the ABI-critical resolver prefer a foreign-platform binary', () => {
    const source = read('src/main/node-runtime.ts')
    const body = source.slice(
      source.indexOf('export function nodeExecutable'),
      source.indexOf('export function tlsCapableNodeExecutable')
    )
    expect(body.length).toBeGreaterThan(50)
    expect(body).not.toContain('windowsNodePath')
    expect(body).not.toContain('isWSL')
  })
})
