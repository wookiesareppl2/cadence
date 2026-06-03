const { basename } = require('node:path')
const pty = require('@homebridge/node-pty-prebuilt-multiarch')

const VALID_PLATFORMS = new Set(['claude', 'codex'])
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

function createSession(platform, requestedCwd) {
  const cwd = requestedCwd || terminalCwd()
  const shell = shellCommand()
  const terminal = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env: process.env
  })

  const session = {
    platform,
    pty: terminal,
    cwd,
    shell: basename(shell.file),
    buffer: []
  }

  terminal.onData((data) => {
    rememberOutput(session, data)
    send({ type: 'data', platform, data })
  })

  terminal.onExit(({ exitCode, signal }) => {
    // A session that has already been replaced (e.g. by starting a new workspace
    // session) must not delete its successor or leak an exit notice into it.
    if (sessions.get(platform) !== session) return
    const suffix = signal ? ` signal=${signal}` : ''
    const data = `\r\n[terminal exited code=${exitCode}${suffix}]\r\n`
    rememberOutput(session, data)
    send({ type: 'data', platform, data })
    sessions.delete(platform)
  })

  sessions.set(platform, session)
  return session
}

function start(requestId, platform, requestedCwd) {
  if (!VALID_PLATFORMS.has(platform)) {
    send({ type: 'error', requestId, message: `Invalid terminal platform: ${platform}` })
    return
  }

  let session = sessions.get(platform)
  if (requestedCwd && (!session || session.cwd !== requestedCwd)) {
    // Explicit workspace request: start a fresh session rooted in that folder,
    // replacing any existing terminal for the platform.
    if (session) session.pty.kill()
    session = createSession(platform, requestedCwd)
  } else if (!session) {
    session = createSession(platform)
  }

  send({
    type: 'started',
    requestId,
    result: {
      platform,
      cwd: session.cwd,
      shell: session.shell,
      pid: session.pty.pid,
      replay: session.buffer.join('')
    }
  })
}

function restart(requestId, platform) {
  const existing = sessions.get(platform)
  const cwd = existing ? existing.cwd : undefined
  if (existing) {
    existing.pty.kill()
    sessions.delete(platform)
  }
  start(requestId, platform, cwd)
}

function write(platform, data) {
  if (typeof data !== 'string' || data.length > 20000) return
  sessions.get(platform)?.pty.write(data)
}

function resize(platform, cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return
  sessions.get(platform)?.pty.resize(cols, rows)
}

function closeAll() {
  for (const session of sessions.values()) {
    session.pty.kill()
  }
  sessions.clear()
}

process.on('message', (message) => {
  try {
    if (message.type === 'start') start(message.requestId, message.platform, message.cwd)
    if (message.type === 'restart') restart(message.requestId, message.platform)
    if (message.type === 'input') write(message.platform, message.data)
    if (message.type === 'resize') resize(message.platform, message.cols, message.rows)
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
