import type { JSX } from 'react'
import type { AssistantSessionHistoryEntry } from '@shared/sessions'
import { CopyableCodeBlock, HistoryMarkdown } from './history-markdown'

// One rendered transcript turn. The History panel and the agent transcript view show
// the same thing — a Claude/Codex transcript — so they render it through this one
// component rather than each spelling out the markup. The class names are
// load-bearing beyond styling: History's Ctrl+F search collects ranges by walking
// the DOM and skips `.history-entry-meta` and `.md-code-toolbar` so role tags,
// timestamps and Copy buttons never match. Keep them.

export function historySpeakerLabel(entry: AssistantSessionHistoryEntry): string | null {
  if (entry.role !== 'tool') return null
  return entry.label || 'Tool'
}

export function historyRoleCode(role: AssistantSessionHistoryEntry['role']): string {
  if (role === 'user') return 'YOU'
  if (role === 'assistant') return 'AGT'
  if (role === 'tool') return 'RUN'
  return 'CTX'
}

export function historyRawCodeLanguage(text: string): string | null {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : null
}

export function formatEntryTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

export function HistoryEntryArticle({ entry }: { entry: AssistantSessionHistoryEntry }): JSX.Element {
  const speaker = historySpeakerLabel(entry)

  return (
    <article className="history-entry" data-role={entry.role}>
      <div className="history-entry-content">
        <div className="history-entry-meta">
          <span className="history-entry-marker">
            <span className="history-entry-tag">{historyRoleCode(entry.role)}</span>
            {entry.timestamp ? <time>{formatEntryTimestamp(entry.timestamp)}</time> : null}
          </span>
          {speaker ? <span className="history-entry-speaker">{speaker}</span> : null}
        </div>
        {entry.role === 'user' || entry.role === 'assistant' ? (
          <HistoryMarkdown text={entry.text} copyCodeBlocks />
        ) : (
          <CopyableCodeBlock
            code={entry.text}
            language={historyRawCodeLanguage(entry.text)}
            className="history-raw-code"
          />
        )}
      </div>
    </article>
  )
}
