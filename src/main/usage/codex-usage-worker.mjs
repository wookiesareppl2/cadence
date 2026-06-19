// Codex usage worker — runs in the user's system Node (OpenSSL TLS).
//
// Why a separate process: Electron bundles BoringSSL (Chrome's TLS stack), so a
// request made from the Electron main process carries a browser-like TLS
// fingerprint with a CLI User-Agent. The Codex/ChatGPT backend edge rejects that
// mismatch with 403. The same request from system Node (OpenSSL) is accepted
// (200). Spawning system Node mirrors how the terminal worker already runs.
//
// One-shot CLI: `node codex-usage-worker.mjs fetch|refresh`.
// Always prints exactly one JSON line to stdout; diagnostics go to stderr.
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const USAGE_ENDPOINT = 'https://chatgpt.com/backend-api/codex/usage'
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token'
const FALLBACK_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const USER_AGENT = 'codex_cli_rs/0.0.0 (cadence)'

function readAuth() {
  return JSON.parse(readFileSync(AUTH_PATH, 'utf-8'))
}

function decodeJwtClaims(jwt) {
  const part = typeof jwt === 'string' ? jwt.split('.')[1] : null
  if (!part) return {}
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  try {
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'))
  } catch {
    return {}
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj))
}

async function runFetch() {
  const auth = readAuth()
  const token = auth?.tokens?.access_token
  if (!token) {
    emit({ ok: false, status: 0, error: 'No Codex access token in ~/.codex/auth.json' })
    return
  }

  const res = await fetch(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${token}`,
      'chatgpt-account-id': auth?.tokens?.account_id ?? '',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    }
  })

  const body = await res.text()
  emit({
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    retryAfter: res.headers.get('retry-after'),
    // Full body when ok (so the parent can parse it); trimmed otherwise to keep
    // error payloads (e.g. Cloudflare HTML) small.
    body: res.ok ? body : body.slice(0, 600)
  })
}

async function runRefresh() {
  const auth = readAuth()
  const refreshToken = auth?.tokens?.refresh_token
  if (!refreshToken) {
    emit({ ok: false, error: 'No Codex refresh token in ~/.codex/auth.json' })
    return
  }

  const clientId = decodeJwtClaims(auth?.tokens?.access_token).client_id ?? FALLBACK_CLIENT_ID
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email'
    })
  })

  if (!res.ok) {
    emit({ ok: false, status: res.status, error: `Token refresh returned ${res.status}: ${(await res.text()).slice(0, 300)}` })
    return
  }

  const data = await res.json()
  const next = { ...auth, tokens: { ...auth.tokens } }
  if (typeof data.access_token === 'string') next.tokens.access_token = data.access_token
  if (typeof data.refresh_token === 'string') next.tokens.refresh_token = data.refresh_token
  if (typeof data.id_token === 'string') {
    next.tokens.id_token = data.id_token
    const accountId = decodeJwtClaims(data.id_token)?.['https://api.openai.com/auth']?.chatgpt_account_id
    if (typeof accountId === 'string') next.tokens.account_id = accountId
  }
  next.last_refresh = new Date().toISOString()

  // Atomic write so a crash can't truncate the user's Codex credentials.
  const tmp = `${AUTH_PATH}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
  renameSync(tmp, AUTH_PATH)
  emit({ ok: true })
}

const command = process.argv[2]
try {
  if (command === 'fetch') await runFetch()
  else if (command === 'refresh') await runRefresh()
  else emit({ ok: false, error: `Unknown command: ${command ?? '(none)'}` })
} catch (error) {
  emit({ ok: false, error: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
}
