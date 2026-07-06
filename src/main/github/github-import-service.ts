import { app, dialog, type BrowserWindow, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { PlatformId } from '@shared/platform'
import { centralSlug } from '@shared/memory'
import { toNativeRoot } from '@shared/project-files'
import {
  GITHUB_CONTEXT_VAULT_REPO_NAME,
  normalizedGitHubCloneUrl,
  parseGitHubRepository,
  type GitHubContextBundle,
  type GitHubContextBundleFile,
  type GitHubContextRestoreRequest,
  type GitHubContextRestoreSummary,
  type GitHubContextStatusRequest,
  type GitHubContextStatusResult,
  type GitHubContextSyncRequest,
  type GitHubContextSyncResult,
  type GitHubContextVaultActionResult,
  type GitHubContextVaultGithubRecoveryRequest,
  type GitHubContextVaultKeyStatus,
  type GitHubContextVaultSetupResult,
  type GitHubContextVaultUnlockRequest,
  type GitHubImportRequest,
  type GitHubImportResult,
  type GitHubRepositoryIdentity
} from '@shared/github-import'
import { computeVaultStatus, gitHubVaultKey } from '@shared/context-vault'
import { getGitHubAuthStatus, getGitHubToken, githubApiJson } from './github-auth-service'
import { fingerprintFiles, getVaultLink, recordVaultSync, resolveProjectVaultId } from '../context-vault/link-store'
import {
  decryptBundleWithDek,
  encryptBundleWithDek,
  type EncryptedSnapshotV2
} from '../context-vault/vault-crypto'
import {
  addGithubRecovery,
  createVaultKeyMaterial,
  hasGithubRecovery,
  parseKeyring,
  removeGithubRecovery,
  rotateRecoveryKey,
  serializeKeyring,
  unlockKeyringWithGithubAccount,
  unlockKeyringWithRecoveryKey,
  type VaultKeyring
} from '../context-vault/keyring'
import { adoptRecoveredDek, storeDeviceDek, unlockVaultDek } from '../context-vault/key-manager'
import { getDefaultClaudeProjectsRoot } from '../usage/claude-jsonl'
import { resolveProjectLocation, type ProjectLocation } from '../projects/project-locator'
import { getProjectWorkspace, saveProjectWorkspace } from '../projects/project-workspace-service'
import { attachWorkspacePath } from '../workspaces/workspace-service'
import { workspaceProjectId } from '../workspaces/workspace-utils'

type GitResult = { stdout: string; stderr: string }

// The single keyring file at the vault repo root: one DEK for the whole vault, recovered
// via Recovery Key (and, later, GitHub account). Read/write is mode-specific (GitHub API
// vs a local git clone), so callers hand the DEK resolver one of these IO adapters.
const VAULT_KEYRING_FILE = 'keyring.json'

type VaultKeyringIO = {
  read: () => Promise<VaultKeyring | null>
  write: (keyring: VaultKeyring) => Promise<void>
}

// A vault whose keyring exists but which this device cannot open (no stored DEK and no
// valid recovery key). Thrown so read paths can be mapped to a `locked` result rather
// than a generic failure.
class VaultLockedError extends Error {}

type VaultDekResolution =
  | { ok: true; dek: Buffer; newRecoveryKey?: string }
  | { ok: false; error: string }

/**
 * Obtain the vault's DEK for a sync/restore. Prefers this device's auto-unlock; falls
 * back to a supplied recovery key (adopting the DEK for future automatic unlock). With
 * no keyring yet, only mints one when the caller explicitly opts in via `createIfMissing`
 * — so a vault is never created with a Recovery Key the user is never shown.
 */
async function resolveVaultDek(
  io: VaultKeyringIO,
  opts: { recoveryKey?: string | null; createIfMissing?: boolean }
): Promise<VaultDekResolution> {
  const keyring = await io.read()
  if (keyring) {
    const deviceDek = await unlockVaultDek(keyring)
    if (deviceDek) return { ok: true, dek: deviceDek }

    const recoveryKey = opts.recoveryKey?.trim()
    if (recoveryKey) {
      try {
        const dek = unlockKeyringWithRecoveryKey(keyring, recoveryKey)
        await adoptRecoveredDek(keyring, dek)
        return { ok: true, dek }
      } catch {
        return { ok: false, error: 'That recovery key does not match this vault.' }
      }
    }
    return { ok: false, error: 'This vault is locked on this device. Enter your recovery key to unlock it.' }
  }

  if (opts.createIfMissing) {
    const material = createVaultKeyMaterial()
    await storeDeviceDek(material.dek)
    await io.write(material.keyring)
    return { ok: true, dek: material.dek, newRecoveryKey: material.recoveryKey }
  }
  return { ok: false, error: 'This project’s context vault has not been set up yet.' }
}

function apiVaultKeyringIO(vault: { owner: string; repo: string }): VaultKeyringIO {
  return {
    read: async () => {
      const text = await getGitHubFileText(vault, VAULT_KEYRING_FILE)
      return text ? parseKeyring(JSON.parse(text)) : null
    },
    write: async (keyring) => {
      await putGitHubFile(vault, VAULT_KEYRING_FILE, serializeKeyring(keyring), 'Update context vault keyring')
    }
  }
}

function gitVaultKeyringIO(vaultPath: string): VaultKeyringIO {
  const keyringPath = join(vaultPath, VAULT_KEYRING_FILE)
  return {
    read: async () => {
      try {
        return parseKeyring(JSON.parse(await readFile(keyringPath, 'utf-8')))
      } catch {
        return null
      }
    },
    write: async (keyring) => {
      await writeFile(keyringPath, serializeKeyring(keyring), 'utf-8')
    }
  }
}

type VaultManifest = {
  version: 1
  vaultKey: string
  latestSnapshot: string | null
  snapshots: Array<{
    file: string
    createdAt: string
    files: number
    workspace: boolean
  }>
}

type GitHubContentsFile = {
  type?: string
  content?: string
  encoding?: string
  sha?: string
}

type GitHubRepoApiResponse = {
  clone_url?: string
  ssh_url?: string
  html_url?: string
  private?: boolean
}

const CONTEXT_MAX_FILES = 240
const CONTEXT_MAX_FILE_BYTES = 512 * 1024
const CONTEXT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
const PROJECT_ROOT_CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'AGENTS.override.md']
const PROJECT_MARKDOWN_DIRS = ['.claude', '.codex']

export async function chooseGithubImportDirectory(window: BrowserWindow | null): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose Import Folder',
    buttonLabel: 'Use Folder',
    properties: ['openDirectory', 'createDirectory']
  }
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0] ?? null
}

export async function importGithubProject(request: GitHubImportRequest): Promise<GitHubImportResult> {
  const repo = parseGitHubRepository(request.repositoryUrl)
  if (!repo) return { ok: false, error: 'Enter a valid GitHub repository URL.' }
  const cloneUrl = normalizedGitHubCloneUrl(request.repositoryUrl)
  if (!cloneUrl) return { ok: false, error: 'Enter a valid GitHub repository URL.' }

  const destination = resolveCloneDestination(request, repo)
  if (!destination.ok) return { ok: false, repo, error: destination.error }

  const ready = await ensureCloneDestinationAvailable(destination.path)
  if (!ready.ok) return { ok: false, repo, error: ready.error }

  try {
    if (request.authMode === 'oauth') {
      const token = await getGitHubToken()
      if (!token) return { ok: false, repo, error: 'Sign in to GitHub first.' }
      await runGitWithToken(['clone', '--', cloneUrl, destination.path], token, undefined, 15 * 60_000)
    } else {
      await runGit(['clone', '--', cloneUrl, destination.path], undefined, 15 * 60_000)
    }
  } catch (error) {
    return { ok: false, repo, error: formatGitError(error, 'Could not clone the repository.') }
  }

  let context: GitHubContextRestoreSummary | undefined
  const workspace = await attachWorkspacePath(destination.path)
  const projectId = workspaceProjectId(request.platform, workspace.path)

  if (request.restoreContext) {
    context = await restoreProjectContext({
      restore: request.restoreContext,
      repo,
      projectPath: workspace.path,
      platform: request.platform,
      projectId
    })
  }

  return { ok: true, repo, workspace, projectId, projectPath: workspace.path, context }
}

function contextVaultLinksPath(): string {
  return join(app.getPath('userData'), 'context-vault-links.json')
}

export async function syncProjectContextToVault(
  request: GitHubContextSyncRequest,
  sender: WebContents
): Promise<GitHubContextSyncResult> {
  const location = await resolveProjectLocation(request.platform, request.projectId, sender)
  if (!location) return { ok: false, error: 'Project folder not found.' }

  // A GitHub remote gives a device-independent key automatically; projects without one
  // fall back to a locally-persisted `local__<uuid>` so any project can sync.
  const repoUrl = request.repositoryUrl?.trim() || (await inferGithubRemote(location))
  const repo = repoUrl ? parseGitHubRepository(repoUrl) : null
  const resolved = await resolveProjectVaultId(contextVaultLinksPath(), {
    projectId: request.projectId,
    projectName: basename(location.path),
    gitHubKey: repo ? gitHubVaultKey(repo.owner, repo.repo) : null
  })

  let bundle: GitHubContextBundle
  try {
    bundle = await buildContextBundle(resolved.id, repo, location, request.projectId)
  } catch (error) {
    return { ok: false, repo: repo ?? undefined, error: error instanceof Error ? error.message : 'Could not collect context files.' }
  }

  try {
    const mode = request.mode ?? (request.vaultRepositoryUrl?.trim() ? 'git' : 'oauth')
    const dekOpts = { recoveryKey: request.recoveryKey, createIfMissing: request.createIfMissing }
    let snapshot: string
    let newRecoveryKey: string | undefined
    if (mode === 'oauth') {
      const vault = await ensureApiVaultRepository()
      const dek = await resolveVaultDek(apiVaultKeyringIO(vault), dekOpts)
      if (!dek.ok) return { ok: false, repo: repo ?? undefined, locked: true, error: dek.error }
      snapshot = await writeVaultSnapshotViaGitHubApi(vault, resolved.id, bundle, dek.dek, repo)
      newRecoveryKey = dek.newRecoveryKey
    } else {
      if (!request.vaultRepositoryUrl?.trim())
        return { ok: false, repo: repo ?? undefined, error: 'Enter a context vault repository URL.' }
      const vaultPath = await ensureVaultRepository(request.vaultRepositoryUrl)
      const dek = await resolveVaultDek(gitVaultKeyringIO(vaultPath), dekOpts)
      if (!dek.ok) return { ok: false, repo: repo ?? undefined, locked: true, error: dek.error }
      snapshot = await writeVaultSnapshot(vaultPath, resolved.id, bundle, dek.dek)
      await commitAndPushVault(vaultPath, resolved.id)
      newRecoveryKey = dek.newRecoveryKey
    }
    // Remember what we just pushed so later status checks can detect divergence.
    await recordVaultSync(contextVaultLinksPath(), request.projectId, {
      snapshot,
      fingerprint: fingerprintFiles(bundle.files),
      at: bundle.createdAt
    })
    return {
      ok: true,
      repo: repo ?? undefined,
      snapshot,
      filesSynced: bundle.files.length,
      workspaceSynced: bundle.projectWorkspace != null,
      recoveryKey: newRecoveryKey
    }
  } catch (error) {
    return { ok: false, repo: repo ?? undefined, error: formatGitError(error, 'Could not sync the context vault.') }
  }
}

// Report a project's context-vault state for the status indicator and auto-restore.
// Read-only and side-effect-free: it never mints a vault link or creates the vault
// repo (a status check must not change anything).
export async function getProjectVaultStatus(
  request: GitHubContextStatusRequest,
  sender: WebContents
): Promise<GitHubContextStatusResult> {
  const location = await resolveProjectLocation(request.platform, request.projectId, sender)
  if (!location) return { ok: false, error: 'Project folder not found.' }

  const repoUrl = request.repositoryUrl?.trim() || (await inferGithubRemote(location))
  const repo = repoUrl ? parseGitHubRepository(repoUrl) : null
  const gitHubKey = repo ? gitHubVaultKey(repo.owner, repo.repo) : null
  const link = await getVaultLink(contextVaultLinksPath(), request.projectId)
  const vaultKey = gitHubKey ?? link?.vaultId ?? null
  if (!vaultKey) return { ok: true, state: 'not-connected', vaultKey: null }

  const auth = await getGitHubAuthStatus()
  if (!auth.authenticated || !auth.login) {
    return { ok: true, state: 'not-connected', vaultKey, lastSyncedAt: link?.lastSyncedAt ?? null }
  }

  try {
    // Read the vault manifest without creating the repo (missing → empty manifest).
    const vault = { owner: auth.login, repo: GITHUB_CONTEXT_VAULT_REPO_NAME }
    const manifest = await readVaultManifestViaGitHubApi(vault, vaultKey)
    const remoteLatest = manifest.latestSnapshot ?? manifest.snapshots[0]?.file ?? null

    const bundle = await buildContextBundle(vaultKey, repo, location, request.projectId)
    const state = computeVaultStatus({
      base: link?.baseSnapshot ?? null,
      baseFingerprint: link?.baseFingerprint ?? null,
      localFingerprint: fingerprintFiles(bundle.files),
      remoteLatest
    })
    return { ok: true, state, vaultKey, lastSyncedAt: link?.lastSyncedAt ?? null }
  } catch (error) {
    return { ok: false, vaultKey, error: error instanceof Error ? error.message : 'Could not read vault status.' }
  }
}

// ── Vault key management (Phase 4d) ──────────────────────────────────────────
// These act on the account-wide keyring in the built-in OAuth vault. Read-only status
// never creates the repo; setup does (that's the point). The git/manual vault stays
// managed through the sync flow, so these target the automatic OAuth vault only.

async function apiVaultHandleForRead(): Promise<{ owner: string; repo: string } | null> {
  const auth = await getGitHubAuthStatus()
  if (!auth.authenticated || !auth.login) return null
  return { owner: auth.login, repo: GITHUB_CONTEXT_VAULT_REPO_NAME }
}

// The account's immutable numeric id — the binding value for the GitHub-account recovery
// wrap. Uses the id (not the login) so a username change never breaks recovery.
async function getGitHubAccountId(): Promise<string> {
  const user = await githubApiJson<{ id?: unknown }>('/user')
  if (typeof user.id !== 'number') throw new Error('Could not read your GitHub account id.')
  return String(user.id)
}

/** Does the account-wide vault keyring exist, and can this device open it? Side-effect-free. */
export async function getVaultKeyStatus(): Promise<GitHubContextVaultKeyStatus> {
  const vault = await apiVaultHandleForRead()
  if (!vault) return { ok: true, exists: false, unlocked: false, githubRecovery: false }
  try {
    const keyring = await apiVaultKeyringIO(vault).read()
    if (!keyring) return { ok: true, exists: false, unlocked: false, githubRecovery: false }
    const dek = await unlockVaultDek(keyring)
    return { ok: true, exists: true, unlocked: Boolean(dek), githubRecovery: hasGithubRecovery(keyring) }
  } catch (error) {
    return {
      ok: false,
      exists: false,
      unlocked: false,
      githubRecovery: false,
      error: error instanceof Error ? error.message : 'Could not read vault keys.'
    }
  }
}

/**
 * First-time vault setup: mint the DEK + first Recovery Key and publish the keyring,
 * storing the DEK on this device. A standalone, reliable step (no snapshot required) so
 * the returned Recovery Key is always shown before anything can fail. If the keyring
 * already exists it is never clobbered.
 */
export async function setupProjectVault(): Promise<GitHubContextVaultSetupResult> {
  try {
    const vault = await ensureApiVaultRepository()
    const io = apiVaultKeyringIO(vault)
    const existing = await io.read()
    if (existing) {
      const dek = await unlockVaultDek(existing)
      return { ok: true, alreadySetUp: true, unlocked: Boolean(dek) }
    }
    const material = createVaultKeyMaterial()
    await storeDeviceDek(material.dek)
    // Default-on GitHub-account recovery so losing the Recovery Key isn't a lockout.
    // Best-effort: if the account id can't be fetched, publish Recovery-Key-only rather
    // than fail setup (the Recovery Key is always shown regardless, and the user can
    // enable GitHub recovery later from the manage view).
    let keyring = material.keyring
    try {
      keyring = addGithubRecovery(keyring, material.dek, await getGitHubAccountId())
    } catch {
      // Fall back to Recovery-Key-only.
    }
    await io.write(keyring)
    return {
      ok: true,
      alreadySetUp: false,
      unlocked: true,
      recoveryKey: material.recoveryKey,
      githubRecovery: hasGithubRecovery(keyring)
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not set up the context vault.' }
  }
}

/** Unlock the vault on this device with a Recovery Key, adopting the DEK for auto-unlock. */
export async function unlockProjectVault(
  request: GitHubContextVaultUnlockRequest
): Promise<GitHubContextVaultActionResult> {
  if (!request.recoveryKey?.trim()) return { ok: false, error: 'Enter your recovery key.' }
  try {
    const vault = await ensureApiVaultRepository()
    const dek = await resolveVaultDek(apiVaultKeyringIO(vault), { recoveryKey: request.recoveryKey })
    return dek.ok ? { ok: true } : { ok: false, error: dek.error }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not unlock the context vault.' }
  }
}

/**
 * Issue a fresh Recovery Key (invalidating the old one) from a device that can already
 * unlock the vault. Returns the new key to show once.
 */
export async function rotateProjectVaultRecoveryKey(): Promise<GitHubContextVaultSetupResult> {
  try {
    const vault = await ensureApiVaultRepository()
    const io = apiVaultKeyringIO(vault)
    const keyring = await io.read()
    if (!keyring) return { ok: false, error: 'This vault has not been set up yet.' }
    const dek = await unlockVaultDek(keyring)
    if (!dek) return { ok: false, error: 'Unlock this device with your recovery key before rotating it.' }
    const rotated = rotateRecoveryKey(keyring, dek)
    await io.write(rotated.keyring)
    return { ok: true, alreadySetUp: true, unlocked: true, recoveryKey: rotated.recoveryKey }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not rotate the recovery key.' }
  }
}

/**
 * Recover the vault on this device using GitHub-account access — no Recovery Key needed.
 * Available only when the vault carries a GitHub-account recovery wrap. Adopts the DEK for
 * automatic unlock afterwards.
 */
export async function recoverProjectVaultViaGitHub(): Promise<GitHubContextVaultActionResult> {
  try {
    const vault = await ensureApiVaultRepository()
    const keyring = await apiVaultKeyringIO(vault).read()
    if (!keyring) return { ok: false, error: 'This vault has not been set up yet.' }
    if (!hasGithubRecovery(keyring)) {
      return { ok: false, error: 'GitHub-account recovery is not enabled for this vault. Use your recovery key.' }
    }
    const dek = unlockKeyringWithGithubAccount(keyring, await getGitHubAccountId())
    await adoptRecoveredDek(keyring, dek)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not recover via GitHub.' }
  }
}

/**
 * Turn GitHub-account recovery on or off. Enabling adds a DEK copy recoverable by account
 * access (requires this device to be unlocked); disabling returns to Recovery-Key-only.
 */
export async function setVaultGithubRecovery(
  request: GitHubContextVaultGithubRecoveryRequest
): Promise<GitHubContextVaultActionResult> {
  try {
    const vault = await ensureApiVaultRepository()
    const io = apiVaultKeyringIO(vault)
    const keyring = await io.read()
    if (!keyring) return { ok: false, error: 'This vault has not been set up yet.' }
    if (request.enabled) {
      const dek = await unlockVaultDek(keyring)
      if (!dek) return { ok: false, error: 'Unlock this device before changing recovery options.' }
      await io.write(addGithubRecovery(keyring, dek, await getGitHubAccountId()))
    } else {
      await io.write(removeGithubRecovery(keyring))
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not update GitHub recovery.' }
  }
}

function resolveCloneDestination(
  request: GitHubImportRequest,
  repo: GitHubRepositoryIdentity
): { ok: true; path: string } | { ok: false; error: string } {
  if (!request.destinationParentPath.trim()) return { ok: false, error: 'Choose a destination folder.' }
  const parent = resolve(request.destinationParentPath.trim())
  const targetName = sanitizeDirectoryName(request.targetDirectoryName || repo.repoName)
  if (!targetName) return { ok: false, error: 'Enter a project folder name.' }

  const path = resolve(parent, targetName)
  if (!isInside(parent, path)) return { ok: false, error: 'The target folder must stay inside the destination.' }
  return { ok: true, path }
}

function sanitizeDirectoryName(input: string): string {
  return input
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
}

async function ensureCloneDestinationAvailable(path: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return { ok: false, error: 'The target path already exists and is not a folder.' }
    const entries = await readdir(path)
    if (entries.length > 0) return { ok: false, error: 'The target folder already exists and is not empty.' }
    return { ok: true }
  } catch {
    return { ok: true }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function runGit(args: string[], cwd?: string, timeoutMs = 5 * 60_000): Promise<GitResult> {
  return runGitWithEnv(args, cwd, timeoutMs)
}

function runGitWithToken(args: string[], token: string, cwd?: string, timeoutMs = 5 * 60_000): Promise<GitResult> {
  // GitHub's git-over-HTTPS transport wants HTTP Basic auth (the token as the password),
  // NOT `Authorization: Bearer` — Bearer authenticates the REST API (so repo listing works)
  // but the git endpoint rejects it as "invalid credentials", which then drags in the system
  // credential helper (Git Credential Manager). Mirror actions/checkout: Basic auth with the
  // token as the password under the `x-access-token` username, which every GitHub token type
  // accepts. The header travels via GIT_CONFIG env, not argv, so the token never hits argv/logs.
  const basicCredential = Buffer.from(`x-access-token:${token}`).toString('base64')
  // Disable any system credential helper for this call and forbid interactive prompts: the
  // token IS the credential, so a rejection should surface as a clean error instead of falling
  // through to Git Credential Manager's browser flow (which lands on a blank localhost page).
  return runGitWithEnv(['-c', 'credential.helper=', ...args], cwd, timeoutMs, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basicCredential}`
  })
}

function runGitWithEnv(
  args: string[],
  cwd?: string,
  timeoutMs = 5 * 60_000,
  env: NodeJS.ProcessEnv = {}
): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, ...env },
        maxBuffer: 10 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }
        resolvePromise({ stdout, stderr })
      }
    )
  })
}

function formatGitError(error: unknown, fallback: string): string {
  const detail =
    error && typeof error === 'object'
      ? ((error as { stderr?: unknown }).stderr as string | undefined) ||
        ((error as { stdout?: unknown }).stdout as string | undefined) ||
        ((error as { message?: unknown }).message as string | undefined)
      : null
  const text = typeof detail === 'string' ? detail.trim() : ''
  return text ? `${fallback} ${text}` : fallback
}

async function inferGithubRemote(location: ProjectLocation): Promise<string | null> {
  const root = toNativeRoot(location.path, location.distro)
  try {
    const result = await runGit(['-C', root, 'remote', 'get-url', 'origin'])
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

async function buildContextBundle(
  vaultKey: string,
  repo: GitHubRepositoryIdentity | null,
  location: ProjectLocation,
  projectId: string
): Promise<GitHubContextBundle> {
  const root = toNativeRoot(location.path, location.distro)
  const files: GitHubContextBundleFile[] = []
  let totalBytes = 0

  const addFile = async (target: GitHubContextBundleFile['target'], basePath: string, relPath: string): Promise<void> => {
    if (files.length >= CONTEXT_MAX_FILES || totalBytes >= CONTEXT_MAX_TOTAL_BYTES) return
    const safeRel = normalizeBundlePath(relPath)
    if (!safeRel) return
    const absolute = safeJoin(basePath, safeRel)
    if (!absolute) return

    try {
      const info = await stat(absolute)
      if (!info.isFile() || info.size > CONTEXT_MAX_FILE_BYTES) return
      const text = await readFile(absolute, 'utf-8')
      totalBytes += Buffer.byteLength(text, 'utf-8')
      if (totalBytes > CONTEXT_MAX_TOTAL_BYTES) return
      files.push({ target, path: safeRel, text, sizeBytes: info.size, modifiedMs: info.mtimeMs })
    } catch {
      // Missing or unreadable context files are simply skipped.
    }
  }

  for (const relPath of PROJECT_ROOT_CONTEXT_FILES) {
    await addFile('project', root, relPath)
  }
  for (const dir of PROJECT_MARKDOWN_DIRS) {
    for (const relPath of await listMarkdownFiles(root, dir, 4)) {
      await addFile('project', root, relPath)
    }
  }

  if (location.distro === null) {
    const centralMemory = join(getDefaultClaudeProjectsRoot(), centralSlug(location.path), 'memory')
    for (const relPath of await listMarkdownFiles(centralMemory, '.', 1)) {
      await addFile('central-memory', centralMemory, relPath)
    }
  }

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    sourcePath: location.path,
    vaultKey,
    repo,
    files,
    projectWorkspace: await getProjectWorkspace(projectId)
  }
}

async function listMarkdownFiles(root: string, startRel: string, maxDepth: number): Promise<string[]> {
  const startPath = startRel === '.' ? root : safeJoin(root, startRel)
  if (!startPath) return []
  const files: string[] = []

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= CONTEXT_MAX_FILES) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const relPath = normalizeBundlePath(relative(root, absolute))
      if (!relPath) continue
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(relPath)
      }
    }
  }

  await visit(startPath, 0)
  return files
}

function normalizeBundlePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return null
  if (/^[a-zA-Z]:/.test(parts[0] ?? '')) return null
  return parts.join('/')
}

function safeJoin(root: string, relPath: string): string | null {
  const safeRel = normalizeBundlePath(relPath)
  if (!safeRel) return null
  const target = resolve(root, ...safeRel.split('/'))
  return isInside(resolve(root), target) ? target : null
}

async function ensureVaultRepository(vaultRepositoryUrl: string): Promise<string> {
  const trimmed = vaultRepositoryUrl.trim()
  if (!trimmed) throw new Error('Context vault repository URL is required.')

  const vaultRoot = join(app.getPath('userData'), 'context-vaults')
  const vaultPath = join(vaultRoot, createHash('sha256').update(trimmed).digest('hex').slice(0, 16))
  await mkdir(vaultRoot, { recursive: true })

  try {
    const info = await stat(vaultPath)
    if (!info.isDirectory()) throw new Error('Context vault cache path is not a folder.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await runGit(['clone', '--', trimmed, vaultPath], undefined, 15 * 60_000)
    return vaultPath
  }

  await runGit(['-C', vaultPath, 'pull', '--ff-only'], undefined, 5 * 60_000)
  return vaultPath
}

async function writeVaultSnapshot(
  vaultPath: string,
  vaultKey: string,
  bundle: GitHubContextBundle,
  dek: Buffer
): Promise<string> {
  const projectDir = join(vaultPath, 'projects', vaultKey)
  const snapshotsDir = join(projectDir, 'snapshots')
  await mkdir(snapshotsDir, { recursive: true })

  const timestamp = bundle.createdAt.replace(/[:.]/g, '-')
  const snapshotRel = `snapshots/${timestamp}.context.enc`
  const snapshotPath = join(projectDir, snapshotRel)
  await writeFile(snapshotPath, JSON.stringify(encryptBundleWithDek(JSON.stringify(bundle), dek), null, 2), 'utf-8')

  const manifest = await readVaultManifest(projectDir, vaultKey)
  manifest.latestSnapshot = snapshotRel
  manifest.snapshots = [
    { file: snapshotRel, createdAt: bundle.createdAt, files: bundle.files.length, workspace: bundle.projectWorkspace != null },
    ...manifest.snapshots.filter((entry) => entry.file !== snapshotRel)
  ].slice(0, 50)
  await writeFile(join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  return snapshotRel
}

async function readVaultManifest(projectDir: string, vaultKey: string): Promise<VaultManifest> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, 'manifest.json'), 'utf-8')) as Partial<VaultManifest>
    if (parsed.version === 1 && Array.isArray(parsed.snapshots)) {
      return {
        version: 1,
        vaultKey,
        latestSnapshot: typeof parsed.latestSnapshot === 'string' ? parsed.latestSnapshot : null,
        snapshots: parsed.snapshots.filter((entry) => entry && typeof entry.file === 'string')
      }
    }
  } catch {
    // Fall through to a fresh manifest.
  }
  return { version: 1, vaultKey, latestSnapshot: null, snapshots: [] }
}

async function ensureApiVaultRepository(): Promise<{ owner: string; repo: string }> {
  const auth = await getGitHubAuthStatus()
  if (!auth.authenticated || !auth.login) throw new Error('Sign in to GitHub first.')

  try {
    const existing = await githubApiJson<GitHubRepoApiResponse>(
      `/repos/${encodeURIComponent(auth.login)}/${GITHUB_CONTEXT_VAULT_REPO_NAME}`
    )
    if (existing.private !== true) {
      throw new Error(`${auth.login}/${GITHUB_CONTEXT_VAULT_REPO_NAME} exists but is not private.`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (!message.toLowerCase().includes('not found')) throw error
    await githubApiJson<GitHubRepoApiResponse>('/user/repos', undefined, {
      method: 'POST',
      body: JSON.stringify({
        name: GITHUB_CONTEXT_VAULT_REPO_NAME,
        private: true,
        auto_init: true,
        description: 'Encrypted Cadence project context snapshots'
      })
    })
  }

  return { owner: auth.login, repo: GITHUB_CONTEXT_VAULT_REPO_NAME }
}

async function writeVaultSnapshotViaGitHubApi(
  vault: { owner: string; repo: string },
  vaultKey: string,
  bundle: GitHubContextBundle,
  dek: Buffer,
  repo: GitHubRepositoryIdentity | null
): Promise<string> {
  const projectRoot = `projects/${vaultKey}`
  const timestamp = bundle.createdAt.replace(/[:.]/g, '-')
  const snapshotRel = `snapshots/${timestamp}.context.enc`
  const snapshotPath = `${projectRoot}/${snapshotRel}`
  const label = repo ? `${repo.owner}/${repo.repo}` : vaultKey

  await putGitHubFile(
    vault,
    snapshotPath,
    JSON.stringify(encryptBundleWithDek(JSON.stringify(bundle), dek), null, 2),
    `Sync encrypted context snapshot for ${label}`
  )

  const manifest = await readVaultManifestViaGitHubApi(vault, vaultKey)
  manifest.latestSnapshot = snapshotRel
  manifest.snapshots = [
    { file: snapshotRel, createdAt: bundle.createdAt, files: bundle.files.length, workspace: bundle.projectWorkspace != null },
    ...manifest.snapshots.filter((entry) => entry.file !== snapshotRel)
  ].slice(0, 50)

  await putGitHubFile(
    vault,
    `${projectRoot}/manifest.json`,
    JSON.stringify(manifest, null, 2),
    `Update context manifest for ${label}`
  )

  return snapshotRel
}

async function readVaultManifestViaGitHubApi(
  vault: { owner: string; repo: string },
  vaultKey: string
): Promise<VaultManifest> {
  const text = await getGitHubFileText(vault, `projects/${vaultKey}/manifest.json`)
  if (!text) return { version: 1, vaultKey, latestSnapshot: null, snapshots: [] }
  try {
    const parsed = JSON.parse(text) as Partial<VaultManifest>
    if (parsed.version === 1 && Array.isArray(parsed.snapshots)) {
      return {
        version: 1,
        vaultKey,
        latestSnapshot: typeof parsed.latestSnapshot === 'string' ? parsed.latestSnapshot : null,
        snapshots: parsed.snapshots.filter((entry) => entry && typeof entry.file === 'string')
      }
    }
  } catch {
    // Invalid manifest means this project has no usable snapshot metadata.
  }
  return { version: 1, vaultKey, latestSnapshot: null, snapshots: [] }
}

async function getGitHubFile(
  vault: { owner: string; repo: string },
  path: string
): Promise<GitHubContentsFile | null> {
  try {
    const encodedPath = encodeGitHubContentPath(path)
    const result = await githubApiJson<GitHubContentsFile>(
      `/repos/${encodeURIComponent(vault.owner)}/${encodeURIComponent(vault.repo)}/contents/${encodedPath}`
    )
    return result && result.type === 'file' ? result : null
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('not found')) return null
    throw error
  }
}

async function getGitHubFileText(vault: { owner: string; repo: string }, path: string): Promise<string | null> {
  const file = await getGitHubFile(vault, path)
  if (!file?.content || file.encoding !== 'base64') return null
  return Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf-8')
}

async function putGitHubFile(
  vault: { owner: string; repo: string },
  path: string,
  text: string,
  message: string
): Promise<void> {
  const existing = await getGitHubFile(vault, path)
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(text, 'utf-8').toString('base64')
  }
  if (existing?.sha) body.sha = existing.sha

  await githubApiJson<unknown>(
    `/repos/${encodeURIComponent(vault.owner)}/${encodeURIComponent(vault.repo)}/contents/${encodeGitHubContentPath(path)}`,
    undefined,
    {
      method: 'PUT',
      body: JSON.stringify(body)
    }
  )
}

function encodeGitHubContentPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')
}

async function commitAndPushVault(vaultPath: string, vaultKey: string): Promise<void> {
  // Stage this project's snapshots plus the root keyring (created on the first sync).
  await runGit(['-C', vaultPath, 'add', '--', `projects/${vaultKey}`, VAULT_KEYRING_FILE])
  try {
    await runGit(['-C', vaultPath, 'commit', '-m', `Sync context for ${vaultKey}`])
  } catch (error) {
    const message = formatGitError(error, '')
    if (!message.includes('nothing to commit') && !message.includes('no changes added')) throw error
  }
  try {
    await runGit(['-C', vaultPath, 'push'], undefined, 5 * 60_000)
  } catch {
    await runGit(['-C', vaultPath, 'push', '-u', 'origin', 'HEAD'], undefined, 5 * 60_000)
  }
}

async function restoreProjectContext({
  restore,
  repo,
  projectPath,
  platform,
  projectId
}: {
  restore: GitHubContextRestoreRequest
  repo: GitHubRepositoryIdentity
  projectPath: string
  platform: PlatformId
  projectId: string
}): Promise<GitHubContextRestoreSummary> {
  try {
    // Import always has a GitHub repo, whose device-independent key is the vault key.
    const vaultKey = gitHubVaultKey(repo.owner, repo.repo)
    const mode = restore.mode ?? (restore.vaultRepositoryUrl?.trim() ? 'git' : 'oauth')
    const { bundle, snapshotRel } =
      mode === 'oauth'
        ? await readVaultSnapshotViaGitHubApi(vaultKey, restore)
        : await readVaultSnapshotFromGitVault(vaultKey, restore)

    return restoreContextBundle({
      bundle,
      snapshotRel,
      vaultKey,
      projectPath,
      platform,
      projectId
    })
  } catch (error) {
    return {
      attempted: true,
      restored: false,
      snapshot: null,
      filesRestored: 0,
      workspaceRestored: false,
      locked: error instanceof VaultLockedError,
      error: error instanceof Error ? error.message : 'Could not restore context.'
    }
  }
}

async function readVaultSnapshotViaGitHubApi(
  vaultKey: string,
  restore: GitHubContextRestoreRequest
): Promise<{ bundle: GitHubContextBundle; snapshotRel: string }> {
  const vault = await ensureApiVaultRepository()
  const dek = await resolveVaultDek(apiVaultKeyringIO(vault), { recoveryKey: restore.recoveryKey })
  if (!dek.ok) throw new VaultLockedError(dek.error)

  const manifest = await readVaultManifestViaGitHubApi(vault, vaultKey)
  const snapshotRel = manifest.latestSnapshot ?? manifest.snapshots[0]?.file ?? null
  if (!snapshotRel) throw new Error('No context snapshot found for this project.')

  // Defence-in-depth (LOW-2): the manifest is server-supplied, so normalise the path it
  // names the same way the git-vault path does before fetching, so a tampered manifest
  // can't point the fetch at a `../`-escaped or absolute path. Mirrors safeJoin's guard.
  const safeRel = normalizeBundlePath(snapshotRel)
  if (!safeRel) throw new Error('Invalid context snapshot path.')

  const snapshotText = await getGitHubFileText(vault, `projects/${vaultKey}/${safeRel}`)
  if (!snapshotText) throw new Error('Could not read context snapshot.')
  const bundle = JSON.parse(
    decryptBundleWithDek(JSON.parse(snapshotText) as EncryptedSnapshotV2, dek.dek)
  ) as GitHubContextBundle
  return { bundle, snapshotRel }
}

async function readVaultSnapshotFromGitVault(
  vaultKey: string,
  restore: GitHubContextRestoreRequest
): Promise<{ bundle: GitHubContextBundle; snapshotRel: string }> {
  if (!restore.vaultRepositoryUrl?.trim()) throw new Error('Vault URL is required.')
  const vaultPath = await ensureVaultRepository(restore.vaultRepositoryUrl)
  const dek = await resolveVaultDek(gitVaultKeyringIO(vaultPath), { recoveryKey: restore.recoveryKey })
  if (!dek.ok) throw new VaultLockedError(dek.error)

  const projectDir = join(vaultPath, 'projects', vaultKey)
  const manifest = await readVaultManifest(projectDir, vaultKey)
  const snapshotRel = manifest.latestSnapshot ?? manifest.snapshots[0]?.file ?? null
  if (!snapshotRel) throw new Error('No context snapshot found for this project.')

  const snapshotPath = safeJoin(projectDir, snapshotRel)
  if (!snapshotPath) throw new Error('Invalid context snapshot path.')
  const encrypted = JSON.parse(await readFile(snapshotPath, 'utf-8')) as EncryptedSnapshotV2
  return { bundle: JSON.parse(decryptBundleWithDek(encrypted, dek.dek)) as GitHubContextBundle, snapshotRel }
}

async function restoreContextBundle({
  bundle,
  snapshotRel,
  vaultKey,
  projectPath,
  platform,
  projectId
}: {
  bundle: GitHubContextBundle
  snapshotRel: string
  vaultKey: string
  projectPath: string
  platform: PlatformId
  projectId: string
}): Promise<GitHubContextRestoreSummary> {
  if (!matchesVault(bundle, vaultKey)) throw new Error('Snapshot belongs to a different project.')

  const projectRoot = toNativeRoot(projectPath, null)
  const centralMemory = join(getDefaultClaudeProjectsRoot(), centralSlug(projectPath), 'memory')
  let filesRestored = 0
  for (const file of bundle.files) {
    const basePath = file.target === 'central-memory' ? centralMemory : projectRoot
    const target = safeJoin(basePath, file.path)
    if (!target) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.text, 'utf-8')
    filesRestored += 1
  }

  let workspaceRestored = false
  if (bundle.projectWorkspace != null) {
    await saveProjectWorkspace(workspaceProjectId(platform, projectPath), bundle.projectWorkspace)
    if (projectId !== workspaceProjectId(platform, projectPath)) {
      await saveProjectWorkspace(projectId, bundle.projectWorkspace)
    }
    workspaceRestored = true
  }

  // A freshly restored project starts in-sync with this snapshot as its base.
  await recordVaultSync(contextVaultLinksPath(), projectId, {
    snapshot: snapshotRel,
    fingerprint: fingerprintFiles(bundle.files),
    at: new Date().toISOString()
  })

  return { attempted: true, restored: true, snapshot: snapshotRel, filesRestored, workspaceRestored }
}

// A restored snapshot must belong to the project we're restoring into. Match on the
// device-independent vault key; fall back to the snapshot's repo key for older
// snapshots written before `vaultKey` existed (for GitHub projects the two are equal).
function matchesVault(bundle: GitHubContextBundle, vaultKey: string): boolean {
  const bundleKey = bundle.vaultKey ?? bundle.repo?.key ?? ''
  if (!bundleKey || !vaultKey) return false
  const left = Buffer.from(bundleKey)
  const right = Buffer.from(vaultKey)
  return left.length === right.length && timingSafeEqual(left, right)
}
