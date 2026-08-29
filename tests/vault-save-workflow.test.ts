import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findProjectRoot,
  PROJECT_IDENTITY_FILES,
  resolveRoute,
  stripFences
} from '../src/main/vault-save/resolve-memory-route.mjs'
import {
  bootstrap,
  hotLayerImportLines,
  toClaudeImportPath
} from '../src/main/vault-save/bootstrap-vault-memory.mjs'
// The collector's REAL helpers. The bootstrap skeleton and its archived legacy
// bank are checked against these rather than against rules re-stated in tests —
// re-stated rules are how a self-confirming suite passes while the thing it
// describes is broken.
import { danglingReferences } from '../src/main/vault-save/collect-vault-save.mjs'

// Mirrors the collector's own frontmatter predicate so the bootstrap skeleton is
// judged by the same rule that will judge the first real save.
function hasFrontmatter(text: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text)
}

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cadence-vault-save-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

function marker(wslPath: string): string {
  return `Felix memory home — Windows: \`C:\\x\` · WSL: \`${wslPath}\`\n`
}

// Routing decides whether a save writes to the live vault or to a project's
// frozen .claude/ bank, or into a DIFFERENT project's vault. It is exercised
// directly here — against the real filesystem, no shell involved — because two
// prose-embedded shell versions each passed string assertions while misrouting
// on well-formed input.
function fsHelpers() {
  return {
    readFileSafe: (path: string) => {
      try {
        return readFileSync(path, 'utf-8')
      } catch {
        return null
      }
    },
    isDirectory: (path: string) => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    },
    fileExists: (path: string) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    }
  }
}

function routeFrom(
  cwd: string,
  homeDir?: string
): { route: string; home?: string; workspaceRoot: string } {
  const helpers = fsHelpers()
  const root = findProjectRoot(cwd, {
    gitTopLevel: gitTopLevelOf(cwd),
    homeDir: homeDir ?? null,
    hasIdentity: (dir: string) =>
      PROJECT_IDENTITY_FILES.some((f: string) => helpers.fileExists(join(dir, f)))
  })
  const result = resolveRoute({ root, ...helpers })
  return { route: result.route, home: result.home, workspaceRoot: root }
}

function gitTopLevelOf(cwd: string): string | null {
  let current = cwd
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function tree(
  root: string,
  name: string,
  files: Record<string, string>,
  dirs: string[] = []
): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  for (const d of dirs) await mkdir(join(dir, d), { recursive: true })
  for (const [rel, body] of Object.entries(files)) {
    const target = join(dir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, 'utf-8')
  }
  return dir
}

describe('Cadence vault save engine', () => {
  it('never adopts an ancestor project as its memory home', async () => {
    const root = await temporaryDirectory()

    // A project whose ONLY identity is a legacy bank, sitting under an ancestor
    // that declares a vault marker. Routing to the ancestor would write this
    // project's memory into a DIFFERENT project's vault — the cross-contamination
    // failure this system already hit once and pinned as must-not-recur.
    await writeFile(join(root, 'CLAUDE.md'), marker(join(root, 'ancestor-vault')), 'utf-8')
    await mkdir(join(root, 'ancestor-vault'), { recursive: true })
    const legacyChild = await tree(root, 'child-legacy', { '.claude/HANDOFF.md': 'x\n' })
    const childResult = routeFrom(legacyChild)
    expect(childResult.route).toBe('legacy-bank')
    expect(childResult.workspaceRoot).toBe(legacyChild)

    // A directory with NO identity file is a subdirectory of the enclosing
    // project, and correctly resolves to it — it is indistinguishable from
    // src/deep below. Identity files, not the walk bound, are what stop a real
    // project climbing out of itself.
    const bare = await tree(root, 'child-bare', { 'notes.txt': 'x\n' })
    expect(routeFrom(bare).workspaceRoot).toBe(root)

    // HOME is never a project root, even though ~/.claude/CLAUDE.md exists as the
    // global agent adapter. Treating it as one would route every unmarked
    // directory beneath it at the home directory.
    const underHome = await tree(root, 'under-home', { 'notes.txt': 'x\n' })
    const homeResult = routeFrom(underHome, root)
    expect(homeResult.workspaceRoot).toBe(underHome)
    expect(homeResult.route).toBe('legacy-root')

    // But a subdirectory of a real project must still find that project.
    const project = await tree(
      root,
      'proper',
      { 'CLAUDE.md': marker(join(root, 'proper', 'mem')) },
      ['mem', join('src', 'deep')]
    )
    expect(routeFrom(join(project, 'src', 'deep')).workspaceRoot).toBe(project)
  })

  it('resolves every memory route correctly', async () => {
    const root = await temporaryDirectory()
    const home = (name: string) => join(root, name, 'mem')

    // The production regression: vault marker and the frozen bank's HANDOFF.md
    // both present. A shipped build routed this to legacy-bank, which on a save
    // would have written the session's memory into the frozen bank.
    const both = await tree(
      root,
      'both',
      { 'CLAUDE.md': marker(home('both')), '.claude/HANDOFF.md': 'x\n' },
      ['mem']
    )
    expect(routeFrom(both)).toMatchObject({ route: 'vault', home: home('both') })

    // An earlier quoted absolute path must not hijack extraction; only the path
    // after the WSL: label counts.
    const hijack = await tree(
      root,
      'hijack',
      {
        'CLAUDE.md': `Felix memory home — see \`/etc\` first · Windows: \`C:\\x\` · WSL: \`${home('hijack')}\`\n`
      },
      ['mem']
    )
    expect(routeFrom(hijack)).toMatchObject({ route: 'vault', home: home('hijack') })

    // A backtick-fenced example marker is documentation, not configuration.
    const fenced = await tree(
      root,
      'fenced',
      { 'CLAUDE.md': `\`\`\`\n${marker(home('fenced'))}\`\`\`\n`, '.claude/HANDOFF.md': 'x\n' },
      ['mem']
    )
    expect(routeFrom(fenced).route).toBe('legacy-bank')

    // Tilde fences are valid CommonMark and must be stripped too.
    const tilde = await tree(
      root,
      'tilde',
      { 'CLAUDE.md': `~~~\n${marker(home('tilde'))}~~~\n`, '.claude/HANDOFF.md': 'x\n' },
      ['mem']
    )
    expect(routeFrom(tilde).route).toBe('legacy-bank')

    // An UNCLOSED fence swallows everything below it, including a real marker.
    // Falling through to the frozen bank here is the original data-loss bug, so
    // this must abort instead.
    const desync = await tree(
      root,
      'desync',
      {
        'CLAUDE.md': `# Project\n\`\`\`\nunclosed example\n\n${marker(home('desync'))}`,
        '.claude/HANDOFF.md': 'x\n'
      },
      ['mem']
    )
    expect(routeFrom(desync).route).toBe('abort')

    // Marker-shaped but unparseable text aborts rather than silently falling back.
    const reworded = await tree(root, 'reworded', {
      'CLAUDE.md': 'FELIX MEMORY HOME - Windows: `C:\\x` WSL: `/nope`\n',
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(routeFrom(reworded).route).toBe('abort')

    // ...but prose merely MENTIONING the phrase must not brick a legacy project.
    const mentions = await tree(root, 'mentions', {
      'CLAUDE.md': 'We have not yet set up a Felix memory home for this project.\n',
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(routeFrom(mentions).route).toBe('legacy-bank')

    // A marker pointing nowhere aborts rather than guessing.
    const missing = await tree(root, 'missing', {
      'CLAUDE.md': marker(join(root, 'missing', 'not-there')),
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(routeFrom(missing).route).toBe('abort')

    // A marker with no WSL path at all aborts.
    const winOnly = await tree(root, 'winonly', {
      'CLAUDE.md': 'Felix memory home — Windows: `C:\\only`\n',
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(routeFrom(winOnly).route).toBe('abort')

    // Legacy routes still work.
    const bank = await tree(root, 'bank', {
      'CLAUDE.md': '# no marker\n',
      '.claude/HANDOFF.md': 'x\n'
    })
    expect(routeFrom(bank).route).toBe('legacy-bank')
    expect(routeFrom(await tree(root, 'rootonly', { 'CLAUDE.md': '# no marker\n' })).route).toBe(
      'legacy-root'
    )

    // The live memory home has spaces in it.
    const spaced = await tree(
      root,
      'spaced',
      { 'CLAUDE.md': marker(join(root, 'spaced', '04 - Personal Projects', 'mem')) },
      [join('04 - Personal Projects', 'mem')]
    )
    expect(routeFrom(spaced)).toMatchObject({
      route: 'vault',
      home: join(root, 'spaced', '04 - Personal Projects', 'mem')
    })

    // A marker in .claude/CLAUDE.md is equally valid.
    const nested = await tree(
      root,
      'nestedbaseline',
      { '.claude/CLAUDE.md': marker(home('nestedbaseline')) },
      ['mem']
    )
    expect(routeFrom(nested).route).toBe('vault')
  })

  it('bootstraps a vault memory home the collector validator accepts', async () => {
    const root = await temporaryDirectory()
    const workspace = await tree(root, 'legacy-project', {
      'CLAUDE.md': '# Legacy Project\n\nNo vault marker here yet.\n',
      '.claude/HANDOFF.md': '# old handoff\n\nlegacy content worth keeping\n',
      '.claude/context-pins.md': '# old pins\n\n## PIN-001: something\n'
    })
    const memory = join(root, 'vault', 'Legacy Project', 'memory')

    const result = bootstrap({
      workspace,
      memory,
      project: 'Legacy Project',
      today: '2026-07-22'
    })
    expect(result.marker).toBe(true)
    expect(result.archived).toBe(2)

    // The legacy bank is preserved verbatim, never converted, and never written to.
    expect(readFileSync(join(memory, 'Archive', 'legacy-bank', 'HANDOFF.md.txt'), 'utf-8')).toBe(
      '# old handoff\n\nlegacy content worth keeping\n'
    )
    expect(readFileSync(join(workspace, '.claude', 'HANDOFF.md'), 'utf-8')).toBe(
      '# old handoff\n\nlegacy content worth keeping\n'
    )

    // The marker it wrote must be one the resolver actually accepts — otherwise the
    // very next save would fail to find the home that was just created.
    expect(routeFrom(workspace)).toMatchObject({ route: 'vault', home: memory })

    // The skeleton must satisfy the collector's real validator, not merely look right.
    const handoff = readFileSync(join(memory, 'HANDOFF.md'), 'utf-8')
    expect(hasFrontmatter(handoff)).toBe(true)
    for (const heading of [
      'Current Task',
      'Next Priority',
      'Workflow State',
      'Commit Checkpoint',
      'Progress',
      'Blockers and Residual Risk',
      'Next Actions'
    ]) {
      expect(new RegExp(`^## ${heading}\\s*$`, 'm').test(handoff)).toBe(true)
    }

    // The four _Index live-count lines must match the collector's exact phrasings.
    const index = readFileSync(join(memory, '_Index.md'), 'utf-8')
    expect(index).toMatch(/~(\d+)\s+active PINs/i)
    expect(index).toMatch(/the\s+(\d+)\s+live ADRs/i)
    expect(index).toMatch(/the\s+(\d+)\s+live reusable patterns/i)
    expect(index).toMatch(/the\s+(\d+)\s+live issue\/fix records/i)

    // A well-formed Pin Review Log entry for the first real save to append to.
    const pinsRef = readFileSync(join(memory, 'Pins-Reference.md'), 'utf-8')
    const latest = pinsRef
      .split('\n')
      .filter((line) => /^- \d{4}-\d{2}-\d{2} \|/.test(line))
      .at(-1)
    expect(latest).toBeDefined()
    for (const required of ['branch=', 'mode=', 'result=', 'drift=', 'hot_changes=']) {
      expect(latest).toContain(required)
    }
    for (const file of ['Pins.md', 'Decisions.md', 'Patterns.md', 'Troubleshooting.md']) {
      expect(hasFrontmatter(readFileSync(join(memory, file), 'utf-8'))).toBe(true)
    }
  })

  // The marker only TELLS a session where memory lives; the `@` imports make Claude
  // Code actually load it. A bootstrap that writes the marker alone produces a
  // project that looks correctly wired and silently starts every session with no
  // memory loaded — the failure is invisible precisely because nothing errors.
  it('writes hot-layer imports the marker alone would not load', async () => {
    const root = await temporaryDirectory()
    const workspace = await tree(root, 'imported', { 'CLAUDE.md': '# Imported\n' })
    const memory = join(root, 'vault', 'imported', 'memory')
    const result = bootstrap({ workspace, memory, project: 'Imported', today: '2026-08-29' })

    expect(result.imports).toBe(3)
    expect(result.validated).toBe(true)

    const baseline = readFileSync(join(workspace, 'CLAUDE.md'), 'utf-8')
    for (const file of ['_Index.md', 'HANDOFF.md', 'Pins.md']) {
      expect(baseline).toContain(`@${toClaudeImportPath(join(memory, file))}`)
    }
    // Every import must name a file the bootstrap actually created, or the session
    // opens with an unresolvable import instead of the hot layer.
    for (const line of hotLayerImportLines(memory).split('\n')) {
      expect(existsSync(line.slice(1).replaceAll('\\ ', ' '))).toBe(true)
    }
  })

  // Claude Code splits an import path on whitespace, so an unescaped space
  // truncates it. Vault paths live under "…/04 - Personal Projects/…", which
  // contains three — the common case, not an exotic one.
  it('escapes spaces and normalises separators in an import path', () => {
    expect(toClaudeImportPath('C:\\Users\\a b\\Brain\\04 - Projects\\memory')).toBe(
      'C:/Users/a\\ b/Brain/04\\ -\\ Projects/memory'
    )
    // A newline cannot be escaped into one line at all, so refuse rather than
    // write an import that silently reads as two broken ones.
    expect(() => toClaudeImportPath('C:\\a\nb')).toThrow(/newline/)
  })

  // Bootstrap reports success from having run its steps, not from having verified
  // them. The post-write check is what makes the returned result evidence.
  it('fails loudly when the marker it needs cannot be written', async () => {
    const root = await temporaryDirectory()
    // A CLAUDE.md that already declares a DIFFERENT live memory home: writeMarker
    // correctly declines to add a second, so the imports never land and the home
    // this run just created is unreachable. Silence here is the unsaveable state.
    const workspace = await tree(root, 'claimed', {
      'CLAUDE.md': `# Claimed\n\n${marker('/mnt/c/elsewhere')}`
    })
    const memory = join(root, 'vault', 'claimed', 'memory')
    expect(() => bootstrap({ workspace, memory, project: 'Claimed', today: '2026-08-29' })).toThrow(
      /Bootstrap validation failed.*missing hot-layer import/s
    )
  })

  it('archives a legacy bank where the collector will not scan it as live memory', async () => {
    const root = await temporaryDirectory()
    // A REAL legacy bank cites entries that no longer exist — superseded, or
    // deleted long ago. If the archive is scanned as live memory those become
    // dangling references, validation fails, and because apply writes before
    // validate the project is left written-but-invalid and unsaveable forever.
    const workspace = await tree(root, 'inconsistent', {
      'CLAUDE.md': '# Inconsistent\n',
      '.claude/decisions.md':
        '# old decisions\n\n### ADR-042: A decision\n\nSupersedes ADR-011. See also TS-099.\n'
    })
    const memory = join(root, 'vault', 'inconsistent', 'memory')
    const result = bootstrap({ workspace, memory, project: 'Inconsistent', today: '2026-07-22' })
    expect(result.archived).toBe(1)

    // Content preserved byte for byte...
    const archived = join(memory, 'Archive', 'legacy-bank', 'decisions.md.txt')
    expect(readFileSync(archived, 'utf-8')).toBe(
      readFileSync(join(workspace, '.claude', 'decisions.md'), 'utf-8')
    )

    // ...and judged by the COLLECTOR'S OWN dangling-reference check, not by a
    // re-statement of its rules here. ADR-011 and TS-099 are cited by the
    // archived bank and defined nowhere; if the archive were scanned as live
    // memory these would be dangling, validation would fail, and — because
    // apply writes before validate — the project would be left written-but-
    // invalid and unsaveable on every subsequent save.
    expect(danglingReferences(memory)).toEqual([])

    // Belt and braces: nothing under the memory home ends in .md except the
    // live files, which is the mechanism that keeps the archive invisible.
    const scanned: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.toLowerCase().endsWith('.md')) scanned.push(entry.name)
      }
    }
    walk(memory)
    expect(scanned.sort()).toEqual([
      'Decisions.md',
      'HANDOFF.md',
      'Patterns.md',
      'Pins-Reference.md',
      'Pins.md',
      'Troubleshooting.md',
      '_Index.md'
    ])
  })

  it('writes a marker when CLAUDE.md only documents one inside a code fence', async () => {
    const root = await temporaryDirectory()
    // Bootstrap used to test RAW text for the marker while the resolver tested
    // FENCE-STRIPPED text. A documented example therefore looked like a live
    // marker: no marker was written, the home was created anyway, the route
    // never became vault, and re-running refused as occupied — unsaveable.
    const workspace = await tree(root, 'documented', {
      'CLAUDE.md':
        '# Documented\n\nA project declares its memory home like this:\n\n' +
        '```\nFelix memory home — Windows: `C:\\example` · WSL: `/mnt/c/example`\n```\n'
    })
    const memory = join(root, 'vault', 'documented', 'memory')
    const result = bootstrap({ workspace, memory, project: 'Documented', today: '2026-07-22' })

    expect(result.marker).toBe(true)
    // The decisive check: the route must actually become vault afterwards.
    expect(routeFrom(workspace)).toMatchObject({ route: 'vault', home: memory })
  })

  it('refuses a memory path containing a backtick', async () => {
    const root = await temporaryDirectory()
    const workspace = await tree(root, 'tick', { 'CLAUDE.md': '# tick\n' })
    // A backtick closes the marker's quoted path early, so the resolver would
    // read a truncated path and abort forever after a "successful" bootstrap.
    expect(() =>
      bootstrap({ workspace, memory: join(root, 'we`ird', 'memory'), today: '2026-07-22' })
    ).toThrow(/backtick/)
  })

  it('refuses to bootstrap over an existing memory home', async () => {
    const root = await temporaryDirectory()
    const workspace = await tree(root, 'proj', { 'CLAUDE.md': '# proj\n' })
    const occupied = join(root, 'someone-elses-vault')
    await mkdir(occupied, { recursive: true })
    await writeFile(join(occupied, 'HANDOFF.md'), '# another project\n', 'utf-8')

    // This guard is what stops one project's save landing in another's vault.
    expect(() =>
      bootstrap({ workspace, memory: occupied, project: 'proj', today: '2026-07-22' })
    ).toThrow(/already contains memory files/)
    expect(readFileSync(join(occupied, 'HANDOFF.md'), 'utf-8')).toBe('# another project\n')

    // Occupancy must recurse. A home whose live files were moved but whose
    // Archive/ still holds content is not empty — re-skeletoning it would
    // overwrite that archive.
    const archiveOnly = join(root, 'archive-only')
    await mkdir(join(archiveOnly, 'Archive', 'legacy-bank'), { recursive: true })
    await writeFile(join(archiveOnly, 'Archive', 'legacy-bank', 'pins.md.txt'), 'kept\n', 'utf-8')
    expect(() =>
      bootstrap({ workspace, memory: archiveOnly, project: 'proj', today: '2026-07-22' })
    ).toThrow(/already contains memory files/)
    expect(readFileSync(join(archiveOnly, 'Archive', 'legacy-bank', 'pins.md.txt'), 'utf-8')).toBe(
      'kept\n'
    )
  })

  it('strips fences and reports desync', () => {
    expect(stripFences('a\n```\nhidden\n```\nb').stripped.split('\n')).toEqual(['a', 'b'])
    expect(stripFences('a\n~~~\nhidden\n~~~\nb').stripped.split('\n')).toEqual(['a', 'b'])
    // A 4-backtick fence containing 3-backtick fences: the inner ones are too
    // short to close it, so the whole span is stripped and nothing is left open.
    const nested = stripFences('a\n````\n```\ninner\n```\n````\nb')
    expect(nested.stripped.split('\n')).toEqual(['a', 'b'])
    expect(nested.unbalanced).toBe(false)
    // An unclosed fence must be reported — it silently swallows everything below.
    expect(stripFences('a\n```\nnever closed').unbalanced).toBe(true)
    expect(stripFences('a\nb').unbalanced).toBe(false)
    // A tilde fence is not closed by backticks.
    expect(stripFences('a\n~~~\nx\n```\ny').unbalanced).toBe(true)
  })

  it('keeps the canonical engine pure LF so the suite can import it on Windows', async () => {
    // These files are imported directly by this suite. Under core.autocrlf they
    // would check out as CRLF, and a CRLF shebang line breaks Vite's module
    // transform — the suite fails to load on any fresh Windows checkout while
    // passing on the author's machine. .gitattributes pins them to LF; this is
    // the assertion that notices when that pin is lost.
    for (const file of [
      'collect-vault-save.mjs',
      'resolve-memory-route.mjs',
      'bootstrap-vault-memory.mjs'
    ]) {
      const source = await readFile(join(__dirname, '..', 'src', 'main', 'vault-save', file), 'utf-8')
      expect(source).not.toContain('\r')
      expect(source.endsWith('\n')).toBe(true)
    }
  })

  // Nothing in the app imports these scripts any more — they run from the
  // installed skill directories. The repo copy is the TESTED one, so if an
  // installed copy drifts, this suite is guarding an engine nobody runs while the
  // engine that is running is unguarded. That is what happened: Claude's copy
  // gained DNO-authority and hot-import behaviour, Codex's did not, and the two
  // providers quietly ran different save engines for three weeks with a green
  // suite throughout. The declaration files already state byte-identity as the
  // invariant; this is the assertion that makes the statement enforceable.
  //
  // The skill directories are machine-local, so absence is skipped rather than
  // failed — a fresh clone or CI has no installed copy and must still pass.
  it('keeps the installed skill copies byte-identical to the tested one', async () => {
    const home = process.env.USERPROFILE ?? process.env.HOME
    if (!home) return
    const files = ['collect-vault-save.mjs', 'resolve-memory-route.mjs', 'bootstrap-vault-memory.mjs']
    const drifted: string[] = []
    let compared = 0

    for (const platform of ['.claude', '.codex']) {
      for (const file of files) {
        const installed = join(home, platform, 'skills', 'save', 'scripts', file)
        if (!existsSync(installed)) continue
        compared += 1
        const canonical = await readFile(
          join(__dirname, '..', 'src', 'main', 'vault-save', file),
          'utf-8'
        )
        if ((await readFile(installed, 'utf-8')) !== canonical) drifted.push(`${platform}/${file}`)
      }
    }

    // No installed copy to compare against (fresh clone, CI, another machine).
    if (compared === 0) return
    expect(drifted, 'installed save-engine copies have drifted from the tested source').toEqual([])
  })
})
