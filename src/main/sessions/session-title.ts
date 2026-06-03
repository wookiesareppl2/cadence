export type TitleMessage = {
  text: string
  timestampMs: number
}

export type ResolvedSessionTitle = {
  title: string
  rawTitle: string | null
  inferredTitle: string | null
}

const MAX_TITLE_LENGTH = 56
const MAX_TITLE_WORDS = 7

const TOPIC_TITLES: Array<{ pattern: RegExp; title: string }> = [
  { pattern: /\bsession titles?\b|\bthread names?\b/i, title: 'Improve session titles' },
  { pattern: /\bsession detail\b|\bmetadata panel\b/i, title: 'Compact session metadata' },
  { pattern: /\bmaxlistenersexceededwarning\b|\beventemitter memory leak\b/i, title: 'Fix terminal listener cleanup' },
  { pattern: /\bcommand-message\b/i, title: 'Clean Claude session titles' },
  { pattern: /\bcodex\b.*\b(?:git )?branch|\b(?:git )?branch\b.*\bcodex\b/i, title: 'Show Codex git branches' },
  { pattern: /\bcodex\b.*\busage\b|\busage bars?\b/i, title: 'Show Codex usage' },
  { pattern: /\bimage hover animation\b|\bhover animation\b/i, title: 'Fix image hover animation' },
  { pattern: /\bsecurity vulnerabilities?\b|\bsecurity review\b/i, title: 'Review security vulnerabilities' },
  { pattern: /\bskills context budget\b|\bskill descriptions\b|\bskills?\b.*\bshortened\b/i, title: 'Trim active skills' }
]

const ACTION_WORDS =
  /\b(add|adapt|build|clean|collapse|compact|create|debug|derive|display|explain|fix|generate|hide|implement|improve|investigate|move|parse|polish|remove|rename|review|show|support|update|wire)\b/i

export function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null

  const text = value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text
      return null
    })
    .filter(Boolean)
    .join(' ')
    .trim()

  return text || null
}

export function titleCandidate(text: string | null): string | null {
  if (!text) return null
  if (/<\/?(command-message|command-name|local-command-stdout|system-reminder)\b/i.test(text)) return null

  const stripped = cleanMarkup(text)
  return stripped || null
}

export function resolveSessionTitle({
  rawTitle,
  fallbackTitle,
  messages
}: {
  rawTitle: string | null
  fallbackTitle: string
  messages: TitleMessage[]
}): ResolvedSessionTitle {
  const readableRawTitle = readableTitle(titleCandidate(rawTitle), null)
  const inferredTitle = inferSessionTitle(messages)
  const title = inferredTitle ?? readableRawTitle ?? fallbackTitle

  return {
    title: readableTitle(title, fallbackTitle) ?? fallbackTitle,
    rawTitle: readableRawTitle,
    inferredTitle
  }
}

function inferSessionTitle(messages: TitleMessage[]): string | null {
  const seen = new Set<string>()
  const candidates = [...messages]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .map((message) => normalizeRequestText(message.text))
    .filter((text) => {
      const key = text.toLowerCase()
      if (!text || seen.has(key) || !isSubstantive(text)) return false
      seen.add(key)
      return true
    })

  for (const candidate of candidates) {
    const topicTitle = TOPIC_TITLES.find((topic) => topic.pattern.test(candidate))?.title
    if (topicTitle) return topicTitle

    const actionTitle = compactActionTitle(candidate)
    if (actionTitle) return actionTitle
  }

  return null
}

function normalizeRequestText(text: string): string {
  let value = text
    .replace(/\r/g, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')

  const requestMarker = value.match(/##\s*My request for (?:Codex|Claude(?: Code)?|ChatGPT):\s*([\s\S]*)/i)
  if (requestMarker) value = requestMarker[1]

  value = value
    .replace(/Unified diff[\s\S]*$/i, ' ')
    .replace(/Changed files[\s\S]*$/i, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^[\s>*-]+/gm, ' ')

  return cleanMarkup(value)
}

function cleanMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSubstantive(text: string): boolean {
  const normalized = text.toLowerCase().trim()
  if (!normalized) return false
  if (/^[$/]?(start|save)\b/.test(normalized)) return false
  if (/^(ok|okay|looks good|thanks|thank you|proceed|continue|yes|no)[.! ]*$/.test(normalized)) return false
  if (/^proceed as suggested[.! ]*$/.test(normalized)) return false
  if (/^okay[, ]+(let'?s|we can|proceed|continue)\b/.test(normalized) && normalized.length < 90) return false
  if (normalized.includes('active file:') && normalized.includes('open tabs:') && !normalized.includes('my request')) {
    return false
  }

  return normalized.length >= 12
}

function compactActionTitle(text: string): string | null {
  const sentence = chooseActionSentence(text)
  if (!sentence) return null

  const cleaned = sentence
    .replace(/^(please\s+)?see some feedback:\s*/i, '')
    .replace(/^(can|could|would)\s+you\s+/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^i\s+(?:need help|need|want|would like|was thinking to maybe|think i would prefer|realized that)\s+/i, '')
    .replace(/^i\s+don'?t like that\s+/i, '')
    .replace(/^is there no way for\s+/i, '')
    .replace(/^what exactly\s+/i, 'Explain ')
    .replace(/[?!.:,;]+$/g, '')
    .trim()

  if (!cleaned || !ACTION_WORDS.test(cleaned)) return null
  return readableTitle(capitalizeFirst(limitWords(cleaned)), null)
}

function chooseActionSentence(text: string): string | null {
  const sentences = text
    .split(/(?<=[.!?])\s+|\s+\*\s+|\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean)

  return sentences.find((sentence) => ACTION_WORDS.test(sentence)) ?? sentences[0] ?? null
}

function limitWords(text: string): string {
  const words = text.split(/\s+/).filter(Boolean)
  const limited = words.slice(0, MAX_TITLE_WORDS)

  while (limited.length > 1 && /^(a|an|and|for|from|in|of|on|or|the|to|with)$/i.test(limited[limited.length - 1])) {
    limited.pop()
  }

  return limited.join(' ')
}

function readableTitle(text: string | null, fallback: string | null): string | null {
  if (!text) return fallback
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > MAX_TITLE_LENGTH ? `${normalized.slice(0, MAX_TITLE_LENGTH - 3)}...` : normalized
}

function capitalizeFirst(text: string): string {
  if (!text) return text
  return `${text[0].toUpperCase()}${text.slice(1)}`
}
