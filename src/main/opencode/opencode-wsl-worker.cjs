const pty = require('@homebridge/node-pty-prebuilt-multiarch')

const MAX_OUTPUT = 8 * 1024 * 1024
const SHELL_READY = '__CADENCE_SHELL_READY__'
let server = null
let commandShell = null
let activeCommand = null
const commandQueue = []
let shuttingDown = false

function send(message) {
  if (process.connected && process.send) process.send(message, () => undefined)
}

function terminalCwd() {
  return process.env.AI_DASHBOARD_TERMINAL_CWD || process.cwd()
}

function appendOutput(current, data) {
  const next = current + data
  return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next
}

function spawnWsl(distro, args) {
  return pty.spawn('wsl.exe', ['-d', distro, ...args], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd: terminalCwd(),
    env: process.env
  })
}

function failActiveCommand(message) {
  const current = activeCommand
  if (!current) return
  activeCommand = null
  clearTimeout(current.timer)
  send({ type: 'error', requestId: current.requestId, message })
}

function handleCommandData(shell, data) {
  if (!shell.ready) {
    shell.bootOutput = appendOutput(shell.bootOutput, data)
    if (shell.bootOutput.includes(SHELL_READY)) {
      shell.ready = true
      shell.bootOutput = ''
      beginNextCommand()
    }
    return
  }

  const current = activeCommand
  if (!current || current.shell !== shell) return
  current.output = appendOutput(current.output, data)
  const startIndex = current.output.indexOf(current.startMarker)
  const doneIndex =
    startIndex >= 0
      ? current.output.indexOf(current.doneMarker, startIndex + current.startMarker.length)
      : -1
  if (doneIndex < 0) return

  const status = current.output
    .slice(doneIndex + current.doneMarker.length)
    .match(/^:(\d+)/)?.[1]
  if (status === undefined) return

  const output = current.output
    .slice(startIndex + current.startMarker.length, doneIndex)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '')
  activeCommand = null
  clearTimeout(current.timer)
  if (Number(status) === 0) {
    send({ type: 'commandResult', requestId: current.requestId, output })
  } else {
    send({
      type: 'error',
      requestId: current.requestId,
      message: output.trim() || `WSL command exited with code ${status}`
    })
  }
  beginNextCommand()
}

function startCommandShell(distro) {
  const child = spawnWsl(distro, ['--', 'bash', '--noprofile', '--norc', '-i'])
  const shell = { child, distro, ready: false, bootOutput: '' }
  commandShell = shell
  child.onData((data) => handleCommandData(shell, data))
  child.onExit(({ exitCode, signal }) => {
    if (commandShell === shell) commandShell = null
    if (activeCommand?.shell === shell) {
      failActiveCommand(`WSL command shell exited with code ${exitCode}${signal ? ` signal=${signal}` : ''}`)
    }
    if (!shuttingDown) beginNextCommand()
  })
  child.write(`stty -echo; printf '\n${SHELL_READY}\n'\r`)
}

function beginNextCommand() {
  if (shuttingDown || activeCommand || commandQueue.length === 0) return
  const next = commandQueue[0]
  if (commandShell && commandShell.distro !== next.distro) {
    const previous = commandShell
    commandShell = null
    previous.child.kill()
    return
  }
  if (!commandShell) {
    startCommandShell(next.distro)
    return
  }
  if (!commandShell.ready) return

  commandQueue.shift()
  const startMarker = `__CADENCE_START_${next.requestId}__`
  const doneMarker = `__CADENCE_DONE_${next.requestId}__`
  const current = {
    ...next,
    shell: commandShell,
    startMarker,
    doneMarker,
    output: '',
    timer: null
  }
  current.timer = setTimeout(() => {
    if (activeCommand !== current) return
    failActiveCommand(`WSL command timed out after ${next.timeoutMs}ms`)
    const shell = commandShell
    commandShell = null
    shell?.child.kill()
  }, next.timeoutMs)
  activeCommand = current
  commandShell.child.write(
    `printf '\n${startMarker}\n'; ${next.command}; __cadence_status=$?; ` +
      `printf '\n${doneMarker}:%s\n' "$__cadence_status"\r`
  )
}

function runCommand(requestId, distro, command, timeoutMs) {
  commandQueue.push({ requestId, distro, command, timeoutMs })
  beginNextCommand()
}

function startServer(requestId, distro, command) {
  if (server) {
    send({ type: 'error', requestId, message: 'OpenCode server is already running' })
    return
  }

  const child = spawnWsl(distro, ['--', 'bash', '-lc', command])
  const current = { child, output: '', stopping: false }
  server = current
  child.onData((data) => {
    current.output = appendOutput(current.output, data)
  })
  child.onExit(({ exitCode, signal }) => {
    if (server === current) server = null
    if (current.stopping) return
    send({
      type: 'serverExit',
      exitCode,
      signal,
      output: current.output.trim()
    })
  })
  send({ type: 'serverStarted', requestId, pid: child.pid })
}

function stopServer(requestId) {
  const current = server
  server = null
  if (current) {
    current.stopping = true
    current.child.kill()
  }
  send({ type: 'serverStopped', requestId })
}

function killSequentially(children) {
  const child = children.shift()
  if (!child) return
  let advanced = false
  const exitSubscription = child.onExit(() => {
    if (advanced) return
    advanced = true
    exitSubscription.dispose()
    killSequentially(children)
  })
  try {
    child.kill()
  } catch {
    exitSubscription.dispose()
    killSequentially(children)
  }
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  commandQueue.length = 0
  if (activeCommand) {
    clearTimeout(activeCommand.timer)
    activeCommand = null
  }
  const children = []
  if (commandShell) children.push(commandShell.child)
  if (server) {
    server.stopping = true
    children.push(server.child)
  }
  commandShell = null
  server = null
  killSequentially(children)
}

process.on('message', (message) => {
  try {
    if (message.type === 'runCommand') {
      runCommand(message.requestId, message.distro, message.command, message.timeoutMs)
    } else if (message.type === 'startServer') {
      startServer(message.requestId, message.distro, message.command)
    } else if (message.type === 'stopServer') {
      stopServer(message.requestId)
    }
  } catch (error) {
    send({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error)
    })
  }
})

process.on('disconnect', () => {
  shutdown()
})
