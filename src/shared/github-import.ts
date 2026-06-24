import type { PlatformId } from './platform'
import type { Workspace } from './workspaces'

export const GITHUB_CONTEXT_VAULT_REPO_NAME = 'cadence-context-vault'
export const GITHUB_OAUTH_SCOPE = 'repo'

export type GitHubAuthStorage = 'encrypted' | 'memory' | 'none'

export type GitHubAuthStatus = {
  configured: boolean
  authenticated: boolean
  login: string | null
  name: string | null
  scopes: string[]
  safeStorageAvailable: boolean
  storage: GitHubAuthStorage
  error?: string
}

export type GitHubDeviceFlowStartResult = {
  ok: boolean
  userCode?: string
  verificationUri?: string
  expiresAtMs?: number
  intervalMs?: number
  error?: string
}

export type GitHubDeviceFlowPollResult = {
  status: 'authorized' | 'pending' | 'slow_down' | 'expired' | 'error'
  intervalMs?: number
  auth?: GitHubAuthStatus
  error?: string
}

export type GitHubRepositorySummary = {
  id: number
  owner: string
  name: string
  fullName: string
  private: boolean
  fork: boolean
  archived: boolean
  defaultBranch: string
  cloneUrl: string
  sshUrl: string
  updatedAt: string | null
  pushedAt: string | null
}

export type GitHubRepositoryListResult = {
  ok: boolean
  repos?: GitHubRepositorySummary[]
  error?: string
}

export type GitHubRepositoryIdentity = {
  host: 'github.com'
  owner: string
  repo: string
  repoName: string
  key: string
}

export type GitHubContextRestoreRequest = {
  mode?: 'oauth' | 'git'
  vaultRepositoryUrl?: string | null
  passphrase: string
}

export type GitHubImportRequest = {
  platform: PlatformId
  repositoryUrl: string
  authMode?: 'oauth' | 'git'
  destinationParentPath: string
  targetDirectoryName?: string | null
  restoreContext?: GitHubContextRestoreRequest | null
}

export type GitHubContextSyncRequest = {
  platform: PlatformId
  projectId: string
  repositoryUrl?: string | null
  mode?: 'oauth' | 'git'
  vaultRepositoryUrl?: string | null
  passphrase: string
}

type GitHubContextFileTarget = 'project' | 'central-memory'

export type GitHubContextBundleFile = {
  target: GitHubContextFileTarget
  path: string
  text: string
  sizeBytes: number
  modifiedMs: number
}

export type GitHubContextBundle = {
  version: 1
  createdAt: string
  sourcePath: string
  repo: GitHubRepositoryIdentity
  files: GitHubContextBundleFile[]
  projectWorkspace: unknown
}

export type GitHubContextRestoreSummary = {
  attempted: boolean
  restored: boolean
  snapshot: string | null
  filesRestored: number
  workspaceRestored: boolean
  error?: string
}

export type GitHubImportResult = {
  ok: boolean
  workspace?: Workspace
  projectId?: string
  projectPath?: string
  repo?: GitHubRepositoryIdentity
  context?: GitHubContextRestoreSummary
  error?: string
}

export type GitHubContextSyncResult = {
  ok: boolean
  repo?: GitHubRepositoryIdentity
  snapshot?: string
  filesSynced?: number
  workspaceSynced?: boolean
  error?: string
}

const GITHUB_OWNER_REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/

function cleanRepoName(value: string): string {
  return value.replace(/\.git$/i, '')
}

function identityFromParts(owner: string, repo: string): GitHubRepositoryIdentity | null {
  const cleanOwner = owner.trim()
  const cleanRepo = cleanRepoName(repo.trim())
  if (!cleanOwner || !cleanRepo) return null
  if (!/^[A-Za-z0-9_.-]+$/.test(cleanOwner) || !/^[A-Za-z0-9_.-]+$/.test(cleanRepo)) return null

  const ownerKey = cleanOwner.toLowerCase()
  const repoKey = cleanRepo.toLowerCase()
  return {
    host: 'github.com',
    owner: cleanOwner,
    repo: cleanRepo,
    repoName: cleanRepo,
    key: `github.com__${ownerKey}__${repoKey}`
  }
}

export function parseGitHubRepository(input: string): GitHubRepositoryIdentity | null {
  const value = input.trim()
  if (!value) return null

  const ssh = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  if (ssh) return identityFromParts(ssh[1], ssh[2])

  const urlish = value.startsWith('github.com/') || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
  if (!urlish) {
    const shorthand = value.match(GITHUB_OWNER_REPO)
    if (shorthand) return identityFromParts(shorthand[1], shorthand[2])
  }

  try {
    const normalized = value.startsWith('github.com/') ? `https://${value}` : value
    const url = new URL(normalized)
    if (url.hostname.toLowerCase() !== 'github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return identityFromParts(parts[0], parts[1])
  } catch {
    return null
  }
}

export function defaultGitHubDirectoryName(repositoryUrl: string): string {
  return parseGitHubRepository(repositoryUrl)?.repoName ?? ''
}

export function normalizedGitHubCloneUrl(repositoryUrl: string): string | null {
  const repo = parseGitHubRepository(repositoryUrl)
  if (!repo) return null

  const value = repositoryUrl.trim()
  if (/^(git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(value)) return value
  return `https://github.com/${repo.owner}/${repo.repo}.git`
}
