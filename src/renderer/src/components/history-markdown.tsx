import type { JSX, ReactNode } from 'react'

// A small, dependency-free Markdown renderer scoped to what Claude/Codex
// transcripts actually contain: headings, emphasis, inline code, fenced code,
// bullet/numbered lists, blockquotes, tables, and horizontal rules. It favours
// readability over spec completeness — anything it doesn't recognise falls back
// to plain paragraph text, so it never throws on unexpected input.

const HEADING = /^(#{1,6})\s+(.*)$/
const UNORDERED = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+\.\s+(.*)$/
const BLOCKQUOTE = /^\s*>\s?(.*)$/
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/
const FENCE = /^\s*```/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

export function HistoryMarkdown({ text }: { text: string }): JSX.Element {
  return <div className="history-md">{renderBlocks(text.replace(/\r/g, ''))}</div>
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i += 1
      continue
    }

    if (FENCE.test(line)) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++])
      i += 1 // closing fence
      blocks.push(
        <pre key={key++} className="md-code">
          <code>{code.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const level = Math.min(heading[1].length, 6)
      blocks.push(
        <p key={key++} className={`md-heading md-h${level}`}>
          {renderInline(heading[2])}
        </p>
      )
      i += 1
      continue
    }

    if (HR.test(line)) {
      blocks.push(<hr key={key++} className="md-hr" />)
      i += 1
      continue
    }

    if (UNORDERED.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line) && !UNORDERED.test(line)
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(ordered ? ORDERED : UNORDERED)
        if (!item) break
        items.push(item[1])
        i += 1
      }
      const children = items.map((item, index) => <li key={index}>{renderInline(item)}</li>)
      blocks.push(
        ordered ? (
          <ol key={key++} className="md-list">{children}</ol>
        ) : (
          <ul key={key++} className="md-list">{children}</ul>
        )
      )
      continue
    }

    if (BLOCKQUOTE.test(line)) {
      const quote: string[] = []
      while (i < lines.length && BLOCKQUOTE.test(lines[i])) {
        quote.push(lines[i].match(BLOCKQUOTE)![1])
        i += 1
      }
      blocks.push(
        <blockquote key={key++} className="md-quote">
          {renderInline(quote.join(' '))}
        </blockquote>
      )
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const table: string[] = []
      while (i < lines.length && lines[i].includes('|')) table.push(lines[i++])
      blocks.push(renderTable(table, key++))
      continue
    }

    const paragraph: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(lines[i])
      i += 1
    }
    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(paragraph.join('\n'))}
      </p>
    )
  }

  return blocks
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line) ||
    BLOCKQUOTE.test(line)
  )
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function renderTable(rows: string[], key: number): ReactNode {
  const header = splitRow(rows[0])
  const body = rows.slice(2).map(splitRow)

  return (
    <div key={key} className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index}>{renderInline(cell)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((cell, cellIndex) => (
                <td key={cellIndex}>{renderInline(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const INLINE = /\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)/g

// Render a text run, splitting inline code spans out first (their contents are
// never reformatted), then resolving bold / italic / links in the remainder.
function renderInline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).flatMap<ReactNode>((part, partIndex) => {
    if (/^`[^`]+`$/.test(part)) {
      return [
        <code key={`c${partIndex}`} className="md-inline-code">
          {part.slice(1, -1)}
        </code>
      ]
    }
    return renderEmphasis(part, partIndex)
  })
}

function renderEmphasis(text: string, partIndex: number): ReactNode[] {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  INLINE.lastIndex = 0

  while ((match = INLINE.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index))
    const key = `${partIndex}:${match.index}`

    if (match[1] || match[2]) {
      nodes.push(<strong key={key}>{match[1] ?? match[2]}</strong>)
    } else if (match[3] || match[4]) {
      nodes.push(<em key={key}>{match[3] ?? match[4]}</em>)
    } else if (match[5]) {
      // Links are shown as styled, non-navigating text (the URL is the title) so
      // a stray click never yanks the read-only transcript view somewhere else.
      nodes.push(
        <span key={key} className="md-link" title={match[6]}>
          {match[5]}
        </span>
      )
    }

    lastIndex = INLINE.lastIndex
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return nodes
}
