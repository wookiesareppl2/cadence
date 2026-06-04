export type HistoryTextOptions = {
  commandPrefix?: '$' | '/'
}

const HISTORY_TEXT_LIMIT = 6_000
const DROP_BLOCK_TAGS = [
  'environment_context',
  'command-message',
  'command-name',
  'local-command-stdout',
  'system-reminder'
]

export function cleanHistoryText(text: string | null, options: HistoryTextOptions = {}): string | null {
  if (!text) return null

  const commandPrefix = options.commandPrefix ?? '/'
  let value = text.replace(/\r/g, '')

  const requestMarker = value.match(/##\s*My request for (?:Codex|Claude(?: Code)?|ChatGPT):\s*([\s\S]*)/i)
  if (requestMarker) value = requestMarker[1]

  const commandNames = extractCommandNames(value)
  const skillNames = extractSkillNames(value)

  value = stripDropBlocks(value)
    .replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  if (!value) {
    return commandFallback(commandNames, commandPrefix) ?? commandFallback(skillNames, commandPrefix)
  }

  return value.length > HISTORY_TEXT_LIMIT ? `${value.slice(0, HISTORY_TEXT_LIMIT - 3)}...` : value
}

function extractCommandNames(text: string): string[] {
  return [...text.matchAll(/<command-name\b[^>]*>([\s\S]*?)<\/command-name>/gi)]
    .map((match) => cleanInline(match[1]))
    .filter(Boolean)
}

function extractSkillNames(text: string): string[] {
  return [...text.matchAll(/<skill\b[^>]*>([\s\S]*?)<\/skill>/gi)]
    .map((match) => match[1].match(/<name\b[^>]*>\s*([^<]+?)\s*<\/name>/i)?.[1] ?? null)
    .map(cleanInline)
    .filter(Boolean)
}

function stripDropBlocks(text: string): string {
  return DROP_BLOCK_TAGS.reduce((value, tag) => {
    const block = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
    return value.replace(block, ' ')
  }, text)
}

function commandFallback(names: string[], prefix: '$' | '/'): string | null {
  const command = names
    .map((name) => name.split(/\s+/)[0]?.replace(/^[$/]+/, '') ?? '')
    .find((name) => /^[a-z][\w-]*$/i.test(name))

  return command ? `${prefix}${command}` : null
}

function cleanInline(value: string | null): string {
  return (value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}
