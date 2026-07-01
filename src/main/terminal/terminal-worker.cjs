const { basename } = require('node:path')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

const BUFFER_LIMIT = 160000

// Paced paste settings. Writing a whole paste to the pty at once drops characters
// (often the leading half) under Windows ConPTY, so any input longer than the
// threshold is split into small chunks written one per tick with a short gap,
// letting the CLI capture every piece — including the bracketed-paste start marker.
// Normal typing / key sequences stay under the threshold and write immediately.
const INPUT_PACE_THRESHOLD = 256
const INPUT_CHUNK_SIZE = 256
const INPUT_CHUNK_DELAY_MS = 6
const INPUT_MAX_TOTAL = 2000000

const sessions = new Map()

// Inline mirror of chunkTerminalInput() in src/shared/terminal.ts (this worker runs
// as a plain .cjs child process and cannot import that module). Keep them in sync.
function chunkInput(data, size) {
  if (data.length <= size) return [data]
  const chunks = []
  let start = 0
  while (start < data.length) {
    let end = Math.min(start + size, data.length)
    if (end < data.length) {
      const unit = data.charCodeAt(end - 1)
      if (unit >= 0xd800 && unit <= 0xdbff && end - 1 > start) end -= 1
    }
    chunks.push(data.slice(start, end))
    start = end
  }
  return chunks
}

// Drain one queued input piece per tick so a paced paste stays ordered and never
// floods ConPTY. Stops if the session was closed while pieces were still pending.
function pumpWrites(session) {
  if (session.writeDraining || session.closed) return
  const piece = session.writeQueue.shift()
  if (piece === undefined) return
  session.writeDraining = true
  try {
    session.pty.write(piece)
  } catch {
    session.writeDraining = false
    session.writeQueue.length = 0
    return
  }
  setTimeout(() => {
    session.writeDraining = false
    pumpWrites(session)
  }, INPUT_CHUNK_DELAY_MS)
}

function terminalCwd() {
  return process.env.AI_DASHBOARD_TERMINAL_CWD || process.cwd()
}

// Each terminal is scoped to one CLI (the tab it lives in). To stop the other CLI
// from being launched there by mistake, every shell starts with a guard that
// shadows the foreign command name and refuses to run it.
const FOREIGN_CLI = { claude: 'codex', codex: 'claude' }
const CLI_LABEL = { claude: 'Claude', codex: 'Codex' }

function guardTarget(platform) {
  const blocked = FOREIGN_CLI[platform]
  if (!blocked) return null
  return { blocked, blockedLabel: CLI_LABEL[blocked], thisLabel: CLI_LABEL[platform] }
}

// PowerShell guard: a global function shadowing the foreign CLI (functions take
// precedence over external commands). Passed as a base64 UTF-16LE -EncodedCommand
// so no quoting survives node-pty; -NoExit keeps the shell interactive afterwards.
function powershellGuard(platform) {
  const target = guardTarget(platform)
  if (!target) return null
  const script = `function global:${target.blocked} { Write-Host "Blocked: ${target.blockedLabel} cannot be run in the ${target.thisLabel} tab.\`nSwitch to the ${target.blockedLabel} tab." -ForegroundColor Red }`
  return Buffer.from(script, 'utf16le').toString('base64')
}

// Bash guard (WSL): define and export a function shadowing the foreign CLI, then
// exec an interactive login shell that inherits it. Login (-l) preserves the
// user's PATH/profile so claude/codex still resolve normally.
function bashGuard(platform) {
  const target = guardTarget(platform)
  if (!target) return null
  const line1 = `Blocked: ${target.blockedLabel} cannot be run in the ${target.thisLabel} tab.`
  const line2 = `Switch to the ${target.blockedLabel} tab.`
  return `${target.blocked}() { printf '%s\\n%s\\n' "${line1}" "${line2}"; return 1; }; export -f ${target.blocked}; exec bash -li`
}

function shellCommand(platform) {
  if (process.platform === 'win32') {
    const guard = powershellGuard(platform)
    const args = guard ? ['-NoLogo', '-NoExit', '-EncodedCommand', guard] : ['-NoLogo']
    return { file: 'powershell.exe', args }
  }

  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

// Launch an interactive login shell inside a WSL distro at the project's POSIX
// path. The pty process itself (wsl.exe) runs from a valid Windows cwd, while
// `--cd` sets the Linux working directory so `claude`/`codex` start in-project.
// The guard runs first, then execs the real interactive shell (see bashGuard).
function wslCommand(distro, posixCwd, platform) {
  const args = ['-d', distro]
  if (posixCwd) args.push('--cd', posixCwd)
  const guard = bashGuard(platform)
  if (guard) args.push('--', 'bash', '-c', guard)
  return { file: 'wsl.exe', args, label: `wsl:${distro}` }
}

function send(message) {
  if (process.send) process.send(message)
}

function rememberOutput(session, data) {
  session.buffer.push(data)

  let size = session.buffer.reduce((total, item) => total + item.length, 0)
  while (size > BUFFER_LIMIT && session.buffer.length > 1) {
    const removed = session.buffer.shift()
    size -= removed ? removed.length : 0
  }
}

function createSession(terminalId, platform, requestedCwd, wslDistro) {
  // For WSL, wsl.exe runs from a valid Windows cwd and `--cd` handles the Linux
  // dir; otherwise the native shell starts directly in the requested folder.
  const shell = wslDistro ? wslCommand(wslDistro, requestedCwd, platform) : shellCommand(platform)
  const spawnCwd = wslDistro ? terminalCwd() : requestedCwd || terminalCwd()
  const terminal = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: spawnCwd,
    env: process.env
  })

  const session = {
    terminalId,
    platform,
    pty: terminal,
    cwd: wslDistro ? requestedCwd || null : spawnCwd,
    wslDistro: wslDistro || null,
    shell: shell.label || basename(shell.file),
    buffer: [],
    // Paced-write state: pending input pieces, whether a piece is mid-flight, and
    // a closed flag so a queued drain stops once the pty is gone.
    writeQueue: [],
    writeDraining: false,
    closed: false
  }

  terminal.onData((data) => {
    rememberOutput(session, data)
    send({ type: 'data', terminalId, platform, data })
  })

  terminal.onExit(({ exitCode, signal }) => {
    // A session that has already been replaced/closed must not delete its
    // successor or leak an exit notice into it.
    if (sessions.get(terminalId) !== session) return
    const suffix = signal ? ` signal=${signal}` : ''
    const data = `\r\n[terminal exited code=${exitCode}${suffix}]\r\n`
    rememberOutput(session, data)
    send({ type: 'data', terminalId, platform, data })
    session.closed = true
    sessions.delete(terminalId)
  })

  sessions.set(terminalId, session)
  return session
}

function start(requestId, terminalId, platform, requestedCwd, wslDistro) {
  if (typeof terminalId !== 'string' || !terminalId) {
    send({ type: 'error', requestId, message: 'Missing terminal id' })
    return
  }

  // The terminal id is the identity. If a pty already exists for it (e.g. after
  // a renderer reload), reconnect and replay its scrollback rather than spawning
  // a duplicate. cwd only matters when creating the session for the first time.
  let session = sessions.get(terminalId)
  if (!session) {
    session = createSession(terminalId, platform, requestedCwd, wslDistro)
  }

  send({
    type: 'started',
    requestId,
    result: {
      terminalId,
      platform: session.platform,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pty.pid,
      replay: session.buffer.join('')
    }
  })
}

function restart(requestId, terminalId) {
  const existing = sessions.get(terminalId)
  const platform = existing ? existing.platform : undefined
  const cwd = existing ? existing.cwd : undefined
  const wslDistro = existing ? existing.wslDistro : undefined
  if (existing) {
    existing.closed = true
    existing.pty.kill()
    sessions.delete(terminalId)
  }
  start(requestId, terminalId, platform, cwd, wslDistro)
}

function write(terminalId, data) {
  if (typeof data !== 'string' || data.length === 0 || data.length > INPUT_MAX_TOTAL) return
  const session = sessions.get(terminalId)
  if (!session || session.closed) return

  // Fast path for normal typing: write immediately so input stays responsive. Only
  // taken when no paced paste is draining, so ordering with an in-flight paste holds.
  const pacing = session.writeDraining || session.writeQueue.length > 0
  if (data.length <= INPUT_PACE_THRESHOLD && !pacing) {
    session.pty.write(data)
    return
  }

  // Larger input (a paste) — or any input arriving while one drains — is queued in
  // small pieces and paced out so ConPTY delivers every character in order.
  for (const piece of chunkInput(data, INPUT_CHUNK_SIZE)) session.writeQueue.push(piece)
  pumpWrites(session)
}

function resize(terminalId, cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
  sessions.get(terminalId)?.pty.resize(cols, rows)
}

function close(terminalId) {
  const session = sessions.get(terminalId)
  if (!session) return
  session.closed = true
  sessions.delete(terminalId)
  session.pty.kill()
}

function closeAll() {
  for (const session of sessions.values()) {
    session.closed = true
    session.pty.kill()
  }
  sessions.clear()
}

process.on('message', (message) => {
  try {
    if (message.type === 'start')
      start(message.requestId, message.terminalId, message.platform, message.cwd, message.wslDistro)
    if (message.type === 'restart') restart(message.requestId, message.terminalId)
    if (message.type === 'input') write(message.terminalId, message.data)
    if (message.type === 'resize') resize(message.terminalId, message.cols, message.rows)
    if (message.type === 'close') close(message.terminalId)
    if (message.type === 'closeAll') closeAll()
  } catch (error) {
    send({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error)
    })
  }
})

process.on('disconnect', () => {
  closeAll()
  process.exit(0)
})
