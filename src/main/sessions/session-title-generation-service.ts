import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PlatformId } from '@shared/platform'
import type { SessionTitleGenerationStatus, SessionTitleSource, SessionTitleStatus } from '@shared/sessions'
import { cleanHistoryText } from './session-history-text'
import { contentText, type ResolvedSessionTitle, type TitleMessage } from './session-title'
import {
  buildSessionTitlePrompt,
  compactSessionTitleDigest,
  parseSessionTitleGenerationOutput,
  SESSION_TITLE_PROMPT_VERSION,
  validateGeneratedSessionTitle,
  type CompactedSessionTitleDigest,
  type SessionTitleDigestEntry
} from './session-title-ai'

export type SessionTranscriptSource = {
  path: string
  size: number
  mtimeMs: number
}

export type GeneratedSessionTitleFields = {
  title: string
  rawTitle: string | null
  inferredTitle: string | null
  generatedTitle: string | null
  titleSource: SessionTitleSource
  titleStatus: SessionTitleStatus | null
  titleUpdatedAt: string | null
}

export type ResolveGeneratedSessionTitleInput = {
  platform: PlatformId
  sessionId: string
  project: string
  projectPath: string | null
  branch: string | null
  fallbackTitle: string
  resolvedTitle: ResolvedSessionTitle
  titleMessages: TitleMessage[]
  transcriptUpdatedAtMs: number
  sources: SessionTranscriptSource[]
}

type ProcessedSource = {
  size: number
  mtimeMs: number
}

type SessionTitleCacheEntry = {
  promptVersion: number
  // 'empty' marks a session that yielded no usable transcript content yet
  // (new/empty session, or only tool/meta/sidechain rows). It is a benign
  // "nothing to title yet" state — not a failure — so it never sets the
  // runtime error or lights the sidebar error dot.
  status: 'ready' | 'failed' | 'empty'
  provider: 'openai' | 'codex'
  model: string
  title: string | null
  summary: string | null
  reason: string | null
  confidence: number | null
  sourceFingerprint: string
  processedSources: Record<string, ProcessedSource>
  transcriptUpdatedAt: string | null
  generatedAt: string
  attemptedAt: string
  inputCharCount: number
  outputCharCount: number
  error: string | null
}

type SessionTitleCache = {
  version: 1
  entries: Record<string, SessionTitleCacheEntry>
}

type OpenAiTitleProvider = {
  kind: 'openai'
  apiKey: string
  endpoint: string
  model: string
}

type CodexTitleProvider = {
  kind: 'codex'
  bin: string
  model: string
  reasoningEffort: string
  timeoutMs: number
}

type TitleProvider = OpenAiTitleProvider | CodexTitleProvider

type SessionTitleGenerationJob = ResolveGeneratedSessionTitleInput & {
  sessionKey: string
  sourceFingerprint: string
}

type DigestForJob = {
  mode: 'initial' | 'delta'
  digest: CompactedSessionTitleDigest
  processedSources: Record<string, ProcessedSource>
}

const STORE_VERSION = 1
const TITLE_CACHE_FILE = 'session-title-cache.json'
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'
const OPENAI_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses'
// A ChatGPT-plan Codex login only exposes the flagship slug; the lighter API-only
// models (gpt-5-mini, gpt-5-codex, ...) are rejected with a 400. `gpt-5.5` at low
// reasoning effort produces accurate titles quickly without burning much quota.
const DEFAULT_CODEX_MODEL = 'gpt-5.5'
const DEFAULT_CODEX_REASONING_EFFORT = 'low'
const TITLE_GENERATION_TIMEOUT_MS = 30_000
const CODEX_GENERATION_TIMEOUT_MS = 60_000
const FAILED_RETRY_MS = 30 * 60_000
const DEFAULT_MAX_JOBS_PER_RUN = 12
const DEFAULT_MAX_PENDING_JOBS = 12

// Shared JSON shape for the generated title payload. The OpenAI provider embeds it
// in the Responses `json_schema`; the Codex provider writes it to an `--output-schema`
// file so `codex exec` constrains its final message the same way.
const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'shouldUpdate', 'confidence', 'reason'],
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    shouldUpdate: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' }
  }
} as const

let cachePromise: Promise<SessionTitleCache> | null = null
let writeQueue = Promise.resolve()
let queueRunning = false
let jobsStartedThisRun = 0

const queuedJobs = new Map<string, SessionTitleGenerationJob>()
const runtimeStatus: SessionTitleGenerationStatus = {
  enabled: false,
  pending: 0,
  running: false,
  processed: 0,
  failed: 0,
  lastError: null
}

function cachePath(): string {
  return join(app.getPath('userData'), TITLE_CACHE_FILE)
}

function emptyCache(): SessionTitleCache {
  return { version: STORE_VERSION, entries: {} }
}

function asProcessedSources(value: unknown): Record<string, ProcessedSource> {
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, ProcessedSource> = {}
  for (const [path, source] of Object.entries(value as Record<string, unknown>)) {
    if (!source || typeof source !== 'object') continue
    const record = source as Record<string, unknown>
    if (typeof record.size !== 'number' || typeof record.mtimeMs !== 'number') continue
    out[path] = { size: record.size, mtimeMs: record.mtimeMs }
  }
  return out
}

function parseCacheEntry(value: unknown): SessionTitleCacheEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const sourceFingerprint = typeof record.sourceFingerprint === 'string' ? record.sourceFingerprint : null
  const generatedAt = typeof record.generatedAt === 'string' ? record.generatedAt : null
  const attemptedAt = typeof record.attemptedAt === 'string' ? record.attemptedAt : generatedAt
  const status =
    record.status === 'ready' || record.status === 'failed' || record.status === 'empty' ? record.status : null
  if (!sourceFingerprint || !generatedAt || !attemptedAt || !status) return null

  const title = typeof record.title === 'string' ? validateGeneratedSessionTitle(record.title) : null
  if (status === 'ready' && !title) return null

  return {
    promptVersion:
      typeof record.promptVersion === 'number' ? Math.floor(record.promptVersion) : SESSION_TITLE_PROMPT_VERSION,
    status,
    provider: record.provider === 'codex' ? 'codex' : 'openai',
    model: typeof record.model === 'string' && record.model.trim() ? record.model : DEFAULT_OPENAI_MODEL,
    title,
    summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary : null,
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason : null,
    confidence: typeof record.confidence === 'number' ? record.confidence : null,
    sourceFingerprint,
    processedSources: asProcessedSources(record.processedSources),
    transcriptUpdatedAt: typeof record.transcriptUpdatedAt === 'string' ? record.transcriptUpdatedAt : null,
    generatedAt,
    attemptedAt,
    inputCharCount: typeof record.inputCharCount === 'number' ? record.inputCharCount : 0,
    outputCharCount: typeof record.outputCharCount === 'number' ? record.outputCharCount : 0,
    error: typeof record.error === 'string' && record.error.trim() ? record.error : null
  }
}

function parseCache(raw: string): SessionTitleCache {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyCache()
  }
  if (!parsed || typeof parsed !== 'object') return emptyCache()

  const entries: Record<string, SessionTitleCacheEntry> = {}
  const rawEntries = (parsed as Record<string, unknown>).entries
  if (rawEntries && typeof rawEntries === 'object') {
    for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      const entry = parseCacheEntry(value)
      if (entry) entries[key] = entry
    }
  }

  return { version: STORE_VERSION, entries }
}

async function readCache(): Promise<SessionTitleCache> {
  if (!cachePromise) {
    cachePromise = readFile(cachePath(), 'utf-8')
      .then(parseCache)
      .catch(() => emptyCache())
  }
  return cachePromise
}

async function writeCache(cache: SessionTitleCache): Promise<void> {
  cachePromise = Promise.resolve(cache)
  writeQueue = writeQueue.then(async () => {
    const path = cachePath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(cache, null, 2), 'utf-8')
  })
  return writeQueue
}

function sessionKey(platform: PlatformId, sessionId: string): string {
  return `${platform}:${sessionId}`
}

function transcriptUpdatedAt(timestampMs: number): string | null {
  return timestampMs > 0 ? new Date(timestampMs).toISOString() : null
}

function sourceFingerprint(sources: SessionTranscriptSource[], transcriptUpdatedAtMs: number): string {
  const sourceParts = [...sources]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((source) => `${source.path}:${source.size}:${Math.round(source.mtimeMs)}`)
  return JSON.stringify({ promptVersion: SESSION_TITLE_PROMPT_VERSION, transcriptUpdatedAtMs, sources: sourceParts })
}

function sourceFromResolved(resolvedTitle: ResolvedSessionTitle, fallbackTitle: string): SessionTitleSource {
  if (resolvedTitle.inferredTitle && resolvedTitle.title === resolvedTitle.inferredTitle) return 'heuristic'
  if (resolvedTitle.rawTitle && resolvedTitle.title === resolvedTitle.rawTitle) return 'raw'
  if (resolvedTitle.title === fallbackTitle) return 'fallback'
  return 'heuristic'
}

function maxJobsPerRun(): number {
  const parsed = Number.parseInt(process.env.AI_DASHBOARD_TITLE_MAX_JOBS_PER_RUN ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_JOBS_PER_RUN
}

function maxPendingJobs(): number {
  const parsed = Number.parseInt(process.env.AI_DASHBOARD_TITLE_MAX_PENDING_JOBS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_PENDING_JOBS
}

function codexTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.AI_DASHBOARD_TITLE_CODEX_TIMEOUT_MS ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CODEX_GENERATION_TIMEOUT_MS
}

// Resolve the Codex CLI launcher. GUI-launched Electron builds can inherit a stripped
// PATH, so prefer an explicit override, then the known npm global shim, then PATH.
function resolveCodexBin(): string {
  const override = process.env.AI_DASHBOARD_TITLE_CODEX_BIN?.trim()
  if (override) return override
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) {
      const candidate = join(appData, 'npm', 'codex.cmd')
      if (existsSync(candidate)) return candidate
    }
    return 'codex.cmd'
  }
  return 'codex'
}

function openAiProviderConfig(): OpenAiTitleProvider | null {
  const apiKey = process.env.AI_DASHBOARD_TITLE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) return null
  return {
    kind: 'openai',
    apiKey,
    endpoint: process.env.AI_DASHBOARD_TITLE_ENDPOINT?.trim() || OPENAI_RESPONSES_ENDPOINT,
    model: process.env.AI_DASHBOARD_TITLE_MODEL?.trim() || DEFAULT_OPENAI_MODEL
  }
}

function codexProviderConfig(): CodexTitleProvider {
  return {
    kind: 'codex',
    bin: resolveCodexBin(),
    model: process.env.AI_DASHBOARD_TITLE_MODEL?.trim() || DEFAULT_CODEX_MODEL,
    reasoningEffort: process.env.AI_DASHBOARD_TITLE_REASONING_EFFORT?.trim() || DEFAULT_CODEX_REASONING_EFFORT,
    timeoutMs: codexTimeoutMs()
  }
}

// Provider selection: `AI_DASHBOARD_TITLE_PROVIDER` forces a backend; otherwise default
// to the locally signed-in Codex CLI (ChatGPT plan, no API key, no per-call billing).
// `openai` only activates when an API key is present, so a bare `openai` selection with
// no key falls back to deterministic titles exactly as before.
function providerConfig(): TitleProvider | null {
  const explicit = process.env.AI_DASHBOARD_TITLE_PROVIDER?.trim().toLowerCase()

  if (explicit === 'openai') {
    const openai = openAiProviderConfig()
    runtimeStatus.enabled = Boolean(openai)
    return openai
  }

  if (explicit === 'off' || explicit === 'none' || explicit === 'disabled') {
    runtimeStatus.enabled = false
    return null
  }

  runtimeStatus.enabled = true
  return codexProviderConfig()
}

function shouldRetryFailed(entry: SessionTitleCacheEntry | undefined): boolean {
  if (!entry || entry.status !== 'failed') return true
  const attemptedAt = Date.parse(entry.attemptedAt)
  return Number.isNaN(attemptedAt) || Date.now() - attemptedAt >= FAILED_RETRY_MS
}

function queueTitleGeneration(job: SessionTitleGenerationJob, currentEntry: SessionTitleCacheEntry | undefined): boolean {
  const provider = providerConfig()
  if (!provider) return false
  if (!shouldRetryFailed(currentEntry)) return false
  // An 'empty' session has nothing to title yet. Don't re-queue it until its
  // transcript changes (a new fingerprint), so empty/new sessions don't churn
  // the queue or eat into the per-burst job budget meant for real sessions.
  if (currentEntry?.status === 'empty' && currentEntry.sourceFingerprint === job.sourceFingerprint) return false
  if (jobsStartedThisRun + queuedJobs.size >= maxJobsPerRun()) return false
  if (!queuedJobs.has(job.sessionKey) && queuedJobs.size >= maxPendingJobs()) return false

  const existing = queuedJobs.get(job.sessionKey)
  if (existing?.sourceFingerprint === job.sourceFingerprint) return true

  queuedJobs.set(job.sessionKey, job)
  runtimeStatus.pending = queuedJobs.size
  void drainTitleQueue(provider)
  return true
}

export async function resolveGeneratedSessionTitle(
  input: ResolveGeneratedSessionTitleInput
): Promise<GeneratedSessionTitleFields> {
  const key = sessionKey(input.platform, input.sessionId)
  const fingerprint = sourceFingerprint(input.sources, input.transcriptUpdatedAtMs)
  const cache = await readCache()
  const entry = cache.entries[key]
  const cachedTitle = entry?.title ? validateGeneratedSessionTitle(entry.title) : null
  const baseSource = sourceFromResolved(input.resolvedTitle, input.fallbackTitle)
  const promptCompatible = entry?.promptVersion === SESSION_TITLE_PROMPT_VERSION

  if (cachedTitle && promptCompatible && entry.sourceFingerprint === fingerprint) {
    return {
      title: cachedTitle,
      rawTitle: input.resolvedTitle.rawTitle,
      inferredTitle: input.resolvedTitle.inferredTitle,
      generatedTitle: cachedTitle,
      titleSource: 'generated',
      titleStatus: 'ready',
      titleUpdatedAt: entry.generatedAt
    }
  }

  const queued = queueTitleGeneration({ ...input, sessionKey: key, sourceFingerprint: fingerprint }, entry)

  if (cachedTitle) {
    return {
      title: cachedTitle,
      rawTitle: input.resolvedTitle.rawTitle,
      inferredTitle: input.resolvedTitle.inferredTitle,
      generatedTitle: cachedTitle,
      titleSource: 'generated',
      titleStatus: queued ? 'stale' : providerConfig() ? 'stale' : 'disabled',
      titleUpdatedAt: entry?.generatedAt ?? null
    }
  }

  return {
    title: input.resolvedTitle.title,
    rawTitle: input.resolvedTitle.rawTitle,
    inferredTitle: input.resolvedTitle.inferredTitle,
    generatedTitle: null,
    titleSource: baseSource,
    titleStatus: providerConfig() ? (queued ? 'pending' : entry?.status === 'failed' ? 'failed' : 'pending') : 'disabled',
    titleUpdatedAt: null
  }
}

export function getSessionTitleGenerationStatus(): SessionTitleGenerationStatus {
  providerConfig()
  return {
    ...runtimeStatus,
    pending: queuedJobs.size,
    running: queueRunning
  }
}

async function drainTitleQueue(provider: TitleProvider): Promise<void> {
  if (queueRunning) return

  queueRunning = true
  runtimeStatus.running = true

  try {
    while (queuedJobs.size > 0 && jobsStartedThisRun < maxJobsPerRun()) {
      const [key, job] = queuedJobs.entries().next().value as [string, SessionTitleGenerationJob]
      queuedJobs.delete(key)
      runtimeStatus.pending = queuedJobs.size
      jobsStartedThisRun += 1

      try {
        await processTitleGenerationJob(job, provider)
        runtimeStatus.processed += 1
        // A job completed without error — clear any stale error so the sidebar
        // error dot reflects the current state, not a past one-off failure.
        runtimeStatus.lastError = null
      } catch (error) {
        runtimeStatus.failed += 1
        runtimeStatus.lastError = error instanceof Error ? error.message : 'Session title generation failed'
        await recordGenerationFailure(job, provider, runtimeStatus.lastError)
      }
    }
  } finally {
    queueRunning = false
    runtimeStatus.running = false
    runtimeStatus.pending = queuedJobs.size
    // Reset the per-burst job counter so `maxJobsPerRun` caps work per drain cycle
    // (the intent), not per app launch. Without this reset the counter only ever
    // grows, so after `maxJobsPerRun` titles the app silently stops generating any
    // more — leaving stale sessions stuck showing "AI generated, updating" forever.
    jobsStartedThisRun = 0
  }
}

async function processTitleGenerationJob(job: SessionTitleGenerationJob, provider: TitleProvider): Promise<void> {
  const cache = await readCache()
  const previous = cache.entries[job.sessionKey]
  if (
    previous?.status === 'ready' &&
    previous.promptVersion === SESSION_TITLE_PROMPT_VERSION &&
    previous.sourceFingerprint === job.sourceFingerprint &&
    previous.title
  ) {
    return
  }

  // Already recorded as empty for this exact transcript — nothing changed, so
  // there's still nothing to title. Skip without re-reading the file.
  if (
    previous?.status === 'empty' &&
    previous.promptVersion === SESSION_TITLE_PROMPT_VERSION &&
    previous.sourceFingerprint === job.sourceFingerprint
  ) {
    return
  }

  const digestForJob = await readDigestForJob(job, previous)
  if (digestForJob.digest.entries.length === 0) {
    if (previous?.status === 'ready' && previous.title) {
      const nextCache = await readCache()
      nextCache.entries[job.sessionKey] = {
        ...previous,
        sourceFingerprint: job.sourceFingerprint,
        processedSources: digestForJob.processedSources,
        transcriptUpdatedAt: transcriptUpdatedAt(job.transcriptUpdatedAtMs),
        attemptedAt: new Date().toISOString(),
        error: null
      }
      await writeCache(nextCache)
      return
    }
    // No usable transcript content yet — a new/empty session, or one whose only
    // rows are tool/meta/sidechain entries that we deliberately filter out. This
    // is "nothing to title yet", not a failure: record a benign 'empty' marker
    // so we retry once real content arrives, without lighting the error dot.
    await recordEmptyTranscript(job, provider, digestForJob.processedSources)
    return
  }

  const prompt = buildSessionTitlePrompt({
    platform: job.platform,
    project: job.project,
    projectPath: job.projectPath,
    branch: job.branch,
    fallbackTitle: job.fallbackTitle,
    heuristicTitle: job.resolvedTitle.title,
    rawTitle: job.resolvedTitle.rawTitle,
    inferredTitle: job.resolvedTitle.inferredTitle,
    previousTitle: previous?.title ?? null,
    previousSummary: previous?.summary ?? null,
    mode: digestForJob.mode,
    transcriptUpdatedAt: transcriptUpdatedAt(job.transcriptUpdatedAtMs),
    digest: digestForJob.digest
  })

  const generated =
    provider.kind === 'codex'
      ? await generateTitleWithCodex(provider, prompt)
      : await generateTitleWithOpenAi(provider, prompt)
  const parsed = parseSessionTitleGenerationOutput(generated.outputText)
  if (!parsed) throw new Error('Title provider returned an invalid title payload')

  const previousTitle = previous?.title ? validateGeneratedSessionTitle(previous.title) : null
  const finalTitle = parsed.shouldUpdate || !previousTitle ? parsed.title : previousTitle

  const nextCache = await readCache()
  nextCache.entries[job.sessionKey] = {
    promptVersion: SESSION_TITLE_PROMPT_VERSION,
    status: 'ready',
    provider: provider.kind,
    model: generated.model,
    title: finalTitle,
    summary: parsed.summary,
    reason: parsed.reason,
    confidence: parsed.confidence,
    sourceFingerprint: job.sourceFingerprint,
    processedSources: digestForJob.processedSources,
    transcriptUpdatedAt: transcriptUpdatedAt(job.transcriptUpdatedAtMs),
    generatedAt: new Date().toISOString(),
    attemptedAt: new Date().toISOString(),
    inputCharCount: prompt.length,
    outputCharCount: generated.outputText.length,
    error: null
  }
  await writeCache(nextCache)
}

async function recordEmptyTranscript(
  job: SessionTitleGenerationJob,
  provider: TitleProvider,
  processedSources: Record<string, ProcessedSource>
): Promise<void> {
  const cache = await readCache()
  const previous = cache.entries[job.sessionKey]
  cache.entries[job.sessionKey] = {
    promptVersion: SESSION_TITLE_PROMPT_VERSION,
    status: 'empty',
    provider: provider.kind,
    model: provider.model,
    title: previous?.title ?? null,
    summary: previous?.summary ?? null,
    reason: previous?.reason ?? null,
    confidence: previous?.confidence ?? null,
    sourceFingerprint: job.sourceFingerprint,
    processedSources,
    transcriptUpdatedAt: transcriptUpdatedAt(job.transcriptUpdatedAtMs),
    generatedAt: previous?.generatedAt ?? new Date().toISOString(),
    attemptedAt: new Date().toISOString(),
    inputCharCount: previous?.inputCharCount ?? 0,
    outputCharCount: previous?.outputCharCount ?? 0,
    error: null
  }
  await writeCache(cache)
}

async function recordGenerationFailure(
  job: SessionTitleGenerationJob,
  provider: TitleProvider,
  error: string
): Promise<void> {
  const cache = await readCache()
  const previous = cache.entries[job.sessionKey]
  cache.entries[job.sessionKey] = {
    promptVersion: SESSION_TITLE_PROMPT_VERSION,
    status: 'failed',
    provider: provider.kind,
    model: provider.model,
    title: previous?.title ?? null,
    summary: previous?.summary ?? null,
    reason: previous?.reason ?? null,
    confidence: previous?.confidence ?? null,
    sourceFingerprint: job.sourceFingerprint,
    processedSources: previous?.processedSources ?? {},
    transcriptUpdatedAt: transcriptUpdatedAt(job.transcriptUpdatedAtMs),
    generatedAt: previous?.generatedAt ?? new Date().toISOString(),
    attemptedAt: new Date().toISOString(),
    inputCharCount: previous?.inputCharCount ?? 0,
    outputCharCount: previous?.outputCharCount ?? 0,
    error
  }
  await writeCache(cache)
}

function hasToolResultContent(content: unknown): boolean {
  return Array.isArray(content) && content.some((item) => item?.type === 'tool_result')
}

function isSyntheticClaudeUserRow(row: any): boolean {
  return Boolean(row?.isMeta) || Boolean(row?.toolUseResult) || hasToolResultContent(row?.message?.content)
}

function cleanDigestText(text: string | null, commandPrefix: '$' | '/' = '$'): string | null {
  const cleaned = cleanHistoryText(text, { commandPrefix })
  return cleaned?.replace(/\s+/g, ' ').trim() || null
}

function digestTimestampMs(row: { timestamp?: unknown }, fallbackMs: number): number {
  if (typeof row.timestamp !== 'string') return fallbackMs
  const parsed = Date.parse(row.timestamp)
  return Number.isNaN(parsed) ? fallbackMs : parsed
}

function claudeDigestEntry(row: any, fallbackMs: number): SessionTitleDigestEntry | null {
  if (row?.isSidechain === true) return null
  const timestampMs = digestTimestampMs(row, fallbackMs)

  if (row?.type === 'queue-operation' && typeof row.content === 'string') {
    const text = cleanDigestText(row.content, '$')
    return text ? { role: 'user', text, timestampMs } : null
  }

  if (row?.type === 'user') {
    if (isSyntheticClaudeUserRow(row)) return null
    const text = cleanDigestText(contentText(row.message?.content), '$')
    return text ? { role: 'user', text, timestampMs } : null
  }

  if (row?.type === 'assistant') {
    const text = cleanDigestText(contentText(row.message?.content), '$')
    return text ? { role: 'assistant', text, timestampMs } : null
  }

  return null
}

function codexDigestEntry(row: any, fallbackMs: number): SessionTitleDigestEntry | null {
  const timestampMs = digestTimestampMs(row, fallbackMs)

  if (row?.type === 'event_msg' && row.payload?.type === 'user_message') {
    const text = cleanDigestText(typeof row.payload.message === 'string' ? row.payload.message : null, '/')
    return text ? { role: 'user', text, timestampMs } : null
  }

  if (row?.type !== 'response_item') return null
  const payload = row.payload
  if (payload?.type === 'message') {
    const role = payload.role === 'assistant' ? 'assistant' : payload.role === 'user' ? 'user' : null
    if (!role) return null
    const text = cleanDigestText(contentText(payload.content), '/')
    return text ? { role, text, timestampMs } : null
  }

  if (payload?.type === 'function_call' && typeof payload.name === 'string') {
    return { role: 'tool', text: `Tool call: ${payload.name}`, timestampMs }
  }

  return null
}

async function readDigestForJob(
  job: SessionTitleGenerationJob,
  previous: SessionTitleCacheEntry | undefined
): Promise<DigestForJob> {
  const previousSources = previous?.status === 'ready' && previous.title ? previous.processedSources : {}
  const entries: SessionTitleDigestEntry[] = []
  const processedSources: Record<string, ProcessedSource> = {}
  let mode: 'initial' | 'delta' = 'delta'

  for (const source of job.sources) {
    const previousSource = previousSources[source.path]
    const start = previousSource && previousSource.size <= source.size ? previousSource.size : 0
    if (start === 0) mode = 'initial'
    processedSources[source.path] = { size: source.size, mtimeMs: source.mtimeMs }
    if (start >= source.size) continue

    for await (const entry of readDigestEntriesFromSource(
      job.platform,
      source.path,
      start,
      source.size - 1,
      source.mtimeMs
    )) {
      entries.push(entry)
    }
  }

  if (entries.length === 0 && previous?.status === 'ready' && previous.title) {
    mode = 'delta'
  }

  return {
    mode,
    digest: compactSessionTitleDigest(entries),
    processedSources
  }
}

async function* readDigestEntriesFromSource(
  platform: PlatformId,
  path: string,
  start: number,
  end: number,
  fallbackMs: number
): AsyncGenerator<SessionTitleDigestEntry> {
  const stream = createReadStream(path, { encoding: 'utf-8', start, end })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of lines) {
    if (!line) continue
    try {
      const row = JSON.parse(line)
      const entry = platform === 'claude' ? claudeDigestEntry(row, fallbackMs) : codexDigestEntry(row, fallbackMs)
      if (entry) yield entry
    } catch {
      // Delta reads can start in the middle of a line; ignore malformed rows.
    }
  }
}

async function generateTitleWithOpenAi(
  provider: OpenAiTitleProvider,
  prompt: string
): Promise<{ outputText: string; model: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TITLE_GENERATION_TIMEOUT_MS)

  try {
    const response = await fetch(provider.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: provider.model,
        instructions:
          'You generate accurate, concise titles for coding-assistant sessions. Return only JSON matching the requested schema.',
        input: prompt,
        max_output_tokens: 500,
        text: {
          format: {
            type: 'json_schema',
            name: 'session_title_generation',
            strict: true,
            schema: TITLE_OUTPUT_SCHEMA
          }
        }
      })
    })

    const raw = await response.text()
    if (!response.ok) {
      throw new Error(`OpenAI title generation returned ${response.status}: ${raw.slice(0, 240)}`)
    }

    let data: any
    try {
      data = JSON.parse(raw)
    } catch {
      throw new Error('OpenAI title generation returned unreadable JSON')
    }

    const outputText = extractOpenAiOutputText(data)
    if (!outputText) throw new Error('OpenAI title generation returned no text output')

    return {
      outputText,
      model: typeof data.model === 'string' && data.model.trim() ? data.model : provider.model
    }
  } finally {
    clearTimeout(timeout)
  }
}

function extractOpenAiOutputText(data: any): string | null {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text
  if (!Array.isArray(data?.output)) return null

  const parts: string[] = []
  for (const item of data.output) {
    if (!Array.isArray(item?.content)) continue
    for (const content of item.content) {
      if (typeof content?.text === 'string') parts.push(content.text)
      else if (typeof content?.output_text === 'string') parts.push(content.output_text)
    }
  }

  return parts.join('\n').trim() || null
}

function quoteArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`
}

function stderrTail(stderr: string): string {
  const trimmed = stderr.trim()
  if (!trimmed) return ''
  return `: ${trimmed.slice(-240)}`
}

function runCodexExec(commandLine: string, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, { shell: true, windowsHide: true })
    let stderr = ''
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => {
        child.kill()
        reject(new Error(`Codex title generation timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    child.on('error', (error) => {
      finish(() => reject(error instanceof Error ? error : new Error('Failed to launch Codex CLI')))
    })
    child.on('exit', (code) => {
      finish(() =>
        code === 0
          ? resolve(stderr)
          : reject(new Error(`Codex CLI exited with code ${code ?? 'null'}${stderrTail(stderr)}`))
      )
    })

    if (!child.stdin) {
      finish(() => reject(new Error('Codex CLI stdin was unavailable')))
      return
    }
    // Pass the prompt via stdin so transcript content never reaches the command line.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

// Generate a title through the locally signed-in Codex CLI. Runs ephemerally in an
// isolated temp dir with user config ignored, so it cannot pollute the user's Codex
// session list (which this very dashboard renders) or pull in their heavy config/MCP.
async function generateTitleWithCodex(
  provider: CodexTitleProvider,
  prompt: string
): Promise<{ outputText: string; model: string }> {
  const workDir = await mkdtemp(join(tmpdir(), 'cadence-title-'))
  const schemaPath = join(workDir, 'schema.json')
  const outPath = join(workDir, 'out.json')

  try {
    await writeFile(schemaPath, JSON.stringify(TITLE_OUTPUT_SCHEMA), 'utf-8')

    const args = [
      'exec',
      '--ignore-user-config',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-s',
      'read-only',
      '--cd',
      quoteArg(workDir),
      '-m',
      provider.model,
      '-c',
      `model_reasoning_effort=${provider.reasoningEffort}`,
      '--output-schema',
      quoteArg(schemaPath),
      '-o',
      quoteArg(outPath),
      '-'
    ]
    const commandLine = `${quoteArg(provider.bin)} ${args.join(' ')}`

    const stderr = await runCodexExec(commandLine, prompt, provider.timeoutMs)

    let outputText: string
    try {
      outputText = await readFile(outPath, 'utf-8')
    } catch {
      throw new Error(`Codex title generation produced no output${stderrTail(stderr)}`)
    }
    if (!outputText.trim()) {
      throw new Error(`Codex title generation returned empty output${stderrTail(stderr)}`)
    }

    return { outputText, model: provider.model }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function sourceFromPath(path: string): Promise<SessionTranscriptSource | null> {
  try {
    const stats = await stat(path)
    return { path, size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return null
  }
}
