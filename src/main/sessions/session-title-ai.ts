import type { PlatformId } from '@shared/platform'

export const SESSION_TITLE_PROMPT_VERSION = 1

const MAX_DIGEST_CHARS = 14_000
const MAX_ENTRY_CHARS = 900
const MIN_GENERATED_TITLE_WORDS = 2
const MAX_GENERATED_TITLE_WORDS = 7
const MAX_GENERATED_TITLE_CHARS = 64

export type SessionTitleDigestEntry = {
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestampMs: number
}

export type CompactedSessionTitleDigest = {
  entries: SessionTitleDigestEntry[]
  omittedEntryCount: number
  charCount: number
}

export type SessionTitlePromptInput = {
  platform: PlatformId
  project: string
  projectPath: string | null
  branch: string | null
  fallbackTitle: string
  heuristicTitle: string
  rawTitle: string | null
  inferredTitle: string | null
  previousTitle: string | null
  previousSummary: string | null
  mode: 'initial' | 'delta'
  transcriptUpdatedAt: string | null
  digest: CompactedSessionTitleDigest
}

type ParsedSessionTitleGeneration = {
  title: string
  summary: string
  shouldUpdate: boolean
  confidence: number
  reason: string
}

export type ValidatedSessionTitleGeneration = ParsedSessionTitleGeneration & {
  title: string
}

const BAD_TITLE_START = /^(?:i(?:'| a)m|i\s+have|i've|we(?:'| a)ve|just|okay|sure|run|please|can you|could you|let'?s)\b/i
const COMMAND_OR_PATH = /(?:\[[^\]]+\]\([^)]+\)|[$/][a-z][\w-]*|[a-z]:\\|\\\\|\.jsonl\b|\.md\b|\.tsx?\b|\.jsx?\b)/i
const SENTENCE_FRAGMENT = /\b(?:which likely|going to|able to|ready to|reviewed the document|do anything)\b/i
const WEAK_WORKFLOW = /^(?:general stuff|misc(?:ellaneous)?|dashboard work|project work)$/i

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length
}

function titleCase(value: string): string {
  const smallWords = new Set(['a', 'an', 'and', 'as', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'via'])
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((word, index) => {
      if (/^[A-Z0-9_/-]+$/.test(word) && word.length > 1) return word
      const lower = word.toLowerCase()
      if (index > 0 && smallWords.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

function normalizeGeneratedSessionTitle(value: string): string | null {
  const withoutQuotes = value.replace(/^["'`]+|["'`]+$/g, '')
  const withoutTrailingPunctuation = withoutQuotes.replace(/[.!?:;,]+$/g, '')
  const normalized = withoutTrailingPunctuation.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return titleCase(normalized)
}

export function validateGeneratedSessionTitle(value: string | null | undefined): string | null {
  if (!value) return null
  const title = normalizeGeneratedSessionTitle(value)
  if (!title) return null
  const words = wordCount(title)
  if (words < MIN_GENERATED_TITLE_WORDS || words > MAX_GENERATED_TITLE_WORDS) return null
  if (title.length > MAX_GENERATED_TITLE_CHARS) return null
  if (BAD_TITLE_START.test(title)) return null
  if (COMMAND_OR_PATH.test(title)) return null
  if (SENTENCE_FRAGMENT.test(title)) return null
  if (WEAK_WORKFLOW.test(title)) return null
  if (!/[a-zA-Z]/.test(title)) return null
  return title
}

export function compactSessionTitleDigest(
  entries: SessionTitleDigestEntry[],
  maxChars = MAX_DIGEST_CHARS
): CompactedSessionTitleDigest {
  const cleaned = entries
    .map((entry) => ({
      ...entry,
      text: trimText(entry.text, entry.role === 'tool' ? 180 : MAX_ENTRY_CHARS)
    }))
    .filter((entry) => entry.text.length > 0)

  if (cleaned.length === 0) return { entries: [], omittedEntryCount: 0, charCount: 0 }

  const selected: SessionTitleDigestEntry[] = []
  let charCount = 0

  const push = (entry: SessionTitleDigestEntry, limit: number): boolean => {
    const nextCost = entry.text.length + entry.role.length + 8
    if (selected.some((existing) => existing.timestampMs === entry.timestampMs && existing.text === entry.text)) {
      return true
    }
    if (charCount + nextCost > limit) return false
    selected.push(entry)
    charCount += nextCost
    return true
  }

  const headLimit = Math.max(360, Math.floor(maxChars * 0.4))
  for (const entry of cleaned.slice(0, 8)) {
    if (!push(entry, headLimit)) break
  }

  const tail = cleaned.slice(Math.max(0, cleaned.length - 24)).reverse()
  for (const entry of tail) {
    if (!push(entry, maxChars)) break
  }

  selected.sort((a, b) => a.timestampMs - b.timestampMs)

  return {
    entries: selected,
    omittedEntryCount: Math.max(0, cleaned.length - selected.length),
    charCount
  }
}

export function buildSessionTitlePrompt(input: SessionTitlePromptInput): string {
  return JSON.stringify(
    {
      task: 'Generate a short, accurate session title for a coding-assistant transcript.',
      priorities: [
        'Minimize title churn: keep the previous title unless the new transcript clearly changes the main work.',
        'Name the main workstream, artifact, or outcome, not incidental tool setup.',
        'Avoid raw prompts, command fragments, paths, status phrases, and generic filler.'
      ],
      requiredOutput: {
        title: '2-7 words, noun phrase, glanceable, no punctuation at the end',
        summary: 'One compact sentence that can be reused for future delta updates',
        shouldUpdate: 'false only when previousTitle is still accurate',
        confidence: '0 to 1',
        reason: 'Brief explanation of the title choice'
      },
      session: {
        platform: input.platform,
        project: input.project,
        projectPath: input.projectPath,
        branch: input.branch,
        transcriptUpdatedAt: input.transcriptUpdatedAt,
        fallbackTitle: input.fallbackTitle,
        heuristicTitle: input.heuristicTitle,
        rawTitle: input.rawTitle,
        inferredTitle: input.inferredTitle,
        previousTitle: input.previousTitle,
        previousSummary: input.previousSummary,
        mode: input.mode
      },
      transcriptDigest: {
        omittedEntryCount: input.digest.omittedEntryCount,
        entries: input.digest.entries.map((entry) => ({
          role: entry.role,
          text: entry.text
        }))
      }
    },
    null,
    2
  )
}

export function parseSessionTitleGenerationOutput(raw: string): ValidatedSessionTitleGeneration | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return null
    }
  }

  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const title = validateGeneratedSessionTitle(typeof record.title === 'string' ? record.title : null)
  if (!title) return null

  const confidence = typeof record.confidence === 'number' ? Math.max(0, Math.min(1, record.confidence)) : 0
  const summary =
    typeof record.summary === 'string' && record.summary.trim()
      ? trimText(record.summary, 600)
      : `Session titled ${title}.`
  const reason =
    typeof record.reason === 'string' && record.reason.trim() ? trimText(record.reason, 240) : 'Generated from transcript.'

  return {
    title,
    summary,
    shouldUpdate: typeof record.shouldUpdate === 'boolean' ? record.shouldUpdate : true,
    confidence,
    reason
  }
}
