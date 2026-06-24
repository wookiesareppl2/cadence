import { app, dialog, type BrowserWindow, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
  type GitHubContextSyncRequest,
  type GitHubContextSyncResult,
  type GitHubImportRequest,
  type GitHubImportResult,
  type GitHubRepositoryIdentity
} from '@shared/github-import'
import { getGitHubAuthStatus, getGitHubToken, githubApiJson } from './github-auth-service'
import { getDefaultClaudeProjectsRoot } from '../usage/claude-jsonl'
import { resolveProjectLocation, type ProjectLocation } from '../projects/project-locator'
import { getProjectWorkspace, saveProjectWorkspace } from '../projects/project-workspace-service'
import { attachWorkspacePath } from '../workspaces/workspace-service'
import { workspaceProjectId } from '../workspaces/workspace-utils'

type GitResult = { stdout: string; stderr: string }

type EncryptedSnapshot = {
  version: 1
  algorithm: 'aes-256-gcm'
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

type VaultManifest = {
  version: 1
  repo: GitHubRepositoryIdentity
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

export async function syncProjectContextToVault(
  request: GitHubContextSyncRequest,
  sender: WebContents
): Promise<GitHubContextSyncResult> {
  if (!request.passphrase) return { ok: false, error: 'Enter the context vault passphrase.' }

  const location = await resolveProjectLocation(request.platform, request.projectId, sender)
  if (!location) return { ok: false, error: 'Project folder not found.' }

  const repoUrl = request.repositoryUrl?.trim() || (await inferGithubRemote(location))
  const repo = repoUrl ? parseGitHubRepository(repoUrl) : null
  if (!repo) return { ok: false, error: 'Could not identify a GitHub repository for this project.' }

  let bundle: GitHubContextBundle
  try {
    bundle = await buildContextBundle(repo, location, request.projectId)
  } catch (error) {
    return { ok: false, repo, error: error instanceof Error ? error.message : 'Could not collect context files.' }
  }

  try {
    const mode = request.mode ?? (request.vaultRepositoryUrl?.trim() ? 'git' : 'oauth')
    let snapshot: string
    if (mode === 'oauth') {
      snapshot = await writeVaultSnapshotViaGitHubApi(repo, bundle, request.passphrase)
    } else {
      if (!request.vaultRepositoryUrl?.trim()) return { ok: false, repo, error: 'Enter a context vault repository URL.' }
      const vaultPath = await ensureVaultRepository(request.vaultRepositoryUrl)
      snapshot = await writeVaultSnapshot(vaultPath, repo, bundle, request.passphrase)
      await commitAndPushVault(vaultPath, repo)
    }
    return {
      ok: true,
      repo,
      snapshot,
      filesSynced: bundle.files.length,
      workspaceSynced: bundle.projectWorkspace != null
    }
  } catch (error) {
    return { ok: false, repo, error: formatGitError(error, 'Could not sync the context vault.') }
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
  return runGitWithEnv(args, cwd, timeoutMs, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`
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
  repo: GitHubRepositoryIdentity,
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
  repo: GitHubRepositoryIdentity,
  bundle: GitHubContextBundle,
  passphrase: string
): Promise<string> {
  const projectDir = join(vaultPath, 'projects', repo.key)
  const snapshotsDir = join(projectDir, 'snapshots')
  await mkdir(snapshotsDir, { recursive: true })

  const timestamp = bundle.createdAt.replace(/[:.]/g, '-')
  const snapshotRel = `snapshots/${timestamp}.context.enc`
  const snapshotPath = join(projectDir, snapshotRel)
  await writeFile(snapshotPath, JSON.stringify(encryptBundle(bundle, passphrase), null, 2), 'utf-8')

  const manifest = await readVaultManifest(projectDir, repo)
  manifest.latestSnapshot = snapshotRel
  manifest.snapshots = [
    { file: snapshotRel, createdAt: bundle.createdAt, files: bundle.files.length, workspace: bundle.projectWorkspace != null },
    ...manifest.snapshots.filter((entry) => entry.file !== snapshotRel)
  ].slice(0, 50)
  await writeFile(join(projectDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  return snapshotRel
}

async function readVaultManifest(projectDir: string, repo: GitHubRepositoryIdentity): Promise<VaultManifest> {
  try {
    const parsed = JSON.parse(await readFile(join(projectDir, 'manifest.json'), 'utf-8')) as Partial<VaultManifest>
    if (parsed.version === 1 && Array.isArray(parsed.snapshots)) {
      return {
        version: 1,
        repo,
        latestSnapshot: typeof parsed.latestSnapshot === 'string' ? parsed.latestSnapshot : null,
        snapshots: parsed.snapshots.filter((entry) => entry && typeof entry.file === 'string')
      }
    }
  } catch {
    // Fall through to a fresh manifest.
  }
  return { version: 1, repo, latestSnapshot: null, snapshots: [] }
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
  repo: GitHubRepositoryIdentity,
  bundle: GitHubContextBundle,
  passphrase: string
): Promise<string> {
  const vault = await ensureApiVaultRepository()
  const projectRoot = `projects/${repo.key}`
  const timestamp = bundle.createdAt.replace(/[:.]/g, '-')
  const snapshotRel = `snapshots/${timestamp}.context.enc`
  const snapshotPath = `${projectRoot}/${snapshotRel}`

  await putGitHubFile(
    vault,
    snapshotPath,
    JSON.stringify(encryptBundle(bundle, passphrase), null, 2),
    `Sync encrypted context snapshot for ${repo.owner}/${repo.repo}`
  )

  const manifest = await readVaultManifestViaGitHubApi(vault, repo)
  manifest.latestSnapshot = snapshotRel
  manifest.snapshots = [
    { file: snapshotRel, createdAt: bundle.createdAt, files: bundle.files.length, workspace: bundle.projectWorkspace != null },
    ...manifest.snapshots.filter((entry) => entry.file !== snapshotRel)
  ].slice(0, 50)

  await putGitHubFile(
    vault,
    `${projectRoot}/manifest.json`,
    JSON.stringify(manifest, null, 2),
    `Update context manifest for ${repo.owner}/${repo.repo}`
  )

  return snapshotRel
}

async function readVaultManifestViaGitHubApi(
  vault: { owner: string; repo: string },
  repo: GitHubRepositoryIdentity
): Promise<VaultManifest> {
  const text = await getGitHubFileText(vault, `projects/${repo.key}/manifest.json`)
  if (!text) return { version: 1, repo, latestSnapshot: null, snapshots: [] }
  try {
    const parsed = JSON.parse(text) as Partial<VaultManifest>
    if (parsed.version === 1 && Array.isArray(parsed.snapshots)) {
      return {
        version: 1,
        repo,
        latestSnapshot: typeof parsed.latestSnapshot === 'string' ? parsed.latestSnapshot : null,
        snapshots: parsed.snapshots.filter((entry) => entry && typeof entry.file === 'string')
      }
    }
  } catch {
    // Invalid manifest means this repo has no usable snapshot metadata.
  }
  return { version: 1, repo, latestSnapshot: null, snapshots: [] }
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

function encryptBundle(bundle: GitHubContextBundle, passphrase: string): EncryptedSnapshot {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf-8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

function decryptBundle(snapshot: EncryptedSnapshot, passphrase: string): GitHubContextBundle {
  if (snapshot.version !== 1 || snapshot.algorithm !== 'aes-256-gcm' || snapshot.kdf !== 'scrypt') {
    throw new Error('Unsupported context snapshot format.')
  }
  const salt = Buffer.from(snapshot.salt, 'base64')
  const iv = Buffer.from(snapshot.iv, 'base64')
  const tag = Buffer.from(snapshot.tag, 'base64')
  const key = scryptSync(passphrase, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(snapshot.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf-8')
  return JSON.parse(plaintext) as GitHubContextBundle
}

async function commitAndPushVault(vaultPath: string, repo: GitHubRepositoryIdentity): Promise<void> {
  await runGit(['-C', vaultPath, 'add', '--', `projects/${repo.key}`])
  try {
    await runGit(['-C', vaultPath, 'commit', '-m', `Sync context for ${repo.owner}/${repo.repo}`])
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
    if (!restore.passphrase) {
      return {
        attempted: true,
        restored: false,
        snapshot: null,
        filesRestored: 0,
        workspaceRestored: false,
        error: 'Context vault passphrase is required.'
      }
    }

    const mode = restore.mode ?? (restore.vaultRepositoryUrl?.trim() ? 'git' : 'oauth')
    const { bundle, snapshotRel } =
      mode === 'oauth'
        ? await readVaultSnapshotViaGitHubApi(repo, restore.passphrase)
        : await readVaultSnapshotFromGitVault(repo, restore)

    return restoreContextBundle({
      bundle,
      snapshotRel,
      repo,
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
      error: error instanceof Error ? error.message : 'Could not restore context.'
    }
  }
}

async function readVaultSnapshotViaGitHubApi(
  repo: GitHubRepositoryIdentity,
  passphrase: string
): Promise<{ bundle: GitHubContextBundle; snapshotRel: string }> {
  const vault = await ensureApiVaultRepository()
  const manifest = await readVaultManifestViaGitHubApi(vault, repo)
  const snapshotRel = manifest.latestSnapshot ?? manifest.snapshots[0]?.file ?? null
  if (!snapshotRel) throw new Error('No context snapshot found for this repository.')

  const snapshotText = await getGitHubFileText(vault, `projects/${repo.key}/${snapshotRel}`)
  if (!snapshotText) throw new Error('Could not read context snapshot.')
  const bundle = decryptBundle(JSON.parse(snapshotText) as EncryptedSnapshot, passphrase)
  return { bundle, snapshotRel }
}

async function readVaultSnapshotFromGitVault(
  repo: GitHubRepositoryIdentity,
  restore: GitHubContextRestoreRequest
): Promise<{ bundle: GitHubContextBundle; snapshotRel: string }> {
  if (!restore.vaultRepositoryUrl?.trim()) throw new Error('Vault URL is required.')
  const vaultPath = await ensureVaultRepository(restore.vaultRepositoryUrl)
  const projectDir = join(vaultPath, 'projects', repo.key)
  const manifest = await readVaultManifest(projectDir, repo)
  const snapshotRel = manifest.latestSnapshot ?? manifest.snapshots[0]?.file ?? null
  if (!snapshotRel) throw new Error('No context snapshot found for this repository.')

  const snapshotPath = safeJoin(projectDir, snapshotRel)
  if (!snapshotPath) throw new Error('Invalid context snapshot path.')
  const encrypted = JSON.parse(await readFile(snapshotPath, 'utf-8')) as EncryptedSnapshot
  return { bundle: decryptBundle(encrypted, restore.passphrase), snapshotRel }
}

async function restoreContextBundle({
  bundle,
  snapshotRel,
  repo,
  projectPath,
  platform,
  projectId
}: {
  bundle: GitHubContextBundle
  snapshotRel: string
  repo: GitHubRepositoryIdentity
  projectPath: string
  platform: PlatformId
  projectId: string
}): Promise<GitHubContextRestoreSummary> {
  if (!sameRepo(repo, bundle.repo)) throw new Error('Snapshot belongs to a different repository.')

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

  return { attempted: true, restored: true, snapshot: snapshotRel, filesRestored, workspaceRestored }
}

function sameRepo(a: GitHubRepositoryIdentity, b: GitHubRepositoryIdentity): boolean {
  const left = Buffer.from(a.key)
  const right = Buffer.from(b.key)
  return left.length === right.length && timingSafeEqual(left, right)
}
