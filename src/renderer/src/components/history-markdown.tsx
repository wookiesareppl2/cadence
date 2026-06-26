import { useCallback, useEffect, useRef, useState } from 'react'
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
const FENCE = /^\s*```([^\s`]*)?/
const INDENTED_CODE = /^(?: {4}|\t)(.*)$/
const STANDALONE_INLINE_CODE = /^`([^`]+)`$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/

export function HistoryMarkdown({
  text,
  copyCodeBlocks = false
}: {
  text: string
  copyCodeBlocks?: boolean
}): JSX.Element {
  return <div className="history-md">{renderBlocks(text.replace(/\r/g, ''), { copyCodeBlocks })}</div>
}

export function CopyableCodeBlock({
  code,
  language = null,
  className = ''
}: {
  code: string
  language?: string | null
  className?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const copy = useCallback((): void => {
    try {
      const clipboard = window.dashboard?.clipboard
      if (clipboard?.writeText) clipboard.writeText(code)
      else void navigator.clipboard?.writeText(code).catch(() => undefined)
    } catch {
      void navigator.clipboard?.writeText(code).catch(() => undefined)
    }

    setCopied(true)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      setCopied(false)
      timerRef.current = null
    }, 1400)
  }, [code])

  const classes = ['md-code-block', className].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      <div className="md-code-toolbar">
        {language ? (
          <span className="md-code-language">{language}</span>
        ) : (
          <span className="md-code-language" aria-hidden="true" />
        )}
        <button type="button" className="md-code-copy" onClick={copy} title="Copy code" aria-label="Copy code block">
          <CopyIcon />
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre className="md-code">
        <code>{code}</code>
      </pre>
    </div>
  )
}

type RenderOptions = {
  copyCodeBlocks: boolean
}

function renderBlocks(text: string, options: RenderOptions): ReactNode[] {
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

    const fence = line.match(FENCE)
    if (fence) {
      const code: string[] = []
      const language = fence[1]?.trim() || null
      i += 1
      while (i < lines.length && !FENCE.test(lines[i])) code.push(lines[i++])
      if (i < lines.length) i += 1 // closing fence
      blocks.push(renderCodeBlock(code.join('\n'), language, key++, options))
      continue
    }

    if (INDENTED_CODE.test(line)) {
      const code: string[] = []
      while (i < lines.length) {
        const current = lines[i]
        if (!current.trim()) {
          code.push('')
          i += 1
          continue
        }

        const indented = current.match(INDENTED_CODE)
        if (!indented) break
        code.push(indented[1])
        i += 1
      }

      while (code.length > 0 && code[code.length - 1] === '') code.pop()
      blocks.push(renderCodeBlock(code.join('\n'), null, key++, options))
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
    const paragraphText = paragraph.join('\n')
    const standaloneCode = paragraphText.trim().match(STANDALONE_INLINE_CODE)
    if (standaloneCode) {
      blocks.push(renderCodeBlock(standaloneCode[1], null, key++, options))
      continue
    }

    blocks.push(
      <p key={key++} className="md-p">
        {renderInline(paragraphText)}
      </p>
    )
  }

  return blocks
}

function renderCodeBlock(code: string, language: string | null, key: number, options: RenderOptions): ReactNode {
  if (!options.copyCodeBlocks) {
    return (
      <pre key={key} className="md-code">
        <code>{code}</code>
      </pre>
    )
  }

  return <CopyableCodeBlock key={key} code={code} language={language} />
}

function CopyIcon(): JSX.Element {
  return (
    <svg className="md-code-copy-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5" y="4" width="7" height="9" rx="1.2" />
      <path d="M4 11H3.8A1.8 1.8 0 0 1 2 9.2V3.8A1.8 1.8 0 0 1 3.8 2H9.2A1.8 1.8 0 0 1 11 3.8V4" />
    </svg>
  )
}

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    INDENTED_CODE.test(line) ||
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
