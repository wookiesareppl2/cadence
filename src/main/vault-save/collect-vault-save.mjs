#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = parseArgs(process.argv.slice(2))

// The four _Index live-count lines, each mapped to its source file, entry
// prefix, and the regex that captures the count digits. Declared before the CLI
// dispatch so functions it reaches (patch mode) can use it without a TDZ error.
const INDEX_COUNT_MAP = [
  ['Pins-Reference.md', 'PIN', /~(\d+)\s+active PINs/i],
  ['Decisions.md', 'ADR', /the\s+(\d+)\s+live ADRs/i],
  ['Patterns.md', 'PAT', /the\s+(\d+)\s+live reusable patterns/i],
  ['Troubleshooting.md', 'TS', /the\s+(\d+)\s+live issue\/fix records/i],
]

// Run the CLI only when invoked directly; importing this file (for tests) just
// loads the pure helpers exported at the bottom without dispatching a mode.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = required('mode')
  try {
    if (mode === 'file') emitFilePacket()
    else if (mode === 'state') await emitStatePacket()
    else if (mode === 'bundle') await emitBundlePacket()
    else if (mode === 'target') emitTargetPacket()
    else if (mode === 'source') emitSourcePacket()
    else if (mode === 'patch') emitPatchPacket()
    else if (mode === 'apply') emitApplyPacket()
    else if (mode === 'validate') await validateSave()
    else fail(`Unsupported --mode: ${mode}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

function parseArgs(tokens) {
  const parsed = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) fail(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    const next = tokens[index + 1]
    if (!next || next.startsWith('--')) parsed[key] = 'true'
    else {
      parsed[key] = next
      index += 1
    }
  }
  return parsed
}

function required(name) {
  const value = args[name]
  if (!value) fail(`Missing --${name}`)
  return value
}

function fail(message) {
  process.stderr.write(`SAVE_COLLECTOR_ERROR: ${message}\n`)
  process.exit(1)
}

function boolArg(name) {
  return String(args[name] ?? 'false').toLowerCase() === 'true'
}

function listArg(name) {
  return [...new Set(String(args[name] ?? '')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean))]
}

function readText(filePath, optional = false) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (optional) return ''
    throw new Error(`Required file missing: ${filePath}`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function fileSnapshot(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { exists: false }
  const content = fs.readFileSync(filePath)
  const stat = fs.statSync(filePath)
  return {
    exists: true,
    bytes: content.byteLength,
    sha256: sha256(content),
    mtimeMs: stat.mtimeMs,
  }
}

function normalizedRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function markdownFiles(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  const queue = [root]
  while (queue.length) {
    const current = queue.shift()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(candidate)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) found.push(candidate)
    }
  }
  return found.sort((left, right) => left.localeCompare(right))
}

function memorySnapshot(memory) {
  return Object.fromEntries(markdownFiles(memory).map((filePath) => [
    normalizedRelative(memory, filePath),
    fileSnapshot(filePath),
  ]))
}

function memoryHome() {
  return path.resolve(required('memory'))
}

function findVaultRoot(memory) {
  let current = memory
  while (true) {
    const candidate = path.join(current, 'VAULT-INDEX.md')
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(`VAULT-INDEX.md not found above ${memory}`)
}

function nzDate() {
  const parts = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function nzNow() {
  const date = new Date()
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
  const time = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date).replace(/\b(am|pm)\b/i, (value) => value.toUpperCase())
  return `${day} ${time}`
}

function dailyPath(memory) {
  if (args.daily) return path.resolve(args.daily)
  return path.join(findVaultRoot(memory), '01 - Daily Notes', `${nzDate()}.md`)
}

// The collector creates today's note rather than leaving it to the worker.
// A worker's own file tools are not guaranteed to reach the vault — Codex runs
// its worker in a sandbox owned by a different account, so its patch could not
// create a file under the user's OneDrive, and the save failed validation for a
// note that could never have been written. The collector already writes there
// with fs, so creation belongs here; the worker still authors the session
// content through the plan.
//
// Deliberately NO `## Session` heading: the worker adds the first one in the
// same plan, so a first save of the day is not a special case, and an empty
// placeholder session never reaches the vault. Frontmatter is forced to the
// values validateDaily requires — the shipped template declares
// `project: meta` / `type: reference`, which would fail validation verbatim.
function ensureDailyNote(dailyFile) {
  if (fs.existsSync(dailyFile)) return false
  const date = path.basename(dailyFile, '.md')
  const content = [
    '---',
    `date: ${date}`,
    'status: active',
    'project: personal',
    'type: log',
    '---',
    '',
    `# ${date}`,
    '',
    '## Index',
    '',
  ].join('\n')
  fs.mkdirSync(path.dirname(dailyFile), { recursive: true })
  fs.writeFileSync(dailyFile, content, 'utf8')
  return true
}

function emitChunk(label, filePath, text, extra = []) {
  const bytes = Buffer.byteLength(text, 'utf8')
  process.stdout.write(`===== START_SAVE_CHUNK ${label} =====\n`)
  process.stdout.write(`PATH=${filePath}\nBYTES=${bytes}\nSHA256=${sha256(text)}\n`)
  for (const line of extra) process.stdout.write(`${line}\n`)
  process.stdout.write(text)
  if (text && !text.endsWith('\n')) process.stdout.write('\n')
  process.stdout.write(`===== END_SAVE_CHUNK ${label} =====\n`)
}

// A `.git` ENTRY is not a repository. An abandoned or half-created `.git`
// directory with no HEAD, config, objects or refs satisfies existsSync, so the
// old check adopted it as the repo and then every git command against it failed
// — the save aborted on a project that simply had no repository yet. Ask git
// itself rather than trusting the presence of a path.
// DETECTION MUST USE THE SAME GIT INVOCATION AS `git()`, which sets
// safe.directory. A repository created by another account — a sandboxed agent
// running as its own user, for instance — makes bare git commands fail with
// "detected dubious ownership". Detection without the flag then reported NO
// REPOSITORY on a perfectly good repo, while every actual git call would have
// worked, because those go through `git()`.
function gitProbe(directory, commandArgs) {
  return spawnSync('git', ['-c', `safe.directory=${directory}`, '-C', directory, ...commandArgs], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  })
}

function isRepo(directory) {
  return gitProbe(directory, ['rev-parse', '--git-dir']).status === 0
}

function findRepo(workspace) {
  const root = path.resolve(workspace)
  const direct = gitProbe(root, ['rev-parse', '--show-toplevel'])
  if (direct.status === 0 && direct.stdout.trim()) return path.resolve(direct.stdout.trim())

  const queue = [{ directory: root, depth: 0 }]
  while (queue.length) {
    const { directory, depth } = queue.shift()
    if (fs.existsSync(path.join(directory, '.git')) && isRepo(directory)) return directory
    if (depth >= 2) continue
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 })
    }
  }
  // No repository is a legitimate state, not an error: a project can be real
  // work with real memory long before it is put under version control. The save
  // degrades to the filesystem facts instead of aborting. Callers use
  // `repoRoot()` for filesystem paths and gate git on the null.
  return null
}

/** Filesystem anchor for a project, whether or not it has a repository. */
function repoRoot(repo, workspace) {
  return repo ?? path.resolve(workspace)
}

function run(command, commandArgs, cwd, optional = false) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) {
    if (optional) return ''
    throw result.error
  }
  if (result.status !== 0) {
    if (optional) return ''
    throw new Error(`${command} ${commandArgs.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trimEnd()
}

function git(repo, commandArgs, optional = false) {
  return run('git', ['-c', `safe.directory=${repo}`, '-C', repo, ...commandArgs], repo, optional)
}

function section(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`^##\\s+${escaped}\\s*$\\r?\\n(.*?)(?=^##\\s+|(?![\\s\\S]))`, 'ms'))
  return match ? match[1].trimEnd() : ''
}

function entriesIn(text) {
  const lines = text.split(/\r?\n/)
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{2,4})\s+((?:DNO|PIN|ADR|PAT|TS)-\d+)\b/)
    if (!match) continue
    const level = match[1].length
    let end = index + 1
    while (end < lines.length) {
      const nextHeading = lines[end].match(/^(#+)\s+/)
      if (nextHeading && nextHeading[1].length <= level) break
      end += 1
    }
    entries.push({
      id: match[2],
      heading: lines[index],
      body: lines.slice(index, end).join('\n').trimEnd(),
    })
    index = end - 1
  }
  return entries
}

function nextIds(memory) {
  const maxima = { DNO: 0, PIN: 0, ADR: 0, PAT: 0, TS: 0 }
  for (const filePath of markdownFiles(memory)) {
    for (const entry of entriesIn(readText(filePath))) {
      const [prefix, number] = entry.id.split('-')
      maxima[prefix] = Math.max(maxima[prefix] ?? 0, Number(number))
    }
  }
  return Object.fromEntries(Object.entries(maxima).map(([prefix, maximum]) => [prefix, `${prefix}-${String(maximum + 1).padStart(3, '0')}`]))
}

function deriveBaseCommit(repo, handoff, head) {
  if (args.base) {
    const explicit = git(repo, ['rev-parse', '--verify', `${args.base}^{commit}`], true)
    if (!explicit) throw new Error(`Explicit base commit is not valid: ${args.base}`)
    return explicit
  }
  const checkpoint = section(handoff, 'Commit Checkpoint')
  const candidates = [...new Set((checkpoint.match(/\b[0-9a-f]{7,40}\b/gi) ?? []).map((value) => value.toLowerCase()))]
  for (const candidate of candidates) {
    const resolved = git(repo, ['rev-parse', '--verify', `${candidate}^{commit}`], true)
    if (!resolved) continue
    const ancestor = spawnSync('git', ['-c', `safe.directory=${repo}`, '-C', repo, 'merge-base', '--is-ancestor', resolved, head], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    })
    if (ancestor.status === 0) return resolved
  }
  return ''
}

function dirtyPaths(status) {
  const paths = []
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const raw = line.slice(3).trim()
    paths.push(raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw)
  }
  return paths
}

function changedPaths(repo, base, head, status) {
  const committed = base && base !== head
    ? git(repo, ['diff', '--name-only', `${base}..${head}`], true).split(/\r?\n/).filter(Boolean)
    : []
  return [...new Set([...committed, ...dirtyPaths(status)])].sort((left, right) => left.localeCompare(right))
}

function latestPinReview(memory) {
  const text = readText(path.join(memory, 'Pins-Reference.md'), true)
  const log = section(text, 'Pin Review Log')
  return log.split(/\r?\n/).filter((line) => /^- \d{4}-\d{2}-\d{2} \|/.test(line)).at(-1) ?? ''
}

function selectDaily(text) {
  if (!text) return '[DAILY NOTE ABSENT]\n'
  const sessionMatches = [...text.matchAll(/^## Session \d+.*$/gm)]
  if (!sessionMatches.length) return text
  const prefix = text.slice(0, sessionMatches[0].index).trimEnd()
  const last = sessionMatches.at(-1)
  const lastSession = text.slice(last.index).trimEnd()
  const maxSessionBytes = 18000
  const sessionBytes = Buffer.byteLength(lastSession, 'utf8')
  return [
    prefix,
    '',
    `DAILY_PRIOR_SESSION_COUNT=${sessionMatches.length}`,
    sessionBytes <= maxSessionBytes ? lastSession : `DAILY_LAST_SESSION_DEFERRED bytes=${sessionBytes}`,
    '',
  ].join('\n')
}

function emitFilePacket() {
  const memory = memoryHome()
  const kind = required('kind')
  const files = {
    handoff: path.join(memory, 'HANDOFF.md'),
    pins: path.join(memory, 'Pins.md'),
    index: path.join(memory, '_Index.md'),
  }
  if (files[kind]) {
    emitChunk(kind.toUpperCase(), files[kind], readText(files[kind]))
    return
  }
  if (kind === 'daily') {
    const filePath = dailyPath(memory)
    const source = readText(filePath, true)
    emitChunk('DAILY', filePath, selectDaily(source), [`SOURCE_EXISTS=${Boolean(source)}`])
    return
  }
  if (kind === 'pin-review') {
    const filePath = path.join(memory, 'Pins-Reference.md')
    const latest = latestPinReview(memory)
    const bytes = Buffer.byteLength(latest, 'utf8')
    const content = bytes <= 16000 ? `${latest || '[NO PIN REVIEW LOG ENTRY]'}\n` : `[LATEST PIN REVIEW DEFERRED bytes=${bytes}]\n`
    emitChunk('PIN_REVIEW', filePath, content)
    return
  }
  throw new Error(`Unsupported file kind: ${kind}`)
}

function detectFramework(repo) {
  const names = fs.readdirSync(repo)
  const electron = names.find((name) => /^electron\.vite\.config\.(?:js|mjs|cjs|ts|mts|cts)$/i.test(name))
  if (electron) {
    const text = readText(path.join(repo, electron))
    const explicit = text.match(/renderer\s*:\s*\{[\s\S]*?server\s*:\s*\{[\s\S]*?port\s*:\s*(\d+)/m)
    return { framework: 'electron-vite', port: explicit ? Number(explicit[1]) : 5173, explicit: Boolean(explicit) }
  }
  const vite = names.find((name) => /^vite\.config\.(?:js|mjs|cjs|ts|mts|cts)$/i.test(name))
  if (vite) {
    const text = readText(path.join(repo, vite))
    const explicit = text.match(/server\s*:\s*\{[\s\S]*?port\s*:\s*(\d+)/m)
    return { framework: 'vite', port: explicit ? Number(explicit[1]) : 5173, explicit: Boolean(explicit) }
  }
  const packagePath = path.join(repo, 'package.json')
  if (fs.existsSync(packagePath)) {
    const pkg = JSON.parse(readText(packagePath))
    const dev = String(pkg.scripts?.dev ?? '')
    if (/\bnext\s+dev\b/.test(dev)) {
      const explicit = dev.match(/(?:-p|--port(?:=|\s+))(\d+)/)
      return { framework: 'next', port: explicit ? Number(explicit[1]) : 3000, explicit: Boolean(explicit) }
    }
  }
  return { framework: 'unknown', port: null, explicit: false }
}

function probeHttp(port) {
  return new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 1000 }, (response) => {
      response.resume()
      resolve({ port, listening: true, status: response.statusCode ?? 0 })
    })
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve({ port, listening: false, status: 0 }))
    request.end()
  })
}

async function devServerState(repo) {
  const detected = detectFramework(repo)
  if (!detected.port) return 'DEV_SERVER=UNRESOLVED framework=unknown'
  const result = await probeHttp(detected.port)
  return result.listening
    ? `DEV_SERVER=LISTENING framework=${detected.framework} port=${result.port} status=${result.status}`
    : `DEV_SERVER=NOT RUNNING framework=${detected.framework} port=${detected.port}`
}

// The only two save fidelities. `full` and `audit` were synonyms for `max` that
// were never once used in 37 recorded saves, so they are gone; anything else is
// a typo and must fail loudly rather than silently degrade to a lesser save.
// Kept inside the function body deliberately: the mode dispatch runs at the top
// of this file, so a module-level `const` here is still in its temporal dead
// zone by the time a save calls this.
function resolveFidelity(value) {
  const allowed = ['incremental', 'max']
  const fidelity = value ?? 'incremental'
  if (!allowed.includes(fidelity)) {
    fail(`Unknown --fidelity "${fidelity}" (expected ${allowed.join(' or ')})`)
  }
  return fidelity
}

function createManifest(memory, workspace, repo, daily, state) {
  const frozen = {
    handoff: fileSnapshot(path.join(repo, '.claude', 'HANDOFF.md')),
    pins: fileSnapshot(path.join(repo, '.claude', 'context-pins.md')),
  }
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    memory,
    workspace,
    repo,
    daily,
    // Recorded once, here, and read by both apply and validate. Passing it
    // separately to each step is what caused TS-115: apply never received it,
    // defaulted to `incremental`, stamped that into the Pin Review line, and
    // validate then rejected the save for not saying `mode=max`.
    fidelity: resolveFidelity(args.fidelity),
    git: state,
    memoryFiles: memorySnapshot(memory),
    dailyFile: fileSnapshot(daily),
    frozen,
  }
  const token = sha256(`${memory}\0${manifest.createdAt}\0${process.pid}`).slice(0, 16)
  const manifestPath = args.manifest
    ? path.resolve(args.manifest)
    : path.join(os.tmpdir(), `codex-vault-save-${token}.json`)
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifestPath
}

async function emitStatePacket() {
  const memory = memoryHome()
  const workspace = path.resolve(required('workspace'))
  const repo = findRepo(workspace)
  const root = repoRoot(repo, workspace)
  const handoff = readText(path.join(memory, 'HANDOFF.md'))
  // Every git fact degrades to empty when the project has no repository. The
  // save still records memory; it just cannot cross-check it against history.
  const branch = repo ? git(repo, ['branch', '--show-current']) : ''
  const head = repo ? git(repo, ['rev-parse', 'HEAD'], true) : ''
  const origin = repo && branch ? git(repo, ['rev-parse', `origin/${branch}`], true) || 'ABSENT' : 'ABSENT'
  const status = repo ? git(repo, ['status', '--porcelain']) : ''
  const base = repo && head ? deriveBaseCommit(repo, handoff, head) : ''
  const paths = repo ? changedPaths(repo, base, head, status) : []
  const commits = base && base !== head
    ? git(repo, ['log', '--max-count=20', '--date=short', '--pretty=format:%H%x09%ad%x09%s', `${base}..${head}`], true)
    : '[NO COMMITTED DELTA FROM CHECKPOINT]'
  const ids = nextIds(memory)
  const daily = dailyPath(memory)
  // Must happen BEFORE createManifest: the manifest snapshots the daily note,
  // and a file appearing after that snapshot is exactly what the tamper guard
  // refuses.
  const dailyCreated = ensureDailyNote(daily)
  const server = await devServerState(root)
  const manifest = createManifest(memory, workspace, root, daily, { branch, head, origin, status })
  const maxPaths = 100
  const shownPaths = paths.slice(0, maxPaths)
  process.stdout.write([
    '===== START_SAVE_STATE_PACKET =====',
    `MEMORY=${memory}`,
    `VAULT_ROOT=${findVaultRoot(memory)}`,
    `DAILY=${daily}${dailyCreated ? ' [CREATED by the collector — add this session via the plan\'s daily.session]' : ''}`,
    `NZ_NOW=${nzNow()}`,
    `REPO=${root}${repo ? '' : ' [NO GIT REPOSITORY — git facts unavailable; memory is still saved]'}`,
    `BRANCH=${branch || (repo ? '(detached)' : '(no repository)')}`,
    `HEAD=${head}`,
    `ORIGIN_BRANCH=${origin}`,
    `TREE=${status ? 'DIRTY' : 'CLEAN'}`,
    `BASE_COMMIT=${base || 'UNRESOLVED'}`,
    `MANIFEST=${manifest}`,
    `NEXT_IDS=${Object.values(ids).join(',')}`,
    `LATEST_PIN_REVIEW=${latestPinReview(memory) || 'none'}`,
    server,
    '===== GIT_STATUS_PORCELAIN =====',
    status || '[CLEAN]',
    '===== COMMIT_DELTA =====',
    commits,
    `===== CHANGED_PATHS count=${paths.length} deferred=${Math.max(0, paths.length - shownPaths.length)} =====`,
    shownPaths.join('\n') || '[NONE]',
    '===== END_SAVE_STATE_PACKET =====',
    '',
  ].join('\n'))
}

function deriveBundleTerms(repo, base, head, paths, handoff) {
  const commits = base && base !== head
    ? git(repo, ['log', '--max-count=20', '--pretty=format:%s', `${base}..${head}`], true)
    : ''
  const focus = [
    section(handoff, 'Current Task'),
    section(handoff, 'Next Priority'),
    section(handoff, 'Progress'),
    commits,
  ].join('\n')
  const pathTerms = paths.flatMap((filePath) => {
    const baseName = path.posix.basename(filePath)
    const extension = path.posix.extname(baseName)
    return [filePath, baseName, extension ? baseName.slice(0, -extension.length) : baseName]
  })
  const words = focus.match(/[A-Za-z][A-Za-z0-9_.:/-]{2,}/g) ?? []
  const stop = new Set([
    'the', 'and', 'for', 'from', 'with', 'into', 'this', 'that', 'current', 'next',
    'task', 'priority', 'progress', 'workflow', 'state', 'branch', 'master', 'clean',
    'implemented', 'saved', 'checkpoint', 'resume', 'verified', 'none', 'actions',
  ])
  return [...new Set([...pathTerms, ...words]
    .map((value) => value.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((value) => value.length >= 3 && !stop.has(value)))]
    .slice(0, 16)
}

function deriveBundleIds(handoff, review) {
  return [...new Set(`${handoff}\n${review}`.match(/\b(?:DNO|PIN|ADR|PAT|TS)-\d{3}\b/g) ?? [])]
}

function emitPlanProtocolPacket() {
  process.stdout.write([
    '===== START_SAVE_PLAN_PROTOCOL =====',
    'PLAN_FILE_CONTENT=one direct JSON object; omit empty keys',
    'ALLOWED_TOP_LEVEL_KEYS=replace|appendEntries|replaceEntries|removeEntries|insertBefore|appendText|daily|allowUnchanged',
    'FORBIDDEN_WRAPPERS=version|manifest|writes|changed_keys|files',
    'PLAN_SCHEMA_BEGIN',
    '{',
    '  "replace": { "HANDOFF.md": "<complete new file>" },',
    '  "appendEntries": { "Decisions.md": ["<complete ADR>"], "Patterns.md": ["<complete PAT>"], "Troubleshooting.md": ["<complete TS>"] },',
    '  "replaceEntries": { "Pins-Reference.md": [{ "id": "PIN-...", "text": "<complete replacement entry>" }] },',
    '  "removeEntries": { "Pins-Reference.md": ["PIN-..."] },',
    '  "insertBefore": { "Pins-Reference.md": [{ "heading": "## Pin Review Log", "text": "<complete new PIN entries>" }] },',
    '  "appendText": { "Pins-Reference.md": "<one Pin Review Log line>" },',
    '  "daily": { "indexLine": "- **Topic** — outcome.", "session": "## Session N — <NZ_NOW time>: Title\\n..." },',
    '  "allowUnchanged": ["HANDOFF.md"]',
    '}',
    'PLAN_SCHEMA_END',
    'INTENT_CHECK=every file your plan writes MUST end up different from what it held before AND different from its pre-save content. The collector checks this BEFORE writing anything: on failure it reports INTENDED_WRITE_DID_NOT_LAND, the memory home is untouched, and re-running after fixing the plan is always safe. If you MEAN to restore a file to its pre-save state on a corrective re-apply, declare it by listing its key in allowUnchanged; the key must be one the same plan writes. Omit allowUnchanged entirely otherwise — never add a key to quiet a failure you have not understood, and note that every declared key is echoed back as DECLARED_UNCHANGED for the record.',
    'COLLECTOR_GUARANTEES=the collector owns mechanical correctness: (1) it stamps the four _Index.md live counts to the true post-apply count (never hand-author them; put _Index.md in replace only for structure/status prose); (2) it normalizes each appended/inserted entry heading to the file canonical level; (3) it guarantees a Pin Review Log line. Take the validator --changed list from PLANNED_CHANGED (it may list _Index.md or Pins-Reference.md even when your plan omitted them).',
    'DNO_AUTHORITY=every new or replaced DNO must contain `**Authority:** Explicit user approval — <evidence>` or `**Authority:** Authoritative project decision — <file and heading>`; inferred implementation state is never authority.',
    'REFERENTIAL_INTEGRITY=every entry ID you cite in a Source/Refs field (e.g. ADR-109) must be created in this save or already exist; validation fails on any dangling reference.',
    'PLAN_RUNTIME=JSON.stringify and string methods are available; btoa, atob, TextEncoder, Buffer, --plan-base64, and shell redirection are forbidden',
    // THE COLLECTOR WRITES TO THE MEMORY HOME. The harness must not.
    //
    // This flow used to render a patch and hand it to tools.apply_patch. That
    // routes every vault write through the harness's filesystem helper, which is
    // sandboxed to the workspace — a memory home under the user's OneDrive is
    // outside it, and the write failed with
    // "helper_unknown_error: setup refresh had errors", leaving the save with the
    // daily note created and nothing else written.
    //
    // A shell_command running node has no such limit: the same save that failed
    // to apply its patch had already created the memory home, archived a 37KB
    // legacy handoff and written the daily note, all through node. So `apply`
    // does the writing and the harness only creates the plan file, which lives in
    // the system temp directory and is therefore inside the sandbox.
    'PLAN_WRITE_JS_BEGIN',
    'const planPath = manifest + ".plan.json";',
    'const json = JSON.stringify(plan, null, 2) + "\\n";',
    'const planPatch = ["*** Begin Patch", `*** Add File: ${planPath.replace(/\\\\/g, "/")}`, ...json.trimEnd().split("\\n").map((line) => `+${line}`), "*** End Patch"].join("\\n");',
    'await tools.apply_patch(planPatch);',
    'const applied = await tools.shell_command({ command: `node "${collector}" --mode apply --manifest "${manifest}" --plan "${planPath}" --cleanup-plan true`, workdir: workspace, timeout_ms: 120000 });',
    'const changed = /APPLIED_CHANGED=(.*)/.exec(applied)?.[1]?.trim();',
    'if (!changed) throw new Error("apply did not report APPLIED_CHANGED: " + applied);',
    'const validation = await tools.shell_command({ command: `node "${collector}" --mode validate --manifest "${manifest}" --memory "${memory}" --workspace "${workspace}" --changed "${changed}"`, workdir: workspace, timeout_ms: 120000 });',
    'PLAN_WRITE_JS_END',
    'APPLY_MODE_OUTPUT=APPLIED_CHANGED=<pipe-separated>, DECLARED_UNCHANGED=<pipe-separated or none>, and APPLY_STATUS=WRITTEN between START_SAVE_APPLY_RESULT and END_SAVE_APPLY_RESULT. The collector has already written every file; there is no patch to apply and tools.apply_patch must NOT be used for any memory-home path.',
    'VALIDATE_REQUIRED_ARGS=--manifest|--memory|--workspace|--changed',
    'CHANGED_VALUES=copy APPLIED_CHANGED verbatim; pipe-separated. Do NOT derive it from your plan keys: on a corrective re-apply the plan keys are a subset of what has actually changed since orientation, and validate rejects the difference as Unexpected changed file.',
    'SUCCESS=the same second exec runs apply then validate and returns SAVE_VALIDATION=PASS',
    '===== END_SAVE_PLAN_PROTOCOL =====',
    '',
  ].join('\n'))
}

async function emitBundlePacket() {
  const memory = memoryHome()
  const workspace = path.resolve(required('workspace'))
  const repo = findRepo(workspace)
  const handoff = readText(path.join(memory, 'HANDOFF.md'))
  const head = repo ? git(repo, ['rev-parse', 'HEAD'], true) : ''
  const status = repo ? git(repo, ['status', '--porcelain']) : ''
  const base = repo && head ? deriveBaseCommit(repo, handoff, head) : ''
  const paths = repo ? changedPaths(repo, base, head, status) : []
  const review = latestPinReview(memory)
  const terms = repo ? deriveBundleTerms(repo, base, head, paths, handoff) : []
  const ids = deriveBundleIds(handoff, review)

  process.stdout.write('===== START_SAVE_BUNDLE =====\n')
  await emitStatePacket()
  for (const kind of ['handoff', 'pins', 'index', 'daily', 'pin-review']) {
    args.kind = kind
    emitFilePacket()
  }
  process.stdout.write([
    '===== START_SAVE_BUNDLE_TARGETING =====',
    `BUNDLE_IDS=${ids.join(',') || 'none'}`,
    `BUNDLE_TERMS=${terms.join('|') || 'none'}`,
    `BUNDLE_CHANGED_PATHS=${paths.join('|') || 'none'}`,
    '===== END_SAVE_BUNDLE_TARGETING =====',
    '',
  ].join('\n'))
  args.ids = ids.join('|')
  args.terms = terms.join('|')
  args['max-entries'] = '3'
  args['max-bytes'] = '12000'
  for (const fileName of ['Pins-Reference.md', 'Decisions.md', 'Patterns.md', 'Troubleshooting.md']) {
    args.file = fileName
    emitTargetPacket()
  }
  args.base = base
  delete args.paths
  args['max-paths'] = '6'
  args['max-bytes'] = '32000'
  args['per-path-bytes'] = '10000'
  emitSourcePacket()
  emitPlanProtocolPacket()
  process.stdout.write('===== END_SAVE_BUNDLE =====\n')
}

function cleanTerms() {
  const stop = new Set(['save', 'session', 'current', 'project', 'change', 'changes', 'update', 'updated'])
  return [...new Set(listArg('terms')
    .map((term) => term.toLowerCase())
    .filter((term) => term.length >= 3 && !stop.has(term)))]
    .slice(0, 12)
}

function emitTargetPacket() {
  const memory = memoryHome()
  const fileName = required('file')
  const allowed = new Set(['Pins-Reference.md', 'Decisions.md', 'Patterns.md', 'Troubleshooting.md'])
  if (!allowed.has(fileName)) throw new Error(`Unsupported target file: ${fileName}`)
  const filePath = path.join(memory, fileName)
  const entries = entriesIn(readText(filePath))
  const exactIds = new Set(listArg('ids').map((id) => id.toUpperCase()))
  const terms = cleanTerms()
  const scored = entries.map((entry) => {
    const heading = entry.heading.toLowerCase()
    const body = entry.body.toLowerCase()
    let score = exactIds.has(entry.id) ? 1000 : 0
    for (const term of terms) {
      if (heading.includes(term)) score += 20
      else if (body.includes(term)) score += 2
    }
    return { entry, score }
  }).filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || Number(right.entry.id.split('-')[1]) - Number(left.entry.id.split('-')[1]))

  const maxEntries = Number(args['max-entries'] ?? 4)
  const maxBytes = Number(args['max-bytes'] ?? 24000)
  const selected = scored.slice(0, maxEntries)
  const omittedMatches = scored.slice(maxEntries).map(({ entry }) => entry.id)
  const delivered = []
  const deferred = [...omittedMatches]
  let used = 0
  for (const { entry } of selected) {
    const bytes = Buffer.byteLength(entry.body, 'utf8')
    if (used + bytes > maxBytes) deferred.push(entry.id)
    else {
      delivered.push(entry)
      used += bytes
    }
  }
  process.stdout.write([
    `===== START_SAVE_TARGET_FILE ${fileName} =====`,
    `TARGET_FILE=${fileName}`,
    `EXACT_IDS=${[...exactIds].join(',') || 'none'}`,
    `TERMS=${terms.join('|') || 'none'}`,
    `MATCHED_IDS=${scored.map(({ entry }) => entry.id).join(',') || 'none'}`,
    `DELIVERED_IDS=${delivered.map((entry) => entry.id).join(',') || 'none'}`,
    `DEFERRED_IDS=${[...new Set(deferred)].join(',') || 'none'}`,
    `DELIVERED_BYTES=${used}`,
    ...delivered.flatMap((entry) => [
      `===== START_SAVE_TARGET ${entry.id} =====`,
      entry.body,
      `===== END_SAVE_TARGET ${entry.id} =====`,
    ]),
    `===== END_SAVE_TARGET_FILE ${fileName} =====`,
    '',
  ].join('\n'))
}

function safeRepoPath(repo, relativePath) {
  const normalized = relativePath.split('/').join(path.sep)
  const resolved = path.resolve(repo, normalized)
  const relation = path.relative(repo, resolved)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`Path is outside repo or not a file path: ${relativePath}`)
  }
  return normalizedRelative(repo, resolved)
}

function emitSourcePacket() {
  const repo = findRepo(required('workspace'))
  // Source diffs are a git product. With no repository there is nothing to diff,
  // which is reported rather than treated as a failure.
  if (!repo) {
    process.stdout.write([
      '===== START_SAVE_SOURCE_PACKET =====',
      'SOURCE_DIFFS=none (project has no git repository)',
      '===== END_SAVE_SOURCE_PACKET =====',
      '',
    ].join('\n'))
    return
  }
  const head = git(repo, ['rev-parse', 'HEAD'], true)
  const baseInput = args.base && args.base !== 'UNRESOLVED' ? args.base : ''
  const base = baseInput ? git(repo, ['rev-parse', '--verify', `${baseInput}^{commit}`], true) : ''
  const status = git(repo, ['status', '--porcelain'])
  const changed = changedPaths(repo, base, head, status)
  const requestedPaths = listArg('paths').map((filePath) => safeRepoPath(repo, filePath))
  const chosen = (requestedPaths.length ? requestedPaths : changed).filter((filePath) => changed.includes(filePath))
  const rejected = requestedPaths.filter((filePath) => !changed.includes(filePath))
  const maxPaths = Number(args['max-paths'] ?? 8)
  const maxBytes = Number(args['max-bytes'] ?? 48000)
  const perPath = Number(args['per-path-bytes'] ?? 14000)
  const delivered = []
  const deferred = [...chosen.slice(maxPaths)]
  let used = 0
  for (const filePath of chosen.slice(0, maxPaths)) {
    const committed = base && base !== head
      ? git(repo, ['diff', '--no-ext-diff', '--unified=2', `${base}..${head}`, '--', filePath], true)
      : ''
    const dirty = git(repo, ['diff', '--no-ext-diff', '--unified=2', '--', filePath], true)
    const staged = git(repo, ['diff', '--cached', '--no-ext-diff', '--unified=2', '--', filePath], true)
    const content = [committed, dirty, staged].filter(Boolean).join('\n') || '[PATH CHANGED WITHOUT TEXT DIFF]'
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > perPath || used + bytes > maxBytes) deferred.push(filePath)
    else {
      delivered.push({ filePath, content, bytes })
      used += bytes
    }
  }
  process.stdout.write([
    '===== START_SAVE_SOURCE_PACKET =====',
    `REPO=${repo}`,
    `BASE=${base || 'UNRESOLVED'}`,
    `HEAD=${head}`,
    `CHANGED_PATH_COUNT=${changed.length}`,
    `REQUESTED_PATHS=${requestedPaths.join('|') || 'none'}`,
    `DELIVERED_PATHS=${delivered.map(({ filePath }) => filePath).join('|') || 'none'}`,
    `DEFERRED_PATHS=${[...new Set(deferred)].join('|') || 'none'}`,
    `REJECTED_PATHS=${rejected.join('|') || 'none'}`,
    `DELIVERED_BYTES=${used}`,
    ...delivered.flatMap(({ filePath, content, bytes }) => [
      `===== START_SAVE_SOURCE ${filePath} bytes=${bytes} =====`,
      content,
      `===== END_SAVE_SOURCE ${filePath} =====`,
    ]),
    '===== END_SAVE_SOURCE_PACKET =====',
    '',
  ].join('\n'))
}

function hasFrontmatter(text) {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n/.test(text)
}

function patchLines(text, prefix) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '')
  return normalized.split('\n').map((line) => `${prefix}${line}`)
}

function assertMemoryPath(memory, relativePath) {
  const normalized = String(relativePath).split('/').join(path.sep)
  const resolved = path.resolve(memory, normalized)
  const relation = path.relative(memory, resolved)
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`Patch plan path is outside memory home: ${relativePath}`)
  }
  return resolved
}

// Only `exists` and `sha256` decide identity here — `bytes`/`mtimeMs` cannot be
// predicted for a write the collector does not perform itself.
function snapshotMismatch(expected, actual) {
  for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])]) {
    const left = expected[key] ?? { exists: false }
    const right = actual[key] ?? { exists: false }
    if (left.exists !== right.exists || left.sha256 !== right.sha256) return key
  }
  return null
}

// The manifest accumulates every state the collector itself produced or expects:
//
//   memoryFiles / dailyFile        pre-save. Never rewritten — validate diffs
//                                  against it to derive the full change set.
//   appliedFiles / appliedDaily    what `apply` actually wrote.
//   projectedFiles / projectedDaily  what `patch` expects apply_patch to produce.
//
// The guard passes if memory matches ANY of them. Step 6 tells the worker to
// re-apply a corrective plan after a failed validate, but the first apply had
// already moved the files off the orientation snapshot, so the guard rejected
// the repair with "Memory changed after orientation" and left the save
// half-written with no sanctioned way to fix it.
//
// Accepting any known checkpoint — rather than just the newest — matters for the
// patch flow, where the manifest records the expected result BEFORE apply_patch
// runs. Regenerating a patch that was never applied must keep working, so
// pre-write state has to stay acceptable too. A genuine outside edit still
// matches no checkpoint at all.
function assertUnchangedSinceManifest(manifest) {
  const current = memorySnapshot(manifest.memory)
  const currentDaily = fileSnapshot(manifest.daily)
  const checkpoints = [
    ['the last apply', manifest.appliedFiles, manifest.appliedDaily],
    ['the generated patch', manifest.projectedFiles, manifest.projectedDaily],
    ['orientation', manifest.memoryFiles, manifest.dailyFile],
  ].filter(([, files]) => Boolean(files))

  // Fail CLOSED. A manifest carrying no snapshot at all is malformed or forged,
  // and an empty checkpoint list would otherwise skip the loop and return clean,
  // letting `--manifest` point at a hand-written stub to bypass the guard.
  if (!checkpoints.length) throw new Error('Manifest carries no memory snapshot to verify against')

  let firstMismatch = null
  for (const [stage, files, daily] of checkpoints) {
    const mismatch = snapshotMismatch(files ?? {}, current)
    const dailyExpected = daily ?? { exists: false }
    const dailyChanged = currentDaily.exists !== dailyExpected.exists || currentDaily.sha256 !== dailyExpected.sha256
    if (!mismatch && !dailyChanged) return
    if (!firstMismatch) firstMismatch = { stage, mismatch, dailyChanged }
  }
  if (!firstMismatch) return
  throw new Error(firstMismatch.mismatch
    ? `Memory changed after ${firstMismatch.stage}: ${firstMismatch.mismatch}`
    : `Daily note changed after ${firstMismatch.stage}`)
}

// The one definition of "what this save changed", shared by every writer and by
// validate. Both sides MUST compute it the same way against the ORIENTATION
// snapshot, or they disagree:
//
//   - reporting only the current invocation's files broke Step 6 recovery, since
//     validate measures cumulatively and rejected the first apply's files as
//     "Unexpected changed file";
//   - accumulating a union of plan keys across invocations breaks the other
//     direction: a correction that restores a file to its original content claims
//     a change that never happened ("Expected file did not change"). The same
//     union would have done it for a regenerated-but-unapplied patch had the
//     patch path ever read it, which it did not.
//
// This function answers ONE question — "what does the end state differ from
// orientation in?" — and it is deliberately blind to intent. The intent side of
// the cross-check lives in unlandedIntendedWrites below, where it belongs: a
// changed set that also policed intent would be the very conflation PAT-150
// warns about.
//
// Diffing an end state against orientation is exactly right in every one of those
// cases, and it is what validate already does.
function changedAgainstOrientation(manifest, afterFiles, afterDaily) {
  const before = manifest.memoryFiles ?? {}
  const keys = [...new Set([...Object.keys(before), ...Object.keys(afterFiles)])].sort()
  const changed = []
  for (const key of keys) {
    const left = before[key] ?? { exists: false }
    const right = afterFiles[key] ?? { exists: false }
    if (left.exists !== right.exists || left.sha256 !== right.sha256) changed.push(key)
  }
  const beforeDaily = manifest.dailyFile ?? { exists: false }
  if (beforeDaily.exists !== afterDaily.exists || beforeDaily.sha256 !== afterDaily.sha256) {
    changed.push('@daily')
  }
  return changed
}

// The intent half of the cross-check that deriving the changed set from disk
// state used to cost us (the old KNOWN TRADE-OFF here). buildFileHunks emits a
// hunk only for a file the PLAN asked to write, so the hunk keys are the
// worker's declared intent, recorded before anything is written. Comparing them
// against what the write actually produced catches two shapes of silent no-op:
//
//   - byte-identical output — the plan restated content the file already had, so
//     this invocation did nothing at all;
//   - output identical to the ORIENTATION content — the corrective re-apply that
//     regenerates a file back to its pre-save state. This is the one that used
//     to pass silently: the file legitimately does not belong in the changed
//     set, so validate sees nothing wrong, and from disk alone a botched
//     regeneration is indistinguishable from a deliberate restore.
//
// Which is why the escape hatch is a declaration and not an inference: a worker
// that genuinely means to restore a file lists the key in the plan's
// `allowUnchanged`, and the check stands down for that key alone. Intent is
// stated up front or it is not honoured.
function unlandedIntendedWrites(intended, before, after, changedKeys, allowUnchanged) {
  const changed = new Set(changedKeys)
  const allowed = new Set(allowUnchanged)
  const problems = []
  for (const key of intended) {
    if (allowed.has(key)) continue
    const left = before[key] ?? { exists: false }
    const right = after[key] ?? { exists: false }
    // Compare on exists + sha256 only. A projected snapshot carries no mtimeMs,
    // so anything richer would report a phantom difference on the patch path.
    if (left.exists === right.exists && left.sha256 === right.sha256) {
      problems.push(`${key} (the plan produced byte-identical content)`)
    } else if (!changed.has(key)) {
      problems.push(`${key} (the plan restored it to its pre-save content)`)
    }
  }
  return problems
}

function assertIntendedWritesLanded(stage, intended, before, after, changedKeys, allowUnchanged) {
  const problems = unlandedIntendedWrites(intended, before, after, changedKeys, allowUnchanged)
  if (!problems.length) return
  // Both callers run this against a PROJECTION, before anything is written, so
  // the promise below holds. An earlier revision checked the apply path AFTER
  // writing, which made its own advice impossible to follow: the declared re-run
  // then hit "Full replacement is identical to current content", because the
  // write it was meant to authorise had already landed.
  throw new Error(
    `INTENDED_WRITE_DID_NOT_LAND (${stage}): ${problems.join('; ')}. ` +
    'Nothing has been written and the memory home is untouched. The plan asked ' +
    'to write these files, and the result would leave them exactly as they are. ' +
    'Either the plan is wrong, or the restore is deliberate — if it is deliberate, ' +
    'declare it: add "allowUnchanged": ["<key>"] to the plan and re-run.'
  )
}

// Record where a successful apply left the files, so a corrective re-apply is
// measured against that rather than against pre-save state.
function recordAppliedSnapshot(manifest, manifestPath) {
  manifest.appliedFiles = memorySnapshot(manifest.memory)
  manifest.appliedDaily = fileSnapshot(manifest.daily)
  manifest.appliedAt = new Date().toISOString()
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { files: manifest.appliedFiles, daily: manifest.appliedDaily }
}

// The patch flow hands the write to the harness's apply_patch, so the collector
// records what it expects the result to be. Same hunks and same trailing-newline
// rule as `apply`, so the two agree byte for byte. Returning the projected end
// state lets PLANNED_CHANGED be derived from it rather than from this plan's
// keys — which is what makes a corrective re-patch reconcile.
// What the end state WOULD be, computed without touching disk or the manifest.
// Both write paths run the intent check against this BEFORE committing anything,
// so a plan that would change nothing is refused while the memory home is still
// pristine and there is nothing to unwind.
function projectFileHunks(manifest, memory, fileHunks) {
  const files = memorySnapshot(memory)
  let daily = fileSnapshot(manifest.daily)
  for (const [key, hunks] of fileHunks) {
    const filePath = key === '@daily' ? manifest.daily : assertMemoryPath(memory, key)
    const updated = applyCollectorHunks(readText(filePath, true), hunks)
    const content = updated.endsWith('\n') ? updated : `${updated}\n`
    const snapshot = { exists: true, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256(content) }
    if (key === '@daily') daily = snapshot
    else files[key] = snapshot
  }
  return { files, daily }
}

function recordProjectedSnapshot(manifest, manifestPath, projected) {
  manifest.projectedFiles = projected.files
  manifest.projectedDaily = projected.daily
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return projected
}

function normalizePlan(plan) {
  const allowedKeys = ['replace', 'appendEntries', 'replaceEntries', 'removeEntries', 'insertBefore', 'appendText', 'daily', 'allowUnchanged']
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(plan)) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported patch-plan key: ${key}. Allowed top-level keys: ${allowedKeys.join(', ')}. Put the plan object directly in the file without version, manifest, writes, changed_keys, or files wrappers.`)
    }
  }
  return {
    replace: plan.replace ?? {},
    appendEntries: plan.appendEntries ?? {},
    replaceEntries: plan.replaceEntries ?? {},
    removeEntries: plan.removeEntries ?? {},
    insertBefore: plan.insertBefore ?? {},
    appendText: plan.appendText ?? {},
    daily: plan.daily ?? null,
    // Declared intent, not a write instruction: the keys this plan expects to
    // end up unchanged. A bare string is accepted so a single restore does not
    // need array ceremony.
    allowUnchanged: normalizeAllowUnchanged(plan.allowUnchanged),
  }
}

function normalizeAllowUnchanged(value) {
  if (value == null) return []
  const list = Array.isArray(value) ? value : [value]
  return list.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('allowUnchanged must be file keys as strings, e.g. ["HANDOFF.md"] or ["@daily"]')
    }
    return entry.split(path.sep).join('/')
  })
}

function validatePlanFileKeys(memory, plan) {
  const keys = new Set([
    ...Object.keys(plan.replace),
    ...Object.keys(plan.appendEntries),
    ...Object.keys(plan.replaceEntries),
    ...Object.keys(plan.removeEntries),
    ...Object.keys(plan.insertBefore),
    ...Object.keys(plan.appendText),
  ])
  for (const key of keys) assertMemoryPath(memory, key)
  return keys
}

function hasDnoAuthority(text) {
  return /^\*\*Authority:\*\* (?:Explicit user approval|Authoritative project decision) — \S.+$/m.test(text)
}

function validateDnoAuthority(plan) {
  const candidates = []
  for (const [file, text] of Object.entries(plan.replace)) candidates.push({ file, text: String(text) })
  for (const [file, entries] of Object.entries(plan.appendEntries)) {
    for (const text of entries) candidates.push({ file, text: String(text) })
  }
  for (const [file, entries] of Object.entries(plan.replaceEntries)) {
    for (const item of entries) candidates.push({ file, text: String(item.text) })
  }
  for (const [file, entries] of Object.entries(plan.insertBefore)) {
    for (const item of entries) candidates.push({ file, text: String(item.text) })
  }

  for (const candidate of candidates) {
    for (const entry of entriesIn(candidate.text).filter(({ id }) => id.startsWith('DNO-'))) {
      if (!hasDnoAuthority(entry.body)) {
        throw new Error(
          `DNO_AUTHORITY_REQUIRED: ${entry.id} in ${candidate.file} must contain ` +
          '`**Authority:** Explicit user approval — <evidence>` or ' +
          '`**Authority:** Authoritative project decision — <file and heading>`'
        )
      }
    }
  }
}

function fullReplaceHunk(oldText, newText) {
  if (oldText === newText) throw new Error('Full replacement is identical to current content')
  return ['@@', ...patchLines(oldText, '-'), ...patchLines(newText, '+')]
}

function entryReplacementHunk(currentText, id, replacement = null) {
  const matches = entriesIn(currentText).filter((entry) => entry.id === id)
  if (matches.length !== 1) throw new Error(`Expected exactly one entry ${id}; found ${matches.length}`)
  const oldBody = matches[0].body
  if (replacement !== null && !String(replacement).trimStart().startsWith(`${matches[0].heading.match(/^#+\s+/)?.[0] ?? ''}${id}`)) {
    throw new Error(`Replacement entry heading does not match ${id}`)
  }
  return [
    '@@',
    ...patchLines(oldBody, '-'),
    ...(replacement === null ? [] : patchLines(String(replacement).trimEnd(), '+')),
  ]
}

function insertBeforeHunk(currentText, heading, text) {
  const occurrences = currentText.split(/\r?\n/).filter((line) => line === heading).length
  if (occurrences !== 1) throw new Error(`Expected exactly one heading anchor ${heading}; found ${occurrences}`)
  if (currentText.includes(String(text).trim())) throw new Error(`Insert-before content already exists for ${heading}`)
  return ['@@', `-${heading}`, ...patchLines(String(text).trimEnd(), '+'), '+', `+${heading}`]
}

function appendHunk(currentText, text) {
  const addition = String(text).trim()
  if (!addition) throw new Error('Append content is empty')
  if (currentText.includes(addition)) throw new Error('Append content already exists')
  const lines = currentText.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const anchor = lines.at(-1)
  if (!anchor) throw new Error('Cannot append to an empty file')
  return ['@@', `-${anchor}`, `+${anchor}`, '+', ...patchLines(addition, '+'), '*** End of File']
}

// The Pin Review Log line must land INSIDE the `## Pin Review Log` section,
// because `latestPinReview` reads only that section. A plain end-of-file append
// happens to satisfy that today purely because the section is currently last in
// Pins-Reference.md — add any section after it and every save's line would land
// outside the reader's window, failing validation for a reason that points
// nowhere near the cause. Anchor on the section instead of the file so the
// layout stops mattering.
// Constants live inside the function: the mode dispatch runs at the top of this
// file, so anything at module scope is still in its temporal dead zone when a
// save calls in. Same trap as `resolveFidelity` (TS-115).
function pinReviewAppendHunk(currentText, text) {
  const heading = 'Pin Review Log'
  const datedLine = /^- \d{4}-\d{2}-\d{2} \|/
  const addition = String(text).trim()
  if (!addition) throw new Error('Append content is empty')
  if (currentText.includes(addition)) throw new Error('Append content already exists')

  const lines = currentText.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const headingPattern = new RegExp(`^##\\s+${heading}\\s*$`)
  const headingIndex = lines.findIndex((line) => headingPattern.test(line))
  if (headingIndex < 0) {
    throw new Error(`Pins-Reference.md has no "## ${heading}" section to append the review line to`)
  }

  // Section runs to the next same-level heading, or to end of file.
  let end = lines.length
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) { end = index; break }
  }

  // Anchor on the last dated line in the section — it carries a date and free
  // text, so it is effectively unique in the file. With none, anchor the heading
  // itself and open the log.
  let anchorIndex = -1
  for (let index = end - 1; index > headingIndex; index -= 1) {
    if (datedLine.test(lines[index])) { anchorIndex = index; break }
  }
  if (anchorIndex < 0) {
    return ['@@', `-${lines[headingIndex]}`, `+${lines[headingIndex]}`, '+', ...patchLines(addition, '+')]
  }
  return ['@@', `-${lines[anchorIndex]}`, `+${lines[anchorIndex]}`, ...patchLines(addition, '+')]
}

function dailyIndexHunk(currentText, indexLine) {
  const line = String(indexLine).trim()
  if (!line.startsWith('- ')) throw new Error('Daily Index line must be a Markdown bullet')
  if (currentText.includes(line)) throw new Error('Daily Index line already exists')
  const firstSession = currentText.match(/^## Session \d+.*$/m)
  if (firstSession) return ['@@', `-${firstSession[0]}`, `+${line}`, '+', `+${firstSession[0]}`]
  // A note the collector just created has an Index but no session yet — the
  // worker supplies the first one in the same plan. Anchor on the Index heading
  // so the first save of the day is not a special case the worker must detect.
  // `[ \t]*`, not `\s*`: in multiline mode `\s` matches the newline too, so the
  // captured anchor became "## Index\n" — two lines to the line-based applier,
  // which then could not locate it.
  const indexHeading = currentText.match(/^## Index[ \t]*$/m)
  if (!indexHeading) throw new Error('Daily note has no Session or Index heading anchor')
  return ['@@', `-${indexHeading[0]}`, `+${indexHeading[0]}`, '+', `+${line}`]
}

// The heading level an entry file uses for its top-level entries (the modal
// level of its existing entries; ties resolve to the shallower level).
function canonicalEntryLevel(text) {
  const levels = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^(#{2,4})\s+(?:DNO|PIN|ADR|PAT|TS)-\d+\b/)
    if (match) levels.set(match[1].length, (levels.get(match[1].length) ?? 0) + 1)
  }
  if (!levels.size) return null
  return [...levels.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0]
}

// Force a new entry's leading ID heading to the file's canonical level so it can
// never be swallowed as body text of the previous entry (kills the F3 class).
function normalizeEntryHeading(entryText, level) {
  if (level == null) return String(entryText)
  const lines = String(entryText).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === '') continue
    const match = lines[index].match(/^#{1,6}\s+((?:DNO|PIN|ADR|PAT|TS)-\d+\b.*)$/)
    if (match) lines[index] = `${'#'.repeat(level)} ${match[1]}`
    break
  }
  return lines.join('\n')
}

// Normalize every added/inserted entry to its target file's canonical level.
function normalizedAdditions(baseText, texts) {
  const level = canonicalEntryLevel(baseText)
  return texts.map((text) => normalizeEntryHeading(String(text).trim(), level))
}

// True post-apply entry count per tracked file, computed the way validation
// counts (entriesIn), after normalization — so _Index can be stamped to match.
function trueEntryCounts(memory, plan) {
  const counts = {}
  for (const [fileName, prefix] of INDEX_COUNT_MAP) {
    const filePath = path.join(memory, fileName)
    const base = Object.hasOwn(plan.replace, fileName) ? String(plan.replace[fileName]) : readText(filePath, true)
    let count = entriesIn(base).filter((entry) => entry.id.startsWith(`${prefix}-`)).length
    count -= (plan.removeEntries[fileName] ?? []).filter((id) => String(id).toUpperCase().startsWith(`${prefix}-`)).length
    const added = normalizedAdditions(base, [
      ...(plan.appendEntries[fileName] ?? []),
      ...(plan.insertBefore[fileName] ?? []).map((item) => item.text),
    ])
    for (const text of added) count += entriesIn(text).filter((entry) => entry.id.startsWith(`${prefix}-`)).length
    counts[prefix] = count
  }
  return counts
}

// Stamp the four live counts into _Index (onto the worker's replacement text
// when supplied, else the current file). Returns the fully corrected text.
function stampedIndexText(memory, plan, counts) {
  const indexPath = path.join(memory, '_Index.md')
  const base = Object.hasOwn(plan.replace, '_Index.md') ? String(plan.replace['_Index.md']) : readText(indexPath, true)
  if (!base) return null
  let text = base
  for (const [, prefix, pattern] of INDEX_COUNT_MAP) {
    text = text.replace(pattern, (whole, digits) => whole.replace(digits, String(counts[prefix])))
  }
  return text
}

// The single canonical write logic shared by `patch` (Codex) and `apply`
// (Claude/platform-neutral). It builds the per-file hunks with all D1-D4
// guarantees applied. Both consumers use these exact hunks, so the two write
// paths produce identical results by construction — one engine, two front ends.
function buildFileHunks(manifest, plan) {
  const memory = path.resolve(manifest.memory)
  assertUnchangedSinceManifest(manifest)
  validatePlanFileKeys(memory, plan)
  validateDnoAuthority(plan)
  const fileHunks = new Map()

  function addHunk(relativePath, hunk) {
    if (!fileHunks.has(relativePath)) fileHunks.set(relativePath, [])
    fileHunks.get(relativePath).push(hunk)
  }

  for (const [relativePath, replacement] of Object.entries(plan.replace)) {
    // _Index.md is owned by the count-stamp step below, whether or not the
    // worker supplied a replacement, so it is never processed here.
    if (relativePath === '_Index.md') continue
    const filePath = assertMemoryPath(memory, relativePath)
    addHunk(relativePath, fullReplaceHunk(readText(filePath), String(replacement)))
  }

  for (const [relativePath, replacements] of Object.entries(plan.replaceEntries)) {
    if (Object.hasOwn(plan.replace, relativePath)) throw new Error(`Cannot replace file and entries together: ${relativePath}`)
    const current = readText(assertMemoryPath(memory, relativePath))
    for (const item of replacements) addHunk(relativePath, entryReplacementHunk(current, String(item.id), String(item.text)))
  }

  for (const [relativePath, ids] of Object.entries(plan.removeEntries)) {
    if (Object.hasOwn(plan.replace, relativePath)) throw new Error(`Cannot replace file and remove entries together: ${relativePath}`)
    const current = readText(assertMemoryPath(memory, relativePath))
    for (const id of ids) addHunk(relativePath, entryReplacementHunk(current, String(id), null))
  }

  for (const [relativePath, insertions] of Object.entries(plan.insertBefore)) {
    if (Object.hasOwn(plan.replace, relativePath)) throw new Error(`Cannot replace file and insert together: ${relativePath}`)
    const current = readText(assertMemoryPath(memory, relativePath))
    const level = canonicalEntryLevel(current)
    for (const item of insertions) {
      addHunk(relativePath, insertBeforeHunk(current, String(item.heading), normalizeEntryHeading(String(item.text), level)))
    }
  }

  for (const [relativePath, entries] of Object.entries(plan.appendEntries)) {
    if (Object.hasOwn(plan.replace, relativePath)) throw new Error(`Cannot replace file and append entries together: ${relativePath}`)
    const current = readText(assertMemoryPath(memory, relativePath))
    const normalized = normalizedAdditions(current, entries).join('\n\n')
    addHunk(relativePath, appendHunk(current, normalized))
  }

  for (const [relativePath, text] of Object.entries(plan.appendText)) {
    if (Object.hasOwn(plan.replace, relativePath)) throw new Error(`Cannot replace file and append text together: ${relativePath}`)
    const current = readText(assertMemoryPath(memory, relativePath))
    // Pins-Reference.md is section-anchored; every other appendText target is a
    // plain end-of-file append.
    addHunk(relativePath, relativePath === 'Pins-Reference.md'
      ? pinReviewAppendHunk(current, String(text))
      : appendHunk(current, String(text)))
  }

  // D4: guarantee a Pin Review Log line every save. If the worker supplied no
  // Pins-Reference append, the collector adds an honest auto-filled line
  // (drift=unverified — it never fabricates a drift pass), so an omitted line
  // can never leave the save half-written or block validation.
  {
    const prfName = 'Pins-Reference.md'
    const prfPath = path.join(memory, prfName)
    if (!Object.hasOwn(plan.appendText, prfName) && !Object.hasOwn(plan.replace, prfName) && fs.existsSync(prfPath)) {
      const branch = manifest.git?.branch || 'unknown'
      const mode = manifest.fidelity ?? 'incremental'
      const touchedPins = ['Pins.md', prfName].some((file) => Object.hasOwn(plan.replace, file)
        || Object.hasOwn(plan.appendEntries, file) || Object.hasOwn(plan.insertBefore, file)
        || Object.hasOwn(plan.replaceEntries, file) || Object.hasOwn(plan.removeEntries, file))
      const result = touchedPins ? 'PINS_UPDATED' : 'NO_PIN_CHANGES'
      const line = `- ${nzDate()} | branch=${branch} | mode=${mode} | result=${result} | drift=unverified | hot_changes=none | notes=Pin Review Log line auto-added by collector (worker omitted it).`
      const current = readText(prfPath)
      if (!current.includes(`- ${nzDate()} | branch=${branch} |`)) addHunk(prfName, pinReviewAppendHunk(current, line))
    }
  }

  // D1: the collector always owns the four _Index live counts. Stamp the true
  // post-apply counts onto the worker's _Index replacement when supplied, else
  // onto the current file. The worker can never make _Index counts drift.
  {
    const counts = trueEntryCounts(memory, plan)
    const target = stampedIndexText(memory, plan, counts)
    if (target != null) {
      const currentIndex = readText(path.join(memory, '_Index.md'), true)
      if (target !== currentIndex) addHunk('_Index.md', fullReplaceHunk(currentIndex, target))
    }
  }

  if (plan.daily) {
    const current = readText(manifest.daily)
    const hunks = []
    // Session BEFORE index line. Both hunks are built against the same text, and
    // on a note the collector just created `## Index` is also the last line — so
    // both anchor on it. Appending the session first leaves `## Index` in place
    // for the index hunk to insert under, putting the bullet above the session.
    // Reverse the order and the index line lands beneath the session body.
    // On an existing note the anchors differ and the order is immaterial.
    if (plan.daily.session) hunks.push(appendHunk(current, plan.daily.session))
    if (plan.daily.indexLine) hunks.push(dailyIndexHunk(current, plan.daily.indexLine))
    if (!hunks.length) throw new Error('Daily plan has no indexLine or session')
    fileHunks.set('@daily', hunks)
  }

  // A declaration is only meaningful for a file this plan actually writes.
  // Containment alone was not enough: "HANDOFFF.md" resolves inside the memory
  // home, so it passed while declaring nothing, leaving the worker believing the
  // check had been stood down for the file it meant. Membership catches that
  // typo, and also the stale key left behind when a plan stops writing the file
  // it used to restore.
  for (const key of plan.allowUnchanged) {
    if (key !== '@daily') assertMemoryPath(memory, key)
    if (!fileHunks.has(key)) {
      throw new Error(`allowUnchanged names ${key}, which this plan does not write. Declare only keys the plan writes.`)
    }
  }

  return { memory, fileHunks }
}

// `@daily` sorts last so the list reads memory-files-then-daily, as before.
function orderedChangedList(keys) {
  const files = keys.filter((key) => key !== '@daily')
  return [...files, ...(keys.includes('@daily') ? ['@daily'] : [])].join('|')
}

function emitPatchPacket() {
  const manifestPath = path.resolve(required('manifest'))
  const planPath = path.resolve(required('plan'))
  const manifest = JSON.parse(readText(manifestPath))
  const plan = normalizePlan(JSON.parse(readText(planPath)))
  const { memory, fileHunks } = buildFileHunks(manifest, plan)
  if (!fileHunks.size) throw new Error('Patch plan contains no writes')
  const beforeFiles = memorySnapshot(memory)
  const beforeDaily = fileSnapshot(manifest.daily)
  const patch = ['*** Begin Patch']
  for (const [key, hunks] of fileHunks) {
    const filePath = key === '@daily' ? manifest.daily : assertMemoryPath(memory, key)
    patch.push(`*** Update File: ${filePath}`)
    for (const hunk of hunks) patch.push(...hunk)
  }
  patch.push('*** End Patch')
  // Project, THEN check intent, THEN persist. Recording a projection for a plan
  // that is about to be refused would leave manifest.projectedFiles carrying a
  // state that never exists on disk, and assertUnchangedSinceManifest accepts
  // ANY recorded checkpoint — so a refused plan would permanently widen the
  // tamper guard.
  const projected = projectFileHunks(manifest, memory, fileHunks)
  const plannedChanged = changedAgainstOrientation(manifest, projected.files, projected.daily)
  assertIntendedWritesLanded(
    'patch',
    [...fileHunks.keys()],
    { ...beforeFiles, '@daily': beforeDaily },
    { ...projected.files, '@daily': projected.daily },
    plannedChanged,
    plan.allowUnchanged
  )
  // Record before deleting the plan: losing the plan to a failure here would
  // leave the caller with neither a patch nor the plan that produced it.
  recordProjectedSnapshot(manifest, manifestPath, projected)
  if (boolArg('cleanup-plan')) fs.rmSync(planPath, { force: true })
  // PLANNED_CHANGED is the projected end state versus orientation, not this
  // plan's keys. A corrective re-patch after a failed validate must include what
  // earlier applied patches already wrote, or validate rejects them as
  // "Unexpected changed file" — the apply path's Step 6 defect, on this path.
  process.stdout.write([
    '===== START_GENERATED_SAVE_PATCH =====',
    `PLANNED_CHANGED=${orderedChangedList(plannedChanged)}`,
    `DECLARED_UNCHANGED=${plan.allowUnchanged.join('|') || 'none'}`,
    patch.join('\n'),
    '===== END_GENERATED_SAVE_PATCH =====',
    '',
  ].join('\n'))
}

// Deterministic applier for the collector's OWN hunk vocabulary (fullReplace,
// append, insertBefore, entryReplacement/removal, dailyIndex). Every such hunk
// is a block of removed lines followed by a block of added lines, so applying it
// is: locate the removed block, splice in the added block. This lets `apply`
// write to disk directly while producing the exact result Codex's apply_patch
// would from the same hunks.
function indexOfBlock(lines, block, fromEnd) {
  if (!block.length) return -1
  const last = lines.length - block.length
  const range = fromEnd
    ? Array.from({ length: last + 1 }, (_, i) => last - i)
    : Array.from({ length: last + 1 }, (_, i) => i)
  for (const start of range) {
    let match = true
    for (let offset = 0; offset < block.length; offset += 1) {
      if (lines[start + offset] !== block[offset]) { match = false; break }
    }
    if (match) return start
  }
  return -1
}

function applyCollectorHunks(text, hunks) {
  let lines = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  for (const hunk of hunks) {
    const oldLines = []
    const newLines = []
    let fromEnd = false
    for (const line of hunk) {
      if (line === '@@') continue
      if (line === '*** End of File') { fromEnd = true; continue }
      if (line.startsWith('-')) oldLines.push(line.slice(1))
      else if (line.startsWith('+')) newLines.push(line.slice(1))
      else { oldLines.push(line.replace(/^ /, '')); newLines.push(line.replace(/^ /, '')) }
    }
    if (!oldLines.length) { lines = [...lines, ...newLines]; continue }
    const start = indexOfBlock(lines, oldLines, fromEnd)
    if (start < 0) throw new Error(`apply could not locate block starting: ${JSON.stringify(oldLines[0])}`)
    lines = [...lines.slice(0, start), ...newLines, ...lines.slice(start + oldLines.length)]
  }
  return lines.join('\n')
}

// Platform-neutral write path (used by Claude). Builds the same hunks as `patch`
// and applies them to disk, then reports the changed set so the caller can run
// `validate` with the exact --changed list. Codex keeps using `patch`.
function emitApplyPacket() {
  const manifestPath = path.resolve(required('manifest'))
  const planPath = path.resolve(required('plan'))
  const manifest = JSON.parse(readText(manifestPath))
  const plan = normalizePlan(JSON.parse(readText(planPath)))
  const { memory, fileHunks } = buildFileHunks(manifest, plan)
  if (!fileHunks.size) throw new Error('Patch plan contains no writes')
  const beforeFiles = memorySnapshot(memory)
  const beforeDaily = fileSnapshot(manifest.daily)
  // Look before leaping. The projection is exactly what the write loop below
  // produces, so checking intent HERE refuses a no-op plan with the memory home
  // untouched and the manifest unmoved — the worker can fix the plan and re-run
  // against the same state. Checking after the writes instead would leave a
  // half-applied save, withhold the APPLIED_CHANGED that Step 6 recovery needs,
  // and make the error's own advice unfollowable: re-running with the key
  // declared would then hit "Full replacement is identical to current content",
  // because the write it was meant to authorise had already landed.
  const projected = projectFileHunks(manifest, memory, fileHunks)
  assertIntendedWritesLanded(
    'apply',
    [...fileHunks.keys()],
    { ...beforeFiles, '@daily': beforeDaily },
    { ...projected.files, '@daily': projected.daily },
    changedAgainstOrientation(manifest, projected.files, projected.daily),
    plan.allowUnchanged
  )
  for (const [key, hunks] of fileHunks) {
    const filePath = key === '@daily' ? manifest.daily : assertMemoryPath(memory, key)
    const updated = applyCollectorHunks(readText(filePath, true), hunks)
    fs.writeFileSync(filePath, updated.endsWith('\n') ? updated : `${updated}\n`, 'utf8')
  }
  if (boolArg('cleanup-plan')) fs.rmSync(planPath, { force: true })
  // Re-baseline before reporting success, so the corrective re-apply that Step 6
  // prescribes on a failed validate is measured against what this apply wrote.
  // APPLIED_CHANGED is derived from the post-write state versus orientation —
  // the same computation validate performs — so the two cannot disagree.
  const applied = recordAppliedSnapshot(manifest, manifestPath)
  process.stdout.write([
    '===== START_SAVE_APPLY_RESULT =====',
    `APPLIED_CHANGED=${orderedChangedList(changedAgainstOrientation(manifest, applied.files, applied.daily))}`,
    `DECLARED_UNCHANGED=${plan.allowUnchanged.join('|') || 'none'}`,
    'APPLY_STATUS=WRITTEN',
    '===== END_SAVE_APPLY_RESULT =====',
    '',
  ].join('\n'))
}

function headingIdsByFile(memory) {
  const seen = new Map()
  const duplicates = []
  for (const filePath of markdownFiles(memory)) {
    const relative = normalizedRelative(memory, filePath)
    for (const entry of entriesIn(readText(filePath))) {
      if (seen.has(entry.id)) duplicates.push(`${entry.id}:${seen.get(entry.id)}:${relative}`)
      else seen.set(entry.id, relative)
    }
  }
  return duplicates
}

function countEntries(filePath, prefix) {
  return entriesIn(readText(filePath)).filter((entry) => entry.id.startsWith(`${prefix}-`)).length
}

// D3: an entry that cites an ID (DNO/PIN/ADR/PAT/TS-###) which exists nowhere in
// memory (live or Archive) is a dangling reference — the signal that an intended
// entry was never written (the ADR-109 class). Also fires when an entry is
// swallowed under a wrong-level heading, since its body is then attributed to the
// parent and its own ID reads as missing.
function danglingReferences(memory) {
  const files = markdownFiles(memory)
  const existing = new Set()
  for (const filePath of files) for (const entry of entriesIn(readText(filePath))) existing.add(entry.id)
  const dangling = new Set()
  for (const filePath of files) {
    for (const entry of entriesIn(readText(filePath))) {
      for (const ref of new Set(entry.body.match(/\b(?:DNO|PIN|ADR|PAT|TS)-\d+\b/g) ?? [])) {
        if (ref !== entry.id && !existing.has(ref)) dangling.add(`${ref} cited by ${entry.id}`)
      }
    }
  }
  return [...dangling]
}

function validateIndexCounts(memory, errors) {
  const index = readText(path.join(memory, '_Index.md'))
  const checks = [
    ['Pins-Reference.md', 'PIN', /~(\d+)\s+active PINs/i],
    ['Decisions.md', 'ADR', /the\s+(\d+)\s+live ADRs/i],
    ['Patterns.md', 'PAT', /the\s+(\d+)\s+live reusable patterns/i],
    ['Troubleshooting.md', 'TS', /the\s+(\d+)\s+live issue\/fix records/i],
  ]
  const counts = {}
  for (const [fileName, prefix, pattern] of checks) {
    const actual = countEntries(path.join(memory, fileName), prefix)
    counts[prefix] = actual
    const match = index.match(pattern)
    if (!match) errors.push(`_Index count text missing for ${prefix}`)
    else if (Number(match[1]) !== actual) errors.push(`_Index ${prefix} count ${match[1]} != actual ${actual}`)
  }
  counts.DNO = countEntries(path.join(memory, 'Pins.md'), 'DNO')
  counts.HOT_PIN = countEntries(path.join(memory, 'Pins.md'), 'PIN')
  return counts
}

function validateHandoff(memory, errors) {
  const filePath = path.join(memory, 'HANDOFF.md')
  const text = readText(filePath)
  if (!hasFrontmatter(text)) errors.push('HANDOFF frontmatter missing')
  for (const heading of ['Current Task', 'Next Priority', 'Workflow State', 'Commit Checkpoint', 'Progress', 'Blockers and Residual Risk', 'Next Actions']) {
    if (!new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(text)) errors.push(`HANDOFF heading missing: ${heading}`)
  }
}

// The manifest records the fidelity REQUESTED at orientation, but the skill tells
// the worker to escalate `incremental` to `max` mid-save (ambiguous duplicate
// detection, existing drift=warn, a save following a release) and to stamp the
// resolved mode into the review line. So the stamped mode legitimately differs
// from the manifest, and demanding a literal match failed every escalated save.
//
// Escalation is one-directional, so the rule is "at least as thorough as
// requested": a max request is never satisfied by an incremental line, but an
// incremental request accepts either. Requiring equality in both directions is
// what TS-115 was, inverted.
function fidelityRank(mode) {
  return ['incremental', 'max'].indexOf(mode)
}

function validatePinReview(memory, branch, fidelity, errors) {
  const latest = latestPinReview(memory)
  if (!latest) {
    errors.push('Pin Review Log has no dated entry')
    return ''
  }
  for (const requiredText of [nzDate(), `branch=${branch}`, 'result=', 'drift=', 'hot_changes=']) {
    if (!latest.includes(requiredText)) errors.push(`Latest Pin Review Log missing ${requiredText}`)
  }
  // Anchored on the field separator, not a bare `\bmode=`: a branch name may
  // legally contain `mode=`, and `branch=` precedes `mode=` on the line.
  const stamped = /\|\s*mode=([a-z]+)/.exec(latest)?.[1] ?? null
  if (stamped === null) {
    errors.push('Latest Pin Review Log missing mode=')
  } else if (fidelityRank(stamped) < 0) {
    errors.push(`Latest Pin Review Log has unknown mode=${stamped}`)
  } else if (fidelityRank(stamped) < fidelityRank(fidelity)) {
    errors.push(`Latest Pin Review Log records mode=${stamped} for a ${fidelity} save`)
  }
  return latest
}

function validateDaily(filePath, expectedChanged, errors) {
  if (!expectedChanged.has('@daily')) return { sessions: 0 }
  const text = readText(filePath)
  if (!hasFrontmatter(text)) errors.push('Daily note frontmatter missing')
  if (!/^project:\s*personal\s*$/m.test(text)) errors.push('Daily note project must be personal')
  if (!/^type:\s*log\s*$/m.test(text)) errors.push('Daily note type must be log')
  const numbers = [...text.matchAll(/^## Session (\d+)\b/gm)].map((match) => Number(match[1]))
  if (!numbers.length) errors.push('Daily note has no Session heading')
  if (new Set(numbers).size !== numbers.length) errors.push('Daily note has duplicate Session numbers')
  for (let index = 1; index < numbers.length; index += 1) {
    if (numbers[index] <= numbers[index - 1]) errors.push('Daily note Session headings are not ascending')
  }
  return { sessions: numbers.length, lastSession: numbers.at(-1) ?? null }
}

async function validateSave() {
  const manifestPath = path.resolve(required('manifest'))
  const manifest = JSON.parse(readText(manifestPath))
  const memory = path.resolve(required('memory'))
  const workspace = path.resolve(required('workspace'))
  if (memory !== path.resolve(manifest.memory)) throw new Error('Manifest memory path mismatch')
  if (workspace !== path.resolve(manifest.workspace)) throw new Error('Manifest workspace path mismatch')
  const repo = findRepo(workspace)
  const expectedChanged = new Set(listArg('changed').map((value) => value.split(path.sep).join('/')))
  if (!expectedChanged.size) throw new Error('Validation requires --changed')
  // The manifest is authoritative so apply and validate can never disagree.
  // `--fidelity` remains accepted for older manifests, but a manifest that
  // carries one wins outright. Run BOTH through resolveFidelity: an unranked
  // value would make every `>=` comparison below vacuously true and silently
  // disable the check, so a hand-edited manifest must fail loudly instead.
  const fidelity = resolveFidelity(manifest.fidelity ?? args.fidelity)
  const errors = []
  // Same helper the writers report from, so the two sides cannot drift apart.
  const actualChanged = changedAgainstOrientation(
    manifest,
    memorySnapshot(memory),
    fileSnapshot(manifest.daily)
  )
  for (const key of actualChanged) {
    if (!expectedChanged.has(key)) errors.push(`Unexpected changed file: ${key}`)
  }
  for (const key of expectedChanged) {
    if (!actualChanged.includes(key)) errors.push(`Expected file did not change: ${key}`)
  }

  // The manifest recorded the workspace root when there is no repository, so the
  // frozen-bank check still anchors correctly either way.
  const root = repoRoot(repo, manifest.repo ?? workspace)
  const frozenNow = {
    handoff: fileSnapshot(path.join(root, '.claude', 'HANDOFF.md')),
    pins: fileSnapshot(path.join(root, '.claude', 'context-pins.md')),
  }
  for (const key of ['handoff', 'pins']) {
    const before = manifest.frozen[key]
    const after = frozenNow[key]
    if (before.exists !== after.exists || before.sha256 !== after.sha256) errors.push(`Frozen repo .claude ${key} changed`)
  }

  // With no repository these all read empty, matching what orientation recorded,
  // so the did-the-repo-move-under-us checks pass trivially rather than fail.
  const branch = repo ? git(repo, ['branch', '--show-current']) : ''
  const head = repo ? git(repo, ['rev-parse', 'HEAD'], true) : ''
  const origin = repo && branch ? git(repo, ['rev-parse', `origin/${branch}`], true) || 'ABSENT' : 'ABSENT'
  const status = repo ? git(repo, ['status', '--porcelain']) : ''
  if (branch !== manifest.git.branch) errors.push(`Repo branch changed: ${manifest.git.branch} -> ${branch}`)
  if (head !== manifest.git.head) errors.push(`Repo HEAD changed: ${manifest.git.head} -> ${head}`)
  if (origin !== manifest.git.origin) errors.push(`Repo origin changed: ${manifest.git.origin} -> ${origin}`)
  if (status !== manifest.git.status) errors.push('Repo working-tree state changed during save')

  for (const key of actualChanged.filter((value) => value !== '@daily')) {
    const filePath = path.join(memory, key.split('/').join(path.sep))
    if (fs.existsSync(filePath) && !hasFrontmatter(readText(filePath))) errors.push(`Frontmatter missing: ${key}`)
  }
  const duplicates = headingIdsByFile(memory)
  if (duplicates.length) errors.push(...duplicates.map((value) => `Duplicate heading ID: ${value}`))
  const dangling = danglingReferences(memory)
  if (dangling.length) errors.push(...dangling.map((value) => `Dangling reference: ${value}`))
  validateHandoff(memory, errors)
  const counts = validateIndexCounts(memory, errors)
  const review = validatePinReview(memory, branch, fidelity, errors)
  const daily = validateDaily(manifest.daily, expectedChanged, errors)
  const server = await devServerState(root)

  if (errors.length) {
    process.stdout.write([
      '===== START_SAVE_VALIDATION_PACKET =====',
      'SAVE_VALIDATION=FAIL',
      `MANIFEST=${manifestPath}`,
      `ACTUAL_CHANGED=${actualChanged.join('|') || 'none'}`,
      ...errors.map((error) => `ERROR=${error}`),
      '===== END_SAVE_VALIDATION_PACKET =====',
      '',
    ].join('\n'))
    process.exit(2)
  }

  if (!boolArg('keep-manifest')) fs.rmSync(manifestPath, { force: true })
  process.stdout.write([
    '===== START_SAVE_VALIDATION_PACKET =====',
    'SAVE_VALIDATION=PASS',
    `ACTUAL_CHANGED=${actualChanged.join('|')}`,
    `COUNTS=DNO:${counts.DNO},HOT_PIN:${counts.HOT_PIN},REF_PIN:${counts.PIN},ADR:${counts.ADR},PAT:${counts.PAT},TS:${counts.TS}`,
    `DAILY_SESSIONS=${daily.sessions}`,
    `DAILY_LAST_SESSION=${daily.lastSession ?? 'none'}`,
    `LATEST_PIN_REVIEW_SHA256=${sha256(review)}`,
    `BRANCH=${branch}`,
    `HEAD=${head}`,
    `ORIGIN_BRANCH=${origin}`,
    `TREE=${status ? 'DIRTY_UNCHANGED' : 'CLEAN'}`,
    server,
    'FROZEN_BANK=UNCHANGED',
    '===== END_SAVE_VALIDATION_PACKET =====',
    '',
  ].join('\n'))
}

// Exported for unit tests. The CLI dispatch above is guarded by a main-module
// check, so importing this file has no side effects.
export {
  entriesIn,
  countEntries,
  canonicalEntryLevel,
  normalizeEntryHeading,
  normalizedAdditions,
  trueEntryCounts,
  danglingReferences,
  INDEX_COUNT_MAP,
}
