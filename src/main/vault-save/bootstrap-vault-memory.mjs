#!/usr/bin/env node
// Create a project's vault memory home, so a first /save on an unmigrated
// project works the way a first save on a new project always used to: it sets
// the memory system up rather than failing.
//
// This exists so that "not migrated yet" is never a reason to write memory into
// a project's frozen `.claude/` bank. The legacy bank is only ever a SOURCE
// here — copied verbatim into Archive/legacy-bank/ so nothing is lost and
// nothing is mis-parsed. Entries get promoted into the live files later by a
// save that understands them, not by a bulk conversion that might mangle them.
//
// The generated skeleton is built to satisfy the collector's validator:
// frontmatter on every file, the seven exact HANDOFF headings, the four _Index
// live-count lines in their exact phrasings, and a well-formed Pin Review Log
// for the collector to append to.
//
// Usage:
//   node bootstrap-vault-memory.mjs --workspace <project dir> --memory <vault memory dir>
//                                   [--project <name>] [--dry-run true]

import fs from 'node:fs'
import path from 'node:path'
import { findMarkerLines, stripFences } from './resolve-memory-route.mjs'

export function toWindowsPath(p) {
  const match = /^\/mnt\/([a-z])\/(.*)$/i.exec(p)
  if (!match) return p
  return `${match[1].toUpperCase()}:\\${match[2].split('/').join('\\')}`
}

export function toWslPath(p) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!match) return p
  return `/mnt/${match[1].toLowerCase()}/${match[2].split('\\').join('/')}`
}

/**
 * Render a path as a Claude Code `@` import.
 *
 * A path under the user's home is written `~/…` rather than `C:/Users/<name>/…`.
 * Claude Code expands the tilde (verified on Windows, not merely assumed from
 * the docs), so the same CLAUDE.md loads its hot layer on any machine holding
 * the same vault, whatever the account is called. Baking one account name into
 * a file that travels between machines is the whole defect.
 *
 * Spaces are escaped LAST: Claude Code splits an import on whitespace, so an
 * unescaped space truncates the path, and vault paths contain three of them in
 * "04 - Personal Projects" alone. Escaping before the tilde substitution would
 * mean comparing an escaped path against an unescaped home and never matching.
 */
export function toClaudeImportPath(p, env = process.env) {
  if (/[\r\n]/.test(p)) throw new Error(`Cannot import a path containing a newline: ${p}`)
  let out = p.replaceAll('\\', '/')
  const home = env.USERPROFILE || env.HOME
  if (home) {
    const base = home.replaceAll('\\', '/').replace(/\/+$/, '')
    const lower = out.toLowerCase()
    const baseLower = base.toLowerCase()
    if (lower === baseLower || lower.startsWith(`${baseLower}/`)) {
      out = `~${out.slice(base.length)}`
    }
  }
  return out.replaceAll(' ', '\\ ')
}

export function hotLayerImportLines(memoryDir, env = process.env) {
  return ['_Index.md', 'HANDOFF.md', 'Pins.md']
    .map((file) => `@${toClaudeImportPath(path.join(memoryDir, file), env)}`)
    .join('\n')
}

export function markerLine(memoryDir) {
  const windows = toWindowsPath(memoryDir)
  const wsl = toWslPath(memoryDir)
  // Only claim a Windows path when one genuinely exists. A WSL-native path has
  // no Windows form, and repeating the POSIX path under a "Windows:" label is a
  // lie a Windows-side tool would act on.
  if (windows === memoryDir && memoryDir.startsWith('/')) {
    return `Felix memory home — WSL: \`${wsl}\``
  }
  return `Felix memory home — Windows: \`${windows}\` · WSL: \`${wsl}\``
}

function frontmatter(project, type) {
  return `---\nstatus: active\nproject: ${project}\ntype: ${type}\n---\n\n`
}

export function skeletonFiles(project, today) {
  const slug = project.toLowerCase()
  return {
    '_Index.md':
      frontmatter(slug, 'index') +
      `# ${project} Memory — Index\n\n` +
      `The map of ${project}'s project memory. A session loads this file plus the rest of the ` +
      `**hot layer** (\`HANDOFF.md\`, \`Pins.md\`) at launch, then pulls deeper entries **on demand** ` +
      `by task relevance. It never loads the whole brain.\n\n` +
      `Created by the vault bootstrap. If this project had a legacy \`.claude/\` memorybank, it was ` +
      `copied verbatim to \`Archive/legacy-bank/\` — promote entries from there as tasks touch them.\n\n` +
      `## Hot layer — ALWAYS loaded (keep tiny)\n` +
      `- **[[_Index]]** — this map.\n` +
      `- **[[HANDOFF]]** — current task, next steps, open gates. Live operational state.\n` +
      `- **[[Pins]]** — the foundational DNO invariants and the highest-impact active PINs.\n\n` +
      `## On demand — retrieved by task relevance\n` +
      `- **[[Pins-Reference]]** — the other ~0 active PINs. Full detail, retrieved only when a task touches a specific pin. Includes the Pin Review Log.\n` +
      `- **[[Decisions]]** — the 0 live ADRs (architecture decision records). Grep for the specific ADR a task needs.\n` +
      `- **[[Patterns]]** — the 0 live reusable patterns/conventions. Grep for the pattern a task needs.\n` +
      `- **[[Troubleshooting]]** — the 0 live issue/fix records. Grep for the symptom or fix a task needs.\n\n` +
      `## Cold\n` +
      `- \`Archive/\` — superseded entries and any imported legacy memorybank.\n`,

    'HANDOFF.md':
      frontmatter(slug, 'handoff') +
      `# ${project} — Handoff\n\n` +
      `## Current Task\n\nMemory home created by the vault bootstrap. No session state recorded yet.\n\n` +
      `## Next Priority\n\nRecord the first real session state on the next \`/save\`.\n\n` +
      `## Workflow State\n\nBootstrapped ${today}. No prior handoff to reconcile.\n\n` +
      `## Commit Checkpoint\n\nNone recorded yet.\n\n` +
      `## Progress\n\nMemory system initialised.\n\n` +
      `## Blockers and Residual Risk\n\nNone recorded yet.\n\n` +
      `## Next Actions\n\n- Run a normal \`/save\` to record the first session state.\n`,

    'Pins.md':
      frontmatter(slug, 'reference') +
      `# ${project} — Pins (Hot Layer)\n\n` +
      `The always-loaded layer of ${project}'s pinned invariants. Kept deliberately tight — this is ` +
      `what every session loads at launch. The remaining active PINs live in [[Pins-Reference]].\n\n` +
      `## Pin Lifecycle\n` +
      `- \`Active\`: current and enforced.\n` +
      `- \`Superseded\`: replaced by a newer DNO/PIN; the old entry is kept and points to its replacement.\n\n` +
      `## Do-Not-Overwrite Invariants\n\nNone recorded yet.\n\n` +
      `## Hot Pins\n\nNone recorded yet.\n`,

    'Pins-Reference.md':
      frontmatter(slug, 'reference') +
      `# ${project} — Pins (Full Reference)\n\n` +
      `The full set of active ${project} PINs not promoted to the hot layer ([[Pins]]). Preserved and ` +
      `indexed, but not auto-loaded — retrieve an entry only when the current task touches it.\n\n` +
      `## Active Pins\n\nNone recorded yet.\n\n` +
      `## Pin Review Log\n\n` +
      `- ${today} | branch=bootstrap | mode=incremental | result=BOOTSTRAP | drift=pass | hot_changes=none | notes=Vault memory home created by bootstrap-vault-memory. No pins evaluated; this line exists so the first real save has a well-formed log to append to.\n`,

    'Decisions.md':
      frontmatter(slug, 'reference') +
      `# ${project} — Decisions (ADR Log)\n\n` +
      `The live architectural decision records for ${project}, on demand. Not auto-loaded — a session ` +
      `greps this file for the specific ADR its task touches.\n\nNone recorded yet.\n`,

    'Patterns.md':
      frontmatter(slug, 'reference') +
      `# ${project} — Patterns\n\n` +
      `The live reusable patterns and conventions for ${project}, on demand. Grep for the pattern a ` +
      `task needs.\n\nNone recorded yet.\n`,

    'Troubleshooting.md':
      frontmatter(slug, 'reference') +
      `# ${project} — Troubleshooting\n\n` +
      `The live issue/fix records for ${project}, on demand. Grep for the symptom or fix a task ` +
      `needs.\n\nNone recorded yet.\n`
  }
}

/**
 * Refuse to touch a memory home that already holds someone's memory.
 *
 * Recurses: a home whose live files were moved but whose Archive/ still holds
 * content is NOT empty, and re-skeletoning it would overwrite that archive.
 * Anything at all under the directory counts — an unreadable directory counts
 * too, because failure to read is not evidence of absence.
 */
export function targetIsOccupied(memoryDir, readdirSync = fs.readdirSync, exists = fs.existsSync) {
  if (!exists(memoryDir)) return false
  const queue = [memoryDir]
  while (queue.length) {
    let entries
    try {
      entries = readdirSync(queue.shift(), { withFileTypes: true })
    } catch {
      return true
    }
    for (const entry of entries) {
      if (entry.isDirectory()) queue.push(path.join(entry.parentPath ?? memoryDir, entry.name))
      else return true
    }
  }
  return false
}

/** The date the collector would use, so the two never disagree in one file. */
export function todayInNz() {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

// The archive is stored with a `.md.txt` suffix, NOT `.md`. Content is copied
// byte for byte; only the name differs.
//
// This matters more than it looks. The collector scans every `*.md` under the
// memory home, and it treats each one as a CITER for dangling-reference checks,
// not merely as a source of IDs. Real legacy banks cite superseded or deleted
// entries, so an archived `.md` would fail validation — and because apply writes
// before validate, that leaves a written-but-invalid vault whose every
// subsequent save fails identically, with no repair path that does not either
// hand-edit the "verbatim" archive or delete it. Renaming keeps the content
// intact and honest while keeping it out of the scanner.
// Appended to the original name, which already ends in `.md`, giving `<name>.md.txt`.
export const ARCHIVE_SUFFIX = '.txt'

// Legacy memory takes two shapes, and both must be carried across or the
// project's accumulated history is stranded in the repo:
//
//   Legacy Bank — `<workspace>/.claude/*.md`
//   Legacy Root — `<workspace>/HANDOFF.md` (a save that ran before the project
//                 had any bank at all; the resolver calls this `legacy-root`)
//
// Only the bank was handled originally, so bootstrapping a legacy-root project
// produced an empty memory home and left its real handoff behind, unreferenced.
function legacySources(workspace) {
  const bank = path.join(workspace, '.claude')
  const sources = []
  if (fs.existsSync(bank) && fs.statSync(bank).isDirectory()) {
    for (const name of fs.readdirSync(bank).filter((n) => n.toLowerCase().endsWith('.md'))) {
      sources.push({ from: path.join(bank, name), as: name, label: `.claude/${name}` })
    }
  }
  const rootHandoff = path.join(workspace, 'HANDOFF.md')
  if (fs.existsSync(rootHandoff) && fs.statSync(rootHandoff).isFile()) {
    // Namespaced so it cannot collide with a bank file of the same name.
    sources.push({ from: rootHandoff, as: 'root-HANDOFF.md', label: 'HANDOFF.md (project root)' })
  }
  return sources
}

function copyLegacyBank(workspace, memoryDir, log) {
  const sources = legacySources(workspace)
  if (!sources.length) return 0
  const target = path.join(memoryDir, 'Archive', 'legacy-bank')
  fs.mkdirSync(target, { recursive: true })
  for (const source of sources) {
    fs.copyFileSync(source.from, path.join(target, `${source.as}${ARCHIVE_SUFFIX}`))
    log.push(`  archived ${source.label} as ${source.as}${ARCHIVE_SUFFIX}`)
  }
  fs.writeFileSync(
    path.join(target, 'README.txt'),
    'Verbatim copy of this project\'s legacy memory, taken at vault bootstrap.\n' +
      'Sources: a legacy .claude/ memorybank and/or a root HANDOFF.md written before\n' +
      'the project had a vault memory home.\n\n' +
      'Files carry a .md.txt suffix so the save collector does not scan them as live memory:\n' +
      'it treats every *.md under the memory home as a citer for dangling-reference checks, and\n' +
      'legacy memory routinely cites entries that no longer exist. Content is byte-identical to the\n' +
      'originals; only the file names differ.\n\n' +
      'Promote entries from here into the live memory files as tasks touch them.\n',
    'utf-8'
  )
  return sources.length
}

function writeMarker(workspace, memoryDir, log) {
  const baseline = path.join(workspace, 'CLAUDE.md')
  const line = markerLine(memoryDir)
  const imports = hotLayerImportLines(memoryDir)
  let text = ''
  try {
    text = fs.readFileSync(baseline, 'utf-8')
  } catch {
    text = ''
  }
  // Use the RESOLVER's matcher, not a second one. Testing raw text here while
  // the resolver tests fence-stripped text meant a CLAUDE.md that merely
  // documented the marker inside a code fence convinced bootstrap a live marker
  // existed. No marker got written, the memory home was created anyway, the
  // route never became vault, and re-running refused because the target was now
  // occupied — leaving the project unsaveable by any supported path.
  if (findMarkerLines(stripFences(text).stripped).length > 0) {
    log.push('  CLAUDE.md already declares a live memory home; left unchanged')
    return false
  }
  const block =
    `\n## Project memory — Felix vault\n\n` +
    `This project's memory lives in Sheldon's Obsidian vault. The three imports below load ` +
    `the complete hot layer automatically at session start. They are written home-relative, ` +
    `so they resolve on any machine holding the same vault.\n\n` +
    `Claude Code asks for approval once, because the files sit outside the project. Accepting ` +
    `is what makes the hot layer load by itself; declining disables these imports permanently ` +
    `and without further prompting, and \`/start\` then remains the way to load memory.\n\n` +
    `${imports}\n\n` +
    `${line}\n`
  fs.writeFileSync(baseline, text ? `${text.replace(/\s*$/, '')}\n${block}` : `# Project\n${block}`, 'utf-8')
  log.push(text ? '  appended memory-home marker to CLAUDE.md' : '  created CLAUDE.md with memory-home marker')
  return true
}

function validateBootstrapWrite(workspace, memoryDir, expectedFiles) {
  const errors = []
  for (const [relative, expected] of Object.entries(expectedFiles)) {
    const target = path.join(memoryDir, relative)
    if (!fs.existsSync(target)) {
      errors.push(`missing ${relative}`)
      continue
    }
    if (fs.readFileSync(target, 'utf-8') !== expected) errors.push(`content mismatch in ${relative}`)
  }
  if (!fs.existsSync(path.join(memoryDir, 'Archive'))) errors.push('missing Archive directory')

  const baseline = path.join(workspace, 'CLAUDE.md')
  const baselineText = fs.existsSync(baseline) ? fs.readFileSync(baseline, 'utf-8') : ''
  const markerMatches = findMarkerLines(stripFences(baselineText).stripped)
  if (markerMatches.length !== 1) errors.push(`expected one live memory marker, found ${markerMatches.length}`)
  for (const line of hotLayerImportLines(memoryDir).split('\n')) {
    if (!baselineText.includes(line)) errors.push(`missing hot-layer import: ${line}`)
  }

  if (errors.length > 0) throw new Error(`Bootstrap validation failed: ${errors.join('; ')}`)
}

export function bootstrap({ workspace, memory, project, today, dryRun = false }) {
  const log = []
  if (!fs.existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`)
  // A backtick would terminate the marker's quoted path early, so the resolver
  // would extract a truncated path, find no directory there, and abort forever.
  // Refuse up front rather than write a marker we know cannot be read back.
  if (memory.includes('`')) {
    throw new Error(
      `Refusing to bootstrap: the memory path contains a backtick, which cannot be written into ` +
        `the memory-home marker. Choose a path without one: ${memory}`
    )
  }
  if (targetIsOccupied(memory)) {
    throw new Error(
      `Refusing to bootstrap: ${memory} already contains memory files. ` +
        'Point --memory at an empty or new folder; overwriting another project\'s memory is never correct.'
    )
  }
  const name = project || path.basename(workspace)
  const files = skeletonFiles(name, today)
  if (dryRun) {
    return {
      created: Object.keys(files),
      archived: 0,
      marker: false,
      imports: 3,
      validated: true,
      log: ['dry run — validation describes the generated shape; nothing written']
    }
  }
  fs.mkdirSync(path.join(memory, 'Archive'), { recursive: true })
  for (const [relative, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(memory, relative), body, 'utf-8')
    log.push(`  created ${relative}`)
  }
  const archived = copyLegacyBank(workspace, memory, log)
  const marker = writeMarker(workspace, memory, log)
  validateBootstrapWrite(workspace, memory, files)
  return { created: Object.keys(files), archived, marker, imports: 3, validated: true, log }
}

function required(parsed, key) {
  const value = parsed[key]
  if (!value) {
    process.stderr.write(`Missing required --${key}\n`)
    process.exit(2)
  }
  return value
}

function parseArgs(tokens) {
  const parsed = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) continue
    const next = tokens[index + 1]
    if (!next || next.startsWith('--')) parsed[token.slice(2)] = 'true'
    else {
      parsed[token.slice(2)] = next
      index += 1
    }
  }
  return parsed
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith('bootstrap-vault-memory.mjs')
if (invokedDirectly) {
  const parsed = parseArgs(process.argv.slice(2))
  const workspace = path.resolve(required(parsed, 'workspace'))
  const memory = path.resolve(required(parsed, 'memory'))
  const today = todayInNz()
  try {
    const result = bootstrap({
      workspace,
      memory,
      project: parsed.project,
      today,
      dryRun: parsed['dry-run'] === 'true'
    })
    process.stdout.write(
      [
        'BOOTSTRAP=ok',
        `MEMORY_HOME=${memory}`,
        `FILES_CREATED=${result.created.length}`,
        `LEGACY_ARCHIVED=${result.archived}`,
        `MARKER_WRITTEN=${result.marker}`,
        `HOT_IMPORTS_WRITTEN=${result.imports}`,
        `BOOTSTRAP_VALIDATION=${result.validated ? 'PASS' : 'FAIL'}`,
        ...result.log,
        ''
      ].join('\n')
    )
  } catch (error) {
    process.stdout.write(`BOOTSTRAP=failed\nREASON=${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}
