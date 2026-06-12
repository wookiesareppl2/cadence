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

const GENERAL_IMPROVEMENTS_TITLE = 'General Improvements'

// Sessions that are nothing but a /start or /save skill run carry no real user
// request to infer from. Rather than the bare provider fallback, label them by
// the workflow that produced them. Markers run over lowercased, backtick-stripped
// text — and only when no substantive request exists, so genuine work is unaffected.
const START_SESSION_TITLE = 'Session Start'
const SAVE_SESSION_TITLE = 'Save Session'
const START_SESSION_MARKER = /\bstart[-\s](?:skill|session)\b|(?:^|\s)[$/]start\b/
const SAVE_SESSION_MARKER = /\bsave[-\s](?:skill|session|worker|operation)\b|(?:^|\s)[$/]save\b/

type TopicGroup = 'debug' | 'memory' | 'release' | 'security' | 'sessions' | 'terminal' | 'usage' | 'visual'

type TopicDefinition = {
  key: string
  group: TopicGroup
  title: string
  score?: number
  patterns: RegExp[]
}

type ExactTitle = {
  group: TopicGroup
  title: string
  pattern: RegExp
}

type TitleRequest = {
  text: string
  timestampMs: number
}

type TopicHit = {
  definition: TopicDefinition
  score: number
}

type RequestAnalysis = TitleRequest & {
  exactTitles: ExactTitle[]
  topics: TopicHit[]
}

type TopicScore = {
  definition: TopicDefinition
  score: number
  latestMs: number
}

type GroupScore = {
  group: TopicGroup
  score: number
  latestMs: number
  topics: Map<string, TopicScore>
}

const TOPIC_DEFINITIONS: TopicDefinition[] = [
  {
    key: 'session-display',
    group: 'sessions',
    title: 'Session Display Improvements',
    patterns: [
      /\bsession\s+titles?\b/i,
      /\bthread\s+names?\b/i,
      /\bsession\s+display\b/i,
      /\bsession\s+rows?\b/i,
      /\bhuman[- ]readable\b.*\btitles?\b/i,
      /\btitles?\b.*\bhuman[- ]readable\b/i,
      /\bhistory\b.*\b(?:transcript|readable|display|back and forth|turns?)\b/i,
      /\btranscript\b.*\b(?:readable|history|display|turns?)\b/i
    ]
  },
  {
    key: 'session-management',
    group: 'sessions',
    title: 'Session Management Improvements',
    patterns: [
      /\bduplicate\s+(?:codex\s+)?sessions?\b/i,
      /\bsubagent\s+sessions?\b/i,
      /\bsession\s+(?:aliases?|metadata|browser|filtering|management)\b/i,
      /\bsessions?\b.*\b(?:listed|listing|filter|filtered|project|workspace)\b/i,
      /\bproject[- ]first\b/i,
      /\battach(?:ed)?\s+workspace\b/i,
      /\bnew\s+session\b/i
    ]
  },
  {
    key: 'usage-notifications',
    group: 'usage',
    title: 'Usage Notification Improvements',
    patterns: [
      /\busage\s+(?:alerts?|notifications?|notices?|popups?|pop ups?)\b/i,
      /\b(?:claude|codex)\s+usage\b.*\b(?:alerts?|notifications?|notices?|popups?|pop ups?|limits?)\b/i,
      /\busage\b.*\b(?:nearing|limits?|thresholds?|windows?|resets?)\b/i,
      /\bnearing\s+(?:its|the)?\s*(?:usage\s+)?limit\b/i
    ]
  },
  {
    key: 'usage-display',
    group: 'usage',
    title: 'Usage Display Improvements',
    patterns: [
      /\busage\s+(?:bars?|display|meters?|cards?|panels?|polling|api)\b/i,
      /\b(?:claude|codex)\s+usage\b/i
    ]
  },
  {
    key: 'visual-polish',
    group: 'visual',
    title: 'Visual Polish',
    patterns: [
      /\bscrollbars?\b/i,
      /\bvisual\s+(?:elements?|polish|design|style|styles?)\b/i,
      /\b(?:ui|css|layout|color|theme|dark ui)\b/i
    ]
  },
  {
    key: 'release-workflow',
    group: 'release',
    title: 'Update Workflow Improvements',
    patterns: [
      /\bauto[- ]?updates?\b/i,
      /\bapp updates?\b/i,
      /\bpackage(?:d|s|ing)?\b/i,
      /\breleases?\b/i,
      /\binstallers?\b/i,
      /\binstalled app\b/i,
      /\bprompt[- ]to[- ]install\b/i,
      /\brestart(?:\s+to)?\s+install\b/i,
      /%APPDATA%\\ai-dashboard/i
    ]
  },
  {
    key: 'memory-skills',
    group: 'memory',
    title: 'Skill and Memory Workflow Improvements',
    patterns: [
      /\bmemory bank\b/i,
      /\bhandoff\b/i,
      /\bcontext pins?\b/i,
      /\b(?:start|save)\s+skill\b/i,
      /\bskills?\s+(?:context|budget|descriptions?|cleanup|shortened)\b/i
    ]
  },
  {
    key: 'terminal',
    group: 'terminal',
    title: 'Terminal Improvements',
    patterns: [/\bterminal\b/i, /\bshell\b/i, /\bnode-pty\b/i, /\bconpty\b/i, /\bmaxlistenersexceededwarning\b/i]
  },
  {
    key: 'security-review',
    group: 'security',
    title: 'Security Review',
    patterns: [/\bsecurity vulnerabilities?\b/i, /\bsecurity review\b/i]
  },
  {
    key: 'debugging',
    group: 'debug',
    title: 'Build and Runtime Fixes',
    score: 0.75,
    patterns: [
      /\berrors?\b/i,
      /\bcrash(?:es|ed|ing)?\b/i,
      /\bexceptions?\b/i,
      /\bfail(?:ed|ing|s)?\b/i,
      /\btypecheck\b/i,
      /\bvitest\b/i,
      /\btests?\b.*\bfail/i,
      /\bbetter-sqlite3\b/i,
      /\bABI\b/
    ]
  }
]

const EXACT_TITLES: ExactTitle[] = [
  { group: 'visual', pattern: /\bimage hover animation\b|\bhover animation\b/i, title: 'Fix Image Hover Animation' },
  { group: 'security', pattern: /\bsecurity vulnerabilities?\b|\bsecurity review\b/i, title: 'Security Review' },
  {
    group: 'terminal',
    pattern: /\bmaxlistenersexceededwarning\b|\beventemitter memory leak\b/i,
    title: 'Terminal Listener Cleanup'
  },
  {
    group: 'sessions',
    pattern: /\bduplicate\s+(?:codex\s+)?sessions?\b|\bsubagent\s+sessions?\b/i,
    title: 'Codex Session Filtering'
  },
  { group: 'sessions', pattern: /\bsession aliases?\b.*\b(?:titles?|json)\b|\bagent_path\b/i, title: 'Session Alias Cleanup' },
  {
    group: 'usage',
    pattern: /\busage\s+(?:alerts?|notifications?|notices?|popups?|pop ups?)\b|\bnearing\s+(?:its|the)?\s*(?:usage\s+)?limit\b/i,
    title: 'Usage Notification Improvements'
  },
  {
    group: 'sessions',
    pattern: /\bcodex\b.*\b(?:git )?branch\b|\b(?:git )?branch\b.*\bcodex\b/i,
    title: 'Codex Branch Display'
  },
  { group: 'memory', pattern: /\bskills?\s+(?:context|budget|descriptions?|shortened)\b/i, title: 'Skill Context Cleanup' }
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
  // Reject injected, non-user content. Beyond command/system markers, this covers
  // Codex's environment preamble (`<environment_context>` — cwd/shell/date, whose
  // inner text would otherwise leak as the title) and skill/instruction
  // expansions (`<skill>`, `<user_instructions>`) that the user never typed.
  if (
    /<\/?(command-message|command-name|local-command-stdout|subagent_notification|system-reminder|environment_context|skill|user_instructions)\b/i.test(
      text
    )
  ) {
    return null
  }

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
  const readableRawTitle = readableRawSessionTitle(rawTitle)
  const inferredTitle = inferSessionTitle(messages)
  // Only when there's no real inferred title and no usable provider title do we
  // fall to a workflow label, so a meaningful raw title still wins.
  const workflowTitle = inferredTitle || readableRawTitle ? null : workflowSessionTitle(messages)
  const title = inferredTitle ?? readableRawTitle ?? workflowTitle ?? fallbackTitle

  return {
    title: readableTitle(title, fallbackTitle) ?? fallbackTitle,
    rawTitle: readableRawTitle,
    inferredTitle
  }
}

// Classify a request-less session as a pure /start or /save skill run. The long
// worker prompts reference both skills, so we count marker hits and take the
// dominant workflow; on a tie the workflow whose marker appears first (the
// opening command/instruction) wins. Returns null only when neither appears.
function workflowSessionTitle(messages: TitleMessage[]): string | null {
  const startRe = new RegExp(START_SESSION_MARKER.source, 'g')
  const saveRe = new RegExp(SAVE_SESSION_MARKER.source, 'g')
  let start = 0
  let save = 0
  let first: typeof START_SESSION_TITLE | typeof SAVE_SESSION_TITLE | null = null

  for (const { text } of messages) {
    const lower = text.toLowerCase().replace(/`/g, '')
    start += lower.match(startRe)?.length ?? 0
    save += lower.match(saveRe)?.length ?? 0

    if (first === null) {
      const startAt = lower.search(START_SESSION_MARKER)
      const saveAt = lower.search(SAVE_SESSION_MARKER)
      if (startAt !== -1 && (saveAt === -1 || startAt <= saveAt)) first = START_SESSION_TITLE
      else if (saveAt !== -1) first = SAVE_SESSION_TITLE
    }
  }

  if (start === 0 && save === 0) return null
  if (start !== save) return start > save ? START_SESSION_TITLE : SAVE_SESSION_TITLE
  return first
}

function inferSessionTitle(messages: TitleMessage[]): string | null {
  const requests = collectTitleRequests(messages)
  const analyses = requests.map(analyzeRequest)
  const groups = rankGroups(analyses)

  if (groups.length > 0) {
    const primary = choosePrimaryGroup(groups)
    return primary ? focusedGroupTitle(primary, analyses) : GENERAL_IMPROVEMENTS_TITLE
  }

  const actionTitle = [...analyses]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .map((analysis) => compactActionTitle(analysis.text))
    .find(Boolean)

  return actionTitle ?? null
}

function collectTitleRequests(messages: TitleMessage[]): TitleRequest[] {
  const seen = new Set<string>()
  return [...messages]
    .sort((a, b) => a.timestampMs - b.timestampMs)
    .map((message) => ({ text: normalizeRequestText(message.text), timestampMs: message.timestampMs }))
    .filter((request) => {
      const key = request.text.toLowerCase()
      if (!request.text || seen.has(key) || !isSubstantive(request.text)) return false
      seen.add(key)
      return true
    })
}

function analyzeRequest(request: TitleRequest): RequestAnalysis {
  const topics = TOPIC_DEFINITIONS.filter((definition) => definition.patterns.some((pattern) => pattern.test(request.text))).map(
    (definition) => ({
      definition,
      score: definition.score ?? 1
    })
  )

  const exactTitles = EXACT_TITLES.filter((exact) => exact.pattern.test(request.text))

  return { ...request, exactTitles, topics }
}

function rankGroups(analyses: RequestAnalysis[]): GroupScore[] {
  const groups = new Map<TopicGroup, GroupScore>()

  for (const analysis of analyses) {
    const topicGroups = new Set<TopicGroup>()

    for (const hit of analysis.topics) {
      topicGroups.add(hit.definition.group)

      const groupScore = ensureGroupScore(groups, hit.definition.group)
      groupScore.score += hit.score
      groupScore.latestMs = Math.max(groupScore.latestMs, analysis.timestampMs)

      const existingTopic = groupScore.topics.get(hit.definition.key)
      if (existingTopic) {
        existingTopic.score += hit.score
        existingTopic.latestMs = Math.max(existingTopic.latestMs, analysis.timestampMs)
      } else {
        groupScore.topics.set(hit.definition.key, {
          definition: hit.definition,
          score: hit.score,
          latestMs: analysis.timestampMs
        })
      }
    }

    for (const exact of analysis.exactTitles) {
      if (topicGroups.has(exact.group)) continue
      const groupScore = ensureGroupScore(groups, exact.group)
      groupScore.score += 1
      groupScore.latestMs = Math.max(groupScore.latestMs, analysis.timestampMs)
    }
  }

  const ranked = [...groups.values()].sort((a, b) => b.score - a.score || b.latestMs - a.latestMs)
  const meaningful = ranked.filter((group) => group.score >= 1)
  return meaningful.length > 0 ? meaningful : ranked
}

function ensureGroupScore(groups: Map<TopicGroup, GroupScore>, group: TopicGroup): GroupScore {
  const existing = groups.get(group)
  if (existing) return existing

  const groupScore = {
    group,
    score: 0,
    latestMs: 0,
    topics: new Map()
  }
  groups.set(group, groupScore)
  return groupScore
}

function choosePrimaryGroup(groups: GroupScore[]): GroupScore | null {
  if (groups.length === 1) return groups[0]

  const [top, second] = groups
  const total = groups.reduce((sum, group) => sum + group.score, 0)

  if (groups.length >= 3 && (top.score < total * 0.7 || top.score < second.score * 2.5)) {
    return null
  }

  if (top.score >= total * 0.64 && top.score >= second.score * 1.75) {
    return top
  }

  return null
}

function focusedGroupTitle(group: GroupScore, analyses: RequestAnalysis[]): string {
  const exactScores = new Map<string, { title: string; score: number; latestMs: number }>()

  for (const analysis of analyses) {
    for (const exact of analysis.exactTitles) {
      if (exact.group !== group.group) continue
      const existing = exactScores.get(exact.title)
      if (existing) {
        existing.score += 1
        existing.latestMs = Math.max(existing.latestMs, analysis.timestampMs)
      } else {
        exactScores.set(exact.title, { title: exact.title, score: 1, latestMs: analysis.timestampMs })
      }
    }
  }

  const bestExact = [...exactScores.values()].sort((a, b) => b.score - a.score || b.latestMs - a.latestMs)[0]
  if (bestExact && bestExact.score >= Math.max(1, group.score * 0.6)) return bestExact.title

  const bestTopic = [...group.topics.values()].sort((a, b) => b.score - a.score || b.latestMs - a.latestMs)[0]
  return bestTopic?.definition.title ?? GENERAL_IMPROVEMENTS_TITLE
}

function normalizeRequestText(text: string): string {
  let value = text
    .replace(/\r/g, '')
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/gi, ' ')
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
  if (/^i\s+(?:do not|don'?t)\s+want\s+to\s+address\b/.test(normalized)) return false
  if (/^once\s+i\s+(?:am|'m)\s+done\b/.test(normalized)) return false
  if (/^okay[, ]+(let'?s|we can|proceed|continue)\b/.test(normalized) && normalized.length < 90) return false
  if (normalized.includes('active file:') && normalized.includes('open tabs:') && !normalized.includes('my request')) {
    return false
  }
  // Codex's /start and /save skills expand into long delegated-worker prompts
  // sent as plain user messages ("You are the single delegated worker…", "Run
  // the save skill…"). They are orchestration scaffolding, not the user's
  // request, and otherwise drown out the real intent during inference. (IDE
  // context blocks are handled above — they embed the real "My request" text.)
  if (/^you are (?:the|a)\s+(?:single|sole|only|mandatory|delegated)\b/.test(normalized)) return false
  if (/^(?:run|execute|use|perform)\s+the\s+`?\/?(?:start|save)\b/.test(normalized)) return false
  if (/^run\s+the\s+start[- ]session\b/.test(normalized)) return false

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

  if (!cleaned || isWeakTitle(cleaned) || !ACTION_WORDS.test(cleaned)) return null
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

function readableRawSessionTitle(rawTitle: string | null): string | null {
  const title = readableTitle(titleCandidate(rawTitle), null)
  return title && !isWeakTitle(title) ? title : null
}

function isWeakTitle(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const lower = normalized.toLowerCase()
  if (!normalized) return true
  if (/^[{[]/.test(normalized)) return true
  if (/[,;:]$/.test(normalized)) return true
  if (/^(once|when|while|because|since|if)\b/.test(lower)) return true
  if (/^(ok|okay|thanks|thank you)\b/.test(lower)) return true
  if (/^i\s+(?:do not|don'?t)\s+(?:want|need|like|think|address)\b/.test(lower)) return true
  if (/^i\s+(?:am|'m)\s+(?:not sure|unable|done|happy)\b/.test(lower)) return true
  if (/\bimplementing various fixes\b/i.test(normalized)) return true
  return false
}

function capitalizeFirst(text: string): string {
  if (!text) return text
  return `${text[0].toUpperCase()}${text.slice(1)}`
}
