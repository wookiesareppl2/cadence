import { app, safeStorage, shell } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  GITHUB_OAUTH_SCOPE,
  type GitHubAuthStatus,
  type GitHubAuthStorage,
  type GitHubDeviceFlowPollResult,
  type GitHubDeviceFlowStartResult,
  type GitHubRepositoryListResult,
  type GitHubRepositorySummary
} from '@shared/github-import'

type GitHubUser = {
  login: string
  name: string | null
}

type StoredGitHubAuth = {
  version: 1
  clientId: string
  encryptedToken: string
  user: GitHubUser
  scopes: string[]
  savedAtMs: number
}

type PendingDeviceFlow = {
  clientId: string
  deviceCode: string
  expiresAtMs: number
  intervalMs: number
}

type GitHubDeviceCodeResponse = {
  device_code?: string
  user_code?: string
  verification_uri?: string
  expires_in?: number
  interval?: number
  error?: string
  error_description?: string
}

type GitHubAccessTokenResponse = {
  access_token?: string
  token_type?: string
  scope?: string
  error?: string
  error_description?: string
  interval?: number
}

const GITHUB_API_VERSION = '2022-11-28'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEVICE_VERIFICATION_URL = 'https://github.com/login/device'
const AUTH_STORE_VERSION = 1

let memoryToken: string | null = null
let memoryUser: GitHubUser | null = null
let memoryScopes: string[] = []
let pendingDeviceFlow: PendingDeviceFlow | null = null

function authStorePath(): string {
  return join(app.getPath('userData'), 'github-auth.json')
}

function configuredClientId(input?: string | null): string | null {
  const explicit = input?.trim()
  if (explicit) return explicit
  const env = process.env.CADENCE_GITHUB_CLIENT_ID?.trim() || process.env.GITHUB_CLIENT_ID?.trim()
  return env || null
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

async function readStore(): Promise<StoredGitHubAuth | null> {
  try {
    const parsed = JSON.parse(await readFile(authStorePath(), 'utf-8')) as Partial<StoredGitHubAuth>
    if (
      parsed.version === AUTH_STORE_VERSION &&
      typeof parsed.clientId === 'string' &&
      typeof parsed.encryptedToken === 'string' &&
      parsed.user &&
      typeof parsed.user.login === 'string' &&
      Array.isArray(parsed.scopes)
    ) {
      return parsed as StoredGitHubAuth
    }
  } catch {
    // Missing or unreadable auth state means signed out.
  }
  return null
}

async function writeStore(store: StoredGitHubAuth): Promise<void> {
  const path = authStorePath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(store, null, 2), 'utf-8')
}

async function readEncryptedToken(): Promise<{
  token: string | null
  store: StoredGitHubAuth | null
  error?: string
}> {
  const store = await readStore()
  if (!store) return { token: null, store: null }
  if (!encryptionAvailable()) return { token: null, store, error: 'OS credential encryption is unavailable.' }
  try {
    const token = safeStorage.decryptString(Buffer.from(store.encryptedToken, 'base64'))
    return { token, store }
  } catch {
    return { token: null, store, error: 'Stored GitHub token could not be decrypted.' }
  }
}

async function saveToken({
  token,
  clientId,
  user,
  scopes
}: {
  token: string
  clientId: string
  user: GitHubUser
  scopes: string[]
}): Promise<GitHubAuthStorage> {
  memoryToken = token
  memoryUser = user
  memoryScopes = scopes

  if (!encryptionAvailable()) return 'memory'

  const encryptedToken = safeStorage.encryptString(token).toString('base64')
  await writeStore({
    version: AUTH_STORE_VERSION,
    clientId,
    encryptedToken,
    user,
    scopes,
    savedAtMs: Date.now()
  })
  return 'encrypted'
}

export async function getGitHubToken(): Promise<string | null> {
  if (memoryToken) return memoryToken
  const { token, store } = await readEncryptedToken()
  if (token) {
    memoryToken = token
    memoryUser = store?.user ?? null
    memoryScopes = store?.scopes ?? []
  }
  return token
}

export async function getGitHubAuthStatus(): Promise<GitHubAuthStatus> {
  const safeStorageAvailable = encryptionAvailable()
  const { token, store, error } = await readEncryptedToken()
  const authenticated = Boolean(memoryToken || token)
  const user = memoryUser ?? store?.user ?? null
  const scopes = memoryScopes.length > 0 ? memoryScopes : store?.scopes ?? []
  const storage: GitHubAuthStorage = authenticated ? (safeStorageAvailable && token ? 'encrypted' : 'memory') : 'none'

  return {
    configured: Boolean(configuredClientId(store?.clientId)),
    authenticated,
    login: authenticated ? user?.login ?? null : null,
    name: authenticated ? user?.name ?? null : null,
    scopes: authenticated ? scopes : [],
    safeStorageAvailable,
    storage,
    error
  }
}

export async function signOutGitHub(): Promise<GitHubAuthStatus> {
  memoryToken = null
  memoryUser = null
  memoryScopes = []
  pendingDeviceFlow = null
  await rm(authStorePath(), { force: true }).catch(() => undefined)
  return getGitHubAuthStatus()
}

export async function startGitHubDeviceFlow(clientIdInput?: string | null): Promise<GitHubDeviceFlowStartResult> {
  const clientId = configuredClientId(clientIdInput)
  if (!clientId) return { ok: false, error: 'GitHub OAuth client ID is not configured.' }

  const body = new URLSearchParams({ client_id: clientId, scope: GITHUB_OAUTH_SCOPE })
  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })
  const payload = (await response.json()) as GitHubDeviceCodeResponse
  if (!response.ok || payload.error) {
    return { ok: false, error: payload.error_description ?? payload.error ?? 'Could not start GitHub sign-in.' }
  }
  if (!payload.device_code || !payload.user_code || !payload.verification_uri || !payload.expires_in) {
    return { ok: false, error: 'GitHub returned an incomplete device-flow response.' }
  }

  const intervalMs = Math.max(5, payload.interval ?? 5) * 1000
  const expiresAtMs = Date.now() + payload.expires_in * 1000
  pendingDeviceFlow = {
    clientId,
    deviceCode: payload.device_code,
    expiresAtMs,
    intervalMs
  }

  return {
    ok: true,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    expiresAtMs,
    intervalMs
  }
}

export async function openGitHubDevicePage(): Promise<{ ok: boolean; error?: string }> {
  try {
    await shell.openExternal(DEVICE_VERIFICATION_URL)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not open GitHub sign-in page.' }
  }
}

export async function pollGitHubDeviceFlow(): Promise<GitHubDeviceFlowPollResult> {
  if (!pendingDeviceFlow) return { status: 'error', error: 'No active GitHub sign-in.' }
  if (Date.now() >= pendingDeviceFlow.expiresAtMs) {
    pendingDeviceFlow = null
    return { status: 'expired', error: 'GitHub sign-in code expired.' }
  }

  const body = new URLSearchParams({
    client_id: pendingDeviceFlow.clientId,
    device_code: pendingDeviceFlow.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  })
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  })
  const payload = (await response.json()) as GitHubAccessTokenResponse

  if (payload.error === 'authorization_pending') {
    return { status: 'pending', intervalMs: pendingDeviceFlow.intervalMs }
  }
  if (payload.error === 'slow_down') {
    pendingDeviceFlow.intervalMs = Math.max(pendingDeviceFlow.intervalMs + 5000, (payload.interval ?? 0) * 1000)
    return { status: 'slow_down', intervalMs: pendingDeviceFlow.intervalMs }
  }
  if (payload.error === 'expired_token') {
    pendingDeviceFlow = null
    return { status: 'expired', error: 'GitHub sign-in code expired.' }
  }
  if (!response.ok || payload.error || !payload.access_token) {
    return { status: 'error', error: payload.error_description ?? payload.error ?? 'GitHub sign-in failed.' }
  }

  const token = payload.access_token
  const scopes = (payload.scope ?? GITHUB_OAUTH_SCOPE)
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
  const user = await fetchGitHubUser(token)
  await saveToken({ token, clientId: pendingDeviceFlow.clientId, user, scopes })
  pendingDeviceFlow = null
  return { status: 'authorized', auth: await getGitHubAuthStatus() }
}

async function fetchGitHubUser(token: string): Promise<GitHubUser> {
  const user = await githubApiJson<{ login?: unknown; name?: unknown }>('/user', token)
  if (typeof user.login !== 'string') throw new Error('GitHub user response did not include a login.')
  return { login: user.login, name: typeof user.name === 'string' ? user.name : null }
}

export async function listGitHubRepositories(page = 1): Promise<GitHubRepositoryListResult> {
  const token = await getGitHubToken()
  if (!token) return { ok: false, error: 'Sign in to GitHub first.' }

  const params = new URLSearchParams({
    affiliation: 'owner,collaborator,organization_member',
    sort: 'updated',
    per_page: '100',
    page: String(Math.max(1, page))
  })

  try {
    const repos = await githubApiJson<unknown[]>(`/user/repos?${params.toString()}`, token)
    return { ok: true, repos: repos.map(sanitizeRepository).filter((repo): repo is GitHubRepositorySummary => repo !== null) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not list GitHub repositories.' }
  }
}

export async function githubApiJson<T>(
  path: string,
  token?: string,
  init: RequestInit = {}
): Promise<T> {
  const accessToken = token ?? (await getGitHubToken())
  if (!accessToken) throw new Error('Sign in to GitHub first.')

  const response = await fetch(path.startsWith('https://') ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init.headers ?? {})
    }
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : null
  if (!response.ok) {
    const message =
      json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
        ? (json as { message: string }).message
        : `GitHub API request failed with ${response.status}.`
    throw new Error(message)
  }
  return json as T
}

function sanitizeRepository(value: unknown): GitHubRepositorySummary | null {
  if (!value || typeof value !== 'object') return null
  const repo = value as Record<string, unknown>
  const owner = repo.owner && typeof repo.owner === 'object' ? (repo.owner as Record<string, unknown>) : null
  if (
    typeof repo.id !== 'number' ||
    typeof repo.name !== 'string' ||
    typeof repo.full_name !== 'string' ||
    typeof repo.clone_url !== 'string' ||
    typeof repo.ssh_url !== 'string' ||
    typeof repo.default_branch !== 'string' ||
    !owner ||
    typeof owner.login !== 'string'
  ) {
    return null
  }

  return {
    id: repo.id,
    owner: owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private === true,
    fork: repo.fork === true,
    archived: repo.archived === true,
    defaultBranch: repo.default_branch,
    cloneUrl: repo.clone_url,
    sshUrl: repo.ssh_url,
    updatedAt: typeof repo.updated_at === 'string' ? repo.updated_at : null,
    pushedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : null
  }
}
