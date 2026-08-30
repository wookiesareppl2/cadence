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
  'src/main/vault-save/collect-vault-save.mjs'
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

// Codex drives the save through `patch` + its own apply_patch rather than
// `apply`. It had the same Step 6 defect, and the first round of fixes only
// covered the apply path.
describe('Codex patch path', () => {
  function patch(): Run {
    return collector(['--mode', 'patch', '--manifest', manifest, '--plan', `${manifest}.plan.json`])
  }

  function plannedChanged(run: Run): string {
    return /^PLANNED_CHANGED=(.*)$/m.exec(run.out)?.[1] ?? ''
  }

  it('reports the projected end state, so a corrective re-patch reconciles', () => {
    orient('incremental')
    // Establish "a write already landed" with a real write rather than a
    // hand-simulated one — the collector also auto-adds the Pin Review line, so
    // reconstructing the post-patch state by hand would not match.
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nFirst.\n' } })
    expect(apply().status).toBe(0)

    plan({ replace: { 'Troubleshooting.md': '# Troubleshooting\n\nCorrected.\n' } })
    const corrective = patch()
    expect(corrective.status).toBe(0)
    // Must still carry what was already written, or validate rejects those as
    // "Unexpected changed file" — the Step 6 defect, on the Codex path.
    expect(plannedChanged(corrective)).toContain('HANDOFF.md')
    expect(plannedChanged(corrective)).toContain('Troubleshooting.md')
  })

  // The point of PLANNED_CHANGED is that validate AGREES with it once the write
  // lands — asserting the string alone would not catch the two sides drifting.
  // `apply` runs the same hunks through the same trailing-newline rule as the
  // harness's apply_patch, so it stands in for the write here.
  it('reports a set validate accepts once the write lands', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nPatched.\n' } })
    const planned = plannedChanged(patch())
    expect(planned).not.toBe('')

    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nPatched.\n' } })
    expect(apply().status).toBe(0)

    const out = validate(planned).out
    expect(out).not.toContain('Unexpected changed file')
    expect(out).not.toContain('Expected file did not change')
  })

  it('does not claim files from a patch that was never applied', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nAbandoned.\n' } })
    patch()
    // Never applied; regenerate against a different file instead.
    plan({ replace: { 'Troubleshooting.md': '# Troubleshooting\n\nInstead.\n' } })
    const regenerated = patch()
    expect(regenerated.status).toBe(0)
    expect(plannedChanged(regenerated)).toContain('Troubleshooting.md')
    expect(plannedChanged(regenerated)).not.toContain('HANDOFF.md')
  })
})

// A DNO is a do-not-optimise rule: the one entry class the save engine treats as
// binding on every later session. The failure mode this guards is the engine
// minting one from its own inference — "the code does X, so X must be a rule" —
// which converts an implementation accident into a permanent constraint that no
// later session will question, because DNOs are precisely the entries sessions
// are told not to re-litigate. Authority must be stated, not inferred.
describe('DNO authority', () => {
  const AUTHORITY = '**Authority:** Explicit user approval — owner said so on 2026-08-29'

  function patch(): Run {
    return collector(['--mode', 'patch', '--manifest', manifest, '--plan', `${manifest}.plan.json`])
  }

  it('refuses a new DNO that states no authority', () => {
    orient('incremental')
    plan({
      appendEntries: { 'Pins.md': ['### DNO-900: Never do the thing\n\nBecause the code does not.'] }
    })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('DNO_AUTHORITY_REQUIRED: DNO-900')
  })

  it('accepts a DNO that cites explicit user approval', () => {
    orient('incremental')
    plan({
      appendEntries: { 'Pins.md': [`### DNO-900: Never do the thing\n\n${AUTHORITY}\n\nRationale.`] }
    })
    expect(apply().status).toBe(0)
    expect(readFileSync(join(memory, 'Pins.md'), 'utf-8')).toContain('DNO-900')
  })

  it('accepts a DNO that cites an authoritative project decision', () => {
    orient('incremental')
    plan({
      appendEntries: {
        'Pins.md': [
          '### DNO-900: Never do the thing\n\n' +
            '**Authority:** Authoritative project decision — CLAUDE.md, "Stack / workflow notes"\n\nRationale.'
        ]
      }
    })
    expect(apply().status).toBe(0)
  })

  // The guard lives in the shared hunk builder, so BOTH front ends inherit it.
  // Guarding only `apply` would leave Codex free to mint unauthorised DNOs — the
  // exact split that makes a two-front-end engine worth having one guard for.
  it('applies the same guard on the Codex patch path', () => {
    orient('incremental')
    plan({
      appendEntries: { 'Pins.md': ['### DNO-901: Never do the other thing\n\nNo authority here.'] }
    })
    const run = patch()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('DNO_AUTHORITY_REQUIRED: DNO-901')
  })

  // A DNO arriving by wholesale file replacement is still a new DNO. Checking only
  // the append path would let the same unauthorised rule in through the other door.
  it('checks a DNO introduced by replacing a whole file', () => {
    orient('incremental')
    plan({ replace: { 'Pins.md': '# Pins\n\n### DNO-902: Smuggled in\n\nNo authority.\n' } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('DNO_AUTHORITY_REQUIRED: DNO-902')
  })

  // Only DNOs carry this requirement. Demanding it of every entry class would make
  // ordinary pins, decisions and patterns unsaveable.
  it('leaves non-DNO entries alone', () => {
    orient('incremental')
    plan({ appendEntries: { 'Pins.md': ['### PIN-900: An ordinary pin\n\nNo authority line.'] } })
    expect(apply().status).toBe(0)
  })
})

describe('changed-set reporting', () => {
  // A correction that restores a file to its original content genuinely leaves
  // it unchanged, so claiming it changed produces "Expected file did not change".
  // The restore has to be DECLARED, though — see the intent cross-check below.
  it('omits a file a declared correction restored to its original content', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nTemporary.\n' } })
    apply()
    plan({ replace: { 'HANDOFF.md': original }, allowUnchanged: ['HANDOFF.md'] })
    const run = apply()
    expect(run.status).toBe(0)
    const reverted = appliedChanged(run)
    expect(reverted).not.toContain('HANDOFF.md')

    const out = validate(reverted).out
    expect(out).not.toContain('Expected file did not change')
    expect(out).not.toContain('Unexpected changed file')
  })
})

// The intent-vs-outcome cross-check. Deriving the changed set from disk state is
// right, but on its own it made a write that changed nothing indistinguishable
// from one that worked: validate only ever sees the end state, and the end state
// of a botched regeneration and of a deliberate restore are the same file. The
// plan is the worker's declaration of intent, so the collector holds it to it.
describe('intent cross-check', () => {
  it('refuses a correction that silently restores a file to its pre-save content', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nTemporary.\n' } })
    expect(apply().status).toBe(0)

    plan({ replace: { 'HANDOFF.md': original } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('INTENDED_WRITE_DID_NOT_LAND')
    expect(run.out).toContain('restored it to its pre-save content')
    expect(run.out).toContain('allowUnchanged')
  })

  // A full replacement identical to what is already there never reaches the
  // intent check — the hunk builder has always refused it outright. Pinned here
  // so the two guards are not mistaken for one.
  it('refuses a full replacement identical to current content', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'Troubleshooting.md'), 'utf-8')
    plan({ replace: { 'Troubleshooting.md': original } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('identical to current content')
  })

  // The declaration cannot be a wholesale opt-out: naming one file leaves every
  // other file in the same plan checked.
  it('stands the check down for the declared key only', () => {
    orient('incremental')
    const handoff = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    const patterns = readFileSync(join(memory, 'Patterns.md'), 'utf-8')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nTemporary.\n', 'Patterns.md': '# Patterns\n\nTemporary.\n' }
    })
    expect(apply().status).toBe(0)

    plan({
      replace: { 'HANDOFF.md': handoff, 'Patterns.md': patterns },
      allowUnchanged: ['HANDOFF.md']
    })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('Patterns.md (the plan restored it')
    expect(run.out).not.toContain('HANDOFF.md (')
  })

  it('rejects a declaration naming a file outside the memory home', () => {
    orient('incremental')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nReal change.\n' },
      allowUnchanged: ['../escape.md']
    })
    expect(apply().status).not.toBe(0)
  })

  // Codex never calls apply, so the same defect had to be closed on its path —
  // and there it is worth catching BEFORE the patch is handed over.
  it('catches a restoring plan on the Codex patch path before emitting a patch', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nTemporary.\n' } })
    expect(apply().status).toBe(0)

    plan({ replace: { 'HANDOFF.md': original } })
    const run = collector(['--mode', 'patch', '--manifest', manifest, '--plan', `${manifest}.plan.json`])
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('INTENDED_WRITE_DID_NOT_LAND')
    expect(run.out).not.toContain('START_GENERATED_SAVE_PATCH')
  })

  // The recovery loop the error message actually prescribes. This is the test
  // whose absence hid a real defect: the first version of this guard ran AFTER
  // the write, so following its own advice led straight into "Full replacement
  // is identical to current content" — the restore had already landed, leaving
  // the worker with a half-applied save and no sanctioned way forward.
  it('walks the failure-declare-rerun loop the error message prescribes', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nTemporary.\n' } })
    expect(apply().status).toBe(0)

    plan({ replace: { 'HANDOFF.md': original } })
    const refused = apply()
    expect(refused.status).not.toBe(0)
    expect(refused.out).toContain('INTENDED_WRITE_DID_NOT_LAND')
    // The promise the message makes: nothing was written.
    expect(readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')).toContain('Temporary.')

    plan({ replace: { 'HANDOFF.md': original }, allowUnchanged: ['HANDOFF.md'] })
    const rerun = apply()
    expect(rerun.status).toBe(0)
    expect(readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')).toBe(original)
    expect(appliedChanged(rerun)).not.toContain('HANDOFF.md')
  })

  // A refused apply must leave the manifest able to accept the corrective plan,
  // or the tamper guard turns a refusal into a dead end (the TS-119 shape).
  it('leaves the manifest usable after refusing a plan', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nFirst.\n' } })
    expect(apply().status).toBe(0)

    const original = readFileSync(join(memory, 'Patterns.md'), 'utf-8')
    plan({ replace: { 'Patterns.md': original, 'HANDOFF.md': '# Handoff\n\nSecond.\n' } })
    expect(apply().status).not.toBe(0)

    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nSecond.\n' } })
    const recovered = apply()
    expect(recovered.status).toBe(0)
    expect(recovered.out).not.toContain('Memory changed after')
  })

  // Reachable only through a hunk builder with no identity guard of its own —
  // replaceEntries has none, unlike fullReplaceHunk.
  it('refuses an entry replacement that rewrites the entry unchanged', () => {
    const entry = '## TS-900: Fixture\n\n- **Note:** seed.\n'
    writeFileSync(join(memory, 'Troubleshooting.md'), `# Troubleshooting\n\n${entry}`)
    orient('incremental')
    plan({ replaceEntries: { 'Troubleshooting.md': [{ id: 'TS-900', text: entry }] } })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('byte-identical content')
  })

  it('rejects a declaration for a file the plan does not write', () => {
    orient('incremental')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nReal change.\n' },
      allowUnchanged: ['Patterns.md']
    })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('which this plan does not write')
  })

  it('accepts a declaration for the daily note', () => {
    orient('incremental')
    const before = readFileSync(daily, 'utf-8')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nReal change.\n' },
      daily: { indexLine: '- **Topic** — outcome.', session: '## Session 2\n\nwork\n' },
      allowUnchanged: ['@daily']
    })
    const run = apply()
    expect(run.status).toBe(0)
    // The declaration excuses a no-op; it does not suppress a real write.
    expect(readFileSync(daily, 'utf-8')).not.toBe(before)
    expect(appliedChanged(run)).toContain('@daily')
  })

  it('echoes the declared keys so a stood-down check is auditable', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nTemporary.\n' } })
    expect(apply().status).toBe(0)
    plan({ replace: { 'HANDOFF.md': original }, allowUnchanged: ['HANDOFF.md'] })
    expect(apply().out).toContain('DECLARED_UNCHANGED=HANDOFF.md')
  })

  it('reports no declaration on an ordinary save', () => {
    orient('incremental')
    plan({ replace: { 'HANDOFF.md': '# Handoff\n\nReal work.\n' } })
    expect(apply().out).toContain('DECLARED_UNCHANGED=none')
  })

  // R1: the collector injects hunks of its own — the stamped _Index.md counts,
  // and the Pin Review Log line it guarantees when the worker omits one. Holding
  // the worker to those produced a false positive on the most ordinary Step 6
  // correction there is: remove the entry you just added, and the index count
  // returns to its pre-save value along with it.
  it('does not hold the worker to the collector-stamped _Index counts', () => {
    writeFileSync(join(memory, '_Index.md'), '# _Index\n\nCovers the 0 live ADRs.\n')
    orient('incremental')
    plan({ appendEntries: { 'Decisions.md': ['## ADR-900: Fixture\n\n- **Note:** seed.\n'] } })
    expect(apply().status).toBe(0)
    expect(readFileSync(join(memory, '_Index.md'), 'utf-8')).toContain('the 1 live ADRs')

    plan({ removeEntries: { 'Decisions.md': ['ADR-900'] } })
    const refused = apply()
    expect(refused.status).not.toBe(0)
    // Decisions.md is a genuine restore and must still be named.
    expect(refused.out).toContain('Decisions.md')
    // _Index.md is the collector's own write and must not be.
    expect(refused.out).not.toContain('_Index.md')

    // Declaring only the worker's own key is enough to complete the correction.
    plan({ removeEntries: { 'Decisions.md': ['ADR-900'] }, allowUnchanged: ['Decisions.md'] })
    const rerun = apply()
    expect(rerun.status).toBe(0)
    expect(readFileSync(join(memory, '_Index.md'), 'utf-8')).toContain('the 0 live ADRs')
  })

  // R2: the R1 fix must exclude the collector's OWN _Index.md stamp without
  // carving the file out of the check altogether. When the worker authors an
  // _Index.md write, it is intent like any other, and a correction that restores
  // it has to be declared. Only `replace` skips _Index.md in the hunk builder;
  // appendText and the rest do not, so this shape is genuinely reachable.
  it('still holds the worker to an _Index write it authored itself', () => {
    writeFileSync(join(memory, '_Index.md'), '# _Index\n\nCovers the 0 live ADRs.\n')
    orient('incremental')
    const original = readFileSync(join(memory, '_Index.md'), 'utf-8')
    plan({ appendText: { '_Index.md': '\n## Status\n\nMigration in progress.\n' } })
    expect(apply().status).toBe(0)

    plan({ replace: { '_Index.md': original } })
    const refused = apply()
    expect(refused.status).not.toBe(0)
    expect(refused.out).toContain('_Index.md')

    plan({ replace: { '_Index.md': original }, allowUnchanged: ['_Index.md'] })
    const rerun = apply()
    expect(rerun.status).toBe(0)
    expect(readFileSync(join(memory, '_Index.md'), 'utf-8')).toBe(original)
  })

  it('refuses a declaration for a collector-owned key', () => {
    writeFileSync(join(memory, '_Index.md'), '# _Index\n\nCovers the 0 live ADRs.\n')
    orient('incremental')
    plan({
      appendEntries: { 'Decisions.md': ['## ADR-901: Fixture\n\n- **Note:** seed.\n'] },
      allowUnchanged: ['_Index.md']
    })
    const run = apply()
    expect(run.status).not.toBe(0)
    expect(run.out).toContain('which the collector writes on its own initiative')
  })

  // The auto-added Pin Review Log line is collector-injected the same way, and
  // a worker that supplies its own is held to it as normal.
  it('holds the worker to a Pin Review line it supplied itself', () => {
    orient('incremental')
    const original = readFileSync(join(memory, 'Pins-Reference.md'), 'utf-8')
    plan({ appendText: { 'Pins-Reference.md': reviewLine('incremental') } })
    expect(apply().status).toBe(0)

    plan({ replace: { 'Pins-Reference.md': original } })
    const refused = apply()
    expect(refused.status).not.toBe(0)
    expect(refused.out).toContain('Pins-Reference.md')
  })

  // A real save must not be inconvenienced by any of this.
  it('leaves an ordinary save alone', () => {
    orient('incremental')
    plan({
      replace: { 'HANDOFF.md': '# Handoff\n\nReal work.\n' },
      appendText: { 'Pins-Reference.md': reviewLine('incremental') },
      daily: { indexLine: '- **Topic** — outcome.', session: '## Session 2\n\nwork\n' }
    })
    const run = apply()
    expect(run.status).toBe(0)
    expect(appliedChanged(run)).toContain('HANDOFF.md')
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
