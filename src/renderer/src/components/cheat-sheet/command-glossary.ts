// Turns an example invocation into a token-by-token explanation, so hovering
// "ls -Recurse -Filter *.ts" explains the base command and each flag. Driven by a
// finite flag glossary with sensible fallbacks, so it also works for commands the
// user adds later.
import type { CheatCommand, CommandShell } from './terminal-commands'

export type ExamplePart = { text: string; meaning: string }

// Splits on whitespace but keeps quoted strings ("first line") as one token.
const TOKEN_RE = /"[^"]*"|'[^']*'|\S+/g

const PS_VALUE_FLAGS = new Set([
  '-Filter', '-Tail', '-Name', '-First', '-Last', '-Count', '-Port', '-Scope',
  '-Format', '-Depth', '-Pattern', '-Path', '-OutFile', '-ItemType'
])

const PS_FLAGS: Record<string, string> = {
  '-Recurse': 'Include every subfolder, recursively.',
  '-Force': 'Include hidden/system items and skip prompts.',
  '-Filter': 'Keep only items matching this pattern.',
  '-Tail': 'Show only the last N lines.',
  '-Name': 'Use or return just the name.',
  '-First': 'Take only the first N items.',
  '-Last': 'Take only the last N items.',
  '-Descending': 'Sort in descending order (largest/newest first).',
  '-Line': 'Count lines (not words or characters).',
  '-ItemType': 'Create this type of item — File or Directory.',
  '-Count': 'Repeat this many times.',
  '-Port': 'Test this TCP port.',
  '-Scope': 'Apply the setting at this scope (e.g. CurrentUser).',
  '-Format': 'Format the output using this string.',
  '-AutoSize': 'Size table columns to fit their content.',
  '-Depth': 'Include this many levels of nested objects.',
  '-NoTypeInformation': 'Omit the #TYPE header row from the CSV.',
  '-Pattern': 'Search for this text or regex.',
  '-Path': 'Operate on these files or locations.',
  '-OutFile': 'Save the response to this file.',
  '-gt': 'Comparison: greater than.',
  '-lt': 'Comparison: less than.',
  '-eq': 'Comparison: equal to.'
}

const BASH_VALUE_FLAGS = new Set(['-n', '-c'])

const BASH_FLAGS: Record<string, string> = {
  '-l': 'Long listing format (details per item).',
  '-a': 'Show hidden entries too.',
  '-h': 'Human-readable sizes (KB/MB/GB).',
  '-la': 'Long format, including hidden entries.',
  '-lah': 'Long format, all entries, human-readable sizes.',
  '-r': 'Recurse into subdirectories.',
  '-R': 'Recurse into subdirectories.',
  '-rf': 'Recursive and forced — no prompts. Use with care.',
  '-rn': 'Recursive search, with line numbers.',
  '-p': 'Create parent directories as needed.',
  '-f': 'Force, or follow the file as it grows.',
  '-9': 'Signal 9 (SIGKILL) — force-kill immediately.',
  '-sh': 'Summarized total, human-readable.',
  '-s': 'Silent, or create a symbolic link.',
  '-xzf': 'Extract (x) a gzip (z) archive file (f).',
  '-czf': 'Create (c) a gzip (z) archive file (f).',
  '-n': 'Limit to this many lines.',
  '-c': 'This count/value.'
}

function baseMeaning(base: string, shell: CommandShell, commands: CheatCommand[]): string {
  const match = commands.find(
    (entry) => entry.shell === shell && (entry.name === base || (entry.fullName?.includes(base) ?? false))
  )
  return match ? match.description : `Run the ${base} command.`
}

export function explainExample(example: string, shell: CommandShell, commands: CheatCommand[]): ExamplePart[] {
  const tokens = example.match(TOKEN_RE)
  if (!tokens || tokens.length === 0) return []

  const [base, ...rest] = tokens
  const parts: ExamplePart[] = [{ text: base, meaning: baseMeaning(base, shell, commands) }]
  const flags = shell === 'powershell' ? PS_FLAGS : BASH_FLAGS
  const valueFlags = shell === 'powershell' ? PS_VALUE_FLAGS : BASH_VALUE_FLAGS

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]

    if (token === '|') {
      parts.push({ text: '|', meaning: 'Send this output into the next command.' })
    } else if (token === '>') {
      parts.push({ text: '>', meaning: 'Write the output to a file (overwrites).' })
    } else if (token === '>>') {
      parts.push({ text: '>>', meaning: 'Append the output to a file.' })
    } else if (token === '&&') {
      parts.push({ text: '&&', meaning: 'Run the next command only if this one succeeds.' })
    } else if (token.startsWith('-')) {
      const meaning = flags[token] ?? 'A command option/flag.'
      const next = rest[i + 1]
      if (valueFlags.has(token) && next && !next.startsWith('-')) {
        parts.push({ text: `${token} ${next}`, meaning })
        i += 1
      } else {
        parts.push({ text: token, meaning })
      }
    } else {
      parts.push({ text: token, meaning: 'A path, name, or value passed in.' })
    }
  }

  return parts
}
