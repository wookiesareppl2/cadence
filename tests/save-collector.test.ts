import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The collector writes to the user's real memory and daily-note files, and until
// now nothing exercised it — the two regressions this file pins (escalation, and
// recovery reconciliation) both shipped in v0.1.37 because the only verification
// was ad-hoc and checked the half that had been changed rather than the outcome
// claimed. These run the real script end to end against a throwaway vault.

const COLLECTOR = join(
  __dirname,
  '..',
  'src/main/opencode/managed-workflow/scripts/collect-vault-save.mjs'
)

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Pacific/Auckland',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(new Date())

let root: string
let memory: string
let workspace: string
let daily: string
let manifest: string

type Run = { status: number; out: string }

function collector(args: string[]): Run {
  try {
    const out = execFileSync(process.execPath, [COLLECTOR, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { status: 0, out }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { status: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` }
  }
}

function plan(body: Record<string, unknown>): void {
  writeFileSync(
    `${manifest}.plan.json`,
    JSON.stringify({
      replace: {},
      appendEntries: {},
      appendText: {},
      insertBefore: {},
      replaceEntries: {},
      removeEntries: {},
      ...body
    })
  )
}

function orient(fidelity: string): Run {
  return collector([
    '--mode', 'state',
    '--memory', memory,
    '--workspace', workspace,
    '--daily', daily,
    '--manifest', manifest,
    '--fidelity', fidelity
  ])
}

function apply(): Run {
  return collector(['--mode', 'apply', '--manifest', manifest, '--plan', `${manifest}.plan.json`])
}

function validate(changed: string): Run {
  return collector([
    '--mode', 'validate',
    '--manifest', manifest,
    '--memory', memory,
    '--workspace', workspace,
    '--changed', changed
  ])
}

function appliedChanged(run: Run): string {
  return /^APPLIED_CHANGED=(.*)$/m.exec(run.out)?.[1] ?? ''
}

function reviewLine(mode: string): string {
  return `- ${today} | branch=master | mode=${mode} | result=NO_PIN_CHANGES | drift=pass | hot_changes=none | notes=fixture`
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cadence-collector-'))
  const vault = join(root, 'vault')
  memory = join(vault, 'memory')
  workspace = join(root, 'ws')
  mkdirSync(memory, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(vault, '01 - Daily Notes'), { recursive: true })

  writeFileSync(join(vault, 'VAULT-INDEX.md'), '# Vault\n')
  writeFileSync(join(memory, 'HANDOFF.md'), '# Handoff\n\nState.\n')
  for (const name of ['Pins', '_Index', 'Decisions', 'Patterns', 'Troubleshooting']) {
    writeFileSync(join(memory, `${name}.md`), `# ${name}\n`)
  }
  writeFileSync(
    join(memory, 'Pins-Reference.md'),
    '# Pins Reference\n\n## Pin Review Log\n\n- 2026-01-01 | branch=master | mode=incremental | result=NO_PIN_CHANGES | drift=pass | hot_changes=none | notes=seed\n'
  )
  daily = join(vault, '01 - Daily Notes', `${today}.md`)
  writeFileSync(daily, '---\nstatus: active\n---\n\n## Session 1\n\nwork\n')
  manifest = join(root, 'manifest.json')

  const git = (args: string[]): void => {
    execFileSync('git', ['-C', workspace, ...args], { stdio: 'ignore' })
  }
  git(['init'])
  git(['config', 'user.email', 'fixture@example.com'])
  git(['config', 'user.name', 'Fixture'])
  writeFileSync(join(workspace, 'file.txt'), 'x\n')
  git(['add', '-A'])
  git(['commit', '-m', 'seed'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('save fidelity', () => {
  it('records the requested fidelity in the manifest', () => {
    orient('max')
    expect(JSON.parse(readFileSync(manifest, 'utf-8')).fidelity).toBe('max')
  })

  it('defaults to incremental when none is given', () => {
    collector(['--mode', 'state', '--memory', memory, '--workspace', workspace, '--daily', daily, '--manifest', manifest])
    expect(JSON.parse(readFileSync(manifest, 'utf-8')).fidelity).toBe('incremental')
  })

  it('refuses a fidelity outside incremental/max instead of silently doing less', () => {
    const run = orient('audit')
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('Unknown --fidelity "audit"')
  })

  // TS-115: apply never received the mode, stamped `incremental`, and validate
  // rejected the line the collector itself had written.
  it('stamps the requested mode on the auto-added review line', () => {
    orient('max')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nWritten.\n' } })
    apply()
    expect(readFileSync(join(memory, 'Pins-Reference.md'), 'utf-8')).toContain(`mode=max`)
  })

  // The regression that shipped in v0.1.37: the skill tells the worker to escalate
  // incremental -> max AFTER orientation, so the stamped mode legitimately differs
  // from the manifest. Demanding equality failed every escalated save.
  it('accepts a save escalated above the requested fidelity', () => {
    orient('incremental')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nWritten.\n' },
      appendText: { 'Pins-Reference.md': reviewLine('max') }
    })
    apply()
    expect(validate('HANDOFF.md|Pins-Reference.md').out).not.toMatch(/mode=/)
  })

  // ...but the TS-115 protection must survive: a max request is never satisfied
  // by an incremental line.
  it('still rejects a save weaker than the one requested', () => {
    orient('max')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nWritten.\n' },
      appendText: { 'Pins-Reference.md': reviewLine('incremental') }
    })
    apply()
    expect(validate('HANDOFF.md|Pins-Reference.md').out).toContain(
      'records mode=incremental for a max save'
    )
  })
})

describe('Step 6 recovery', () => {
  // TS-119: apply's own writes moved the files off the orientation snapshot, so
  // the corrective re-apply the skill prescribes hit the tamper guard.
  it('allows a corrective re-apply and lands the correction', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nFirst.\n' } })
    expect(apply().status).toBe(0)
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nCorrected.\n' } })
    expect(apply().status).toBe(0)
    expect(readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')).toContain('Corrected.')
  })

  // The half the original TS-119 verification missed: the guard stopped blocking,
  // but validate reconciles the changed set against ORIENTATION, so a corrective
  // apply reporting only its own files had every earlier file rejected.
  it('reports the cumulative changed set so validate reconciles', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nFirst.\n' } })
    const first = appliedChanged(apply())
    expect(first).toContain('HANDOFF.md')

    plan({ replace: { 'Troubleshooting.md': '# Troubleshooting\n\nCorrected.\n' } })
    const second = appliedChanged(apply())
    expect(second).toContain('Troubleshooting.md')
    expect(second).toContain('HANDOFF.md')

    const out = validate(second).out
    expect(out).not.toContain('Unexpected changed file')
    expect(out).not.toContain('Expected file did not change')
  })

  it('still refuses an edit made outside the collector', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nFirst.\n' } })
    apply()
    writeFileSync(join(memory, 'HANDOFF.md'), '# Handoff\n\nHand-edited.\n')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nThird.\n' } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('Memory changed after')
  })

  it('fails closed on a manifest carrying no snapshot', () => {
    writeFileSync(manifest, JSON.stringify({ memory, daily, workspace }))
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nForged.\n' } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('no memory snapshot')
  })
})

describe('Pin Review Log placement', () => {
  // TS-120: the line was appended at end-of-file while its reader parses only the
  // section — correct only while that section happened to be last.
  it('writes inside the section even when another section follows it', () => {
    writeFileSync(
      join(memory, 'Pins-Reference.md'),
      '# Pins Reference\n\n## Pin Review Log\n\n- 2026-01-01 | branch=master | mode=incremental | result=NO_PIN_CHANGES | drift=pass | hot_changes=none | notes=seed\n\n## Later Section\n\nAdded after the log.\n'
    )
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nWritten.\n' } })
    apply()

    const text = readFileSync(join(memory, 'Pins-Reference.md'), 'utf-8')
    const section = /^##\s+Pin Review Log\s*$\r?\n(.*?)(?=^##\s+|(?![\s\S]))/ms.exec(text)?.[1] ?? ''
    expect(section).toContain(`- ${today} |`)
    expect(text).toContain('## Later Section')
  })

  it('errors rather than appending blind when the section is missing', () => {
    writeFileSync(join(memory, 'Pins-Reference.md'), '# Pins Reference\n\nNo log section here.\n')
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nWritten.\n' } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('Pin Review Log')
  })
})
