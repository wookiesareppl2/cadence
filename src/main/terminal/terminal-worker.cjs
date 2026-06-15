const { basename } = require('node:path')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

const BUFFER_LIMIT = 160000
const sessions = new Map()

function terminalCwd() {
  return process.env.AI_DASHBOARD_TERMINAL_CWD || process.cwd()
}

function shellCommand() {
  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] }
  }

  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

// Launch an interactive login shell inside a WSL distro at the project's POSIX
// path. The pty process itself (wsl.exe) runs from a valid Windows cwd, while
// `--cd` sets the Linux working directory so `claude`/`codex` start in-project.
function wslCommand(distro, posixCwd) {
  const args = ['-d', distro]
  if (posixCwd) args.push('--cd', posixCwd)
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
  const shell = wslDistro ? wslCommand(wslDistro, requestedCwd) : shellCommand()
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
    buffer: []
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
    existing.pty.kill()
    sessions.delete(terminalId)
  }
  start(requestId, terminalId, platform, cwd, wslDistro)
}

function write(terminalId, data) {
  if (typeof data !== 'string' || data.length > 20000) return
  sessions.get(terminalId)?.pty.write(data)
}

function resize(terminalId, cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
  sessions.get(terminalId)?.pty.resize(cols, rows)
}

function close(terminalId) {
  const session = sessions.get(terminalId)
  if (!session) return
  sessions.delete(terminalId)
  session.pty.kill()
}

function closeAll() {
  for (const session of sessions.values()) {
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
