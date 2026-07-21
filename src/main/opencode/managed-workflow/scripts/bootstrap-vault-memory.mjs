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
import { pathToFileURL } from 'node:url'

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

/** Refuse to touch a memory home that already holds someone's memory. */
export function targetIsOccupied(memoryDir, readdir = fs.readdirSync, exists = fs.existsSync) {
  if (!exists(memoryDir)) return false
  let entries = []
  try {
    entries = readdir(memoryDir)
  } catch {
    return true
  }
  return entries.some((name) => name.toLowerCase().endsWith('.md'))
}

function copyLegacyBank(workspace, memoryDir, log) {
  const bank = path.join(workspace, '.claude')
  if (!fs.existsSync(bank)) return 0
  const names = fs
    .readdirSync(bank)
    .filter((name) => name.toLowerCase().endsWith('.md'))
  if (!names.length) return 0
  const target = path.join(memoryDir, 'Archive', 'legacy-bank')
  fs.mkdirSync(target, { recursive: true })
  for (const name of names) {
    fs.copyFileSync(path.join(bank, name), path.join(target, name))
    log.push(`  archived ${name}`)
  }
  return names.length
}

function writeMarker(workspace, memoryDir, log) {
  const baseline = path.join(workspace, 'CLAUDE.md')
  const line = markerLine(memoryDir)
  let text = ''
  try {
    text = fs.readFileSync(baseline, 'utf-8')
  } catch {
    text = ''
  }
  if (text.includes('Felix memory home')) {
    log.push('  CLAUDE.md already declares a memory home; left unchanged')
    return false
  }
  const block =
    `\n## Project memory — Felix vault\n\n` +
    `This project's memory lives in Sheldon's Obsidian vault. Load the hot layer ` +
    `(\`_Index.md\`, \`HANDOFF.md\`, \`Pins.md\`) at session start.\n\n` +
    `${line}\n`
  fs.writeFileSync(baseline, text ? `${text.replace(/\s*$/, '')}\n${block}` : `# Project\n${block}`, 'utf-8')
  log.push(text ? '  appended memory-home marker to CLAUDE.md' : '  created CLAUDE.md with memory-home marker')
  return true
}

export function bootstrap({ workspace, memory, project, today, dryRun = false }) {
  const log = []
  if (!fs.existsSync(workspace)) throw new Error(`Workspace does not exist: ${workspace}`)
  if (targetIsOccupied(memory)) {
    throw new Error(
      `Refusing to bootstrap: ${memory} already contains memory files. ` +
        'Point --memory at an empty or new folder; overwriting another project\'s memory is never correct.'
    )
  }
  const name = project || path.basename(workspace)
  const files = skeletonFiles(name, today)
  if (dryRun) {
    return { created: Object.keys(files), archived: 0, marker: false, log: ['dry run — nothing written'] }
  }
  fs.mkdirSync(path.join(memory, 'Archive'), { recursive: true })
  for (const [relative, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(memory, relative), body, 'utf-8')
    log.push(`  created ${relative}`)
  }
  const archived = copyLegacyBank(workspace, memory, log)
  const marker = writeMarker(workspace, memory, log)
  return { created: Object.keys(files), archived, marker, log }
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
  const today = new Date().toISOString().slice(0, 10)
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
        ...result.log,
        ''
      ].join('\n')
    )
  } catch (error) {
    process.stdout.write(`BOOTSTRAP=failed\nREASON=${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  }
}
