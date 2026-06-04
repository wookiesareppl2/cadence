import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HistoryMarkdown } from '../src/renderer/src/components/history-markdown'

function render(text: string): string {
  return renderToStaticMarkup(HistoryMarkdown({ text }))
}

describe('history markdown rendering', () => {
  it('renders headings, bold, and inline code', () => {
    const html = render('## Setup Gates\nThe **tree** is `clean`.')
    expect(html).toContain('md-h2')
    expect(html).toContain('Setup Gates')
    expect(html).toContain('<strong>tree</strong>')
    expect(html).toContain('<code class="md-inline-code">clean</code>')
  })

  it('renders unordered and ordered lists', () => {
    expect(render('- one\n- two')).toContain('<ul class="md-list">')
    const ordered = render('1. first\n2. second')
    expect(ordered).toContain('<ol class="md-list">')
    expect(ordered).toContain('second')
  })

  it('renders fenced code blocks without reformatting their contents', () => {
    const html = render('```\nconst x = **not bold**\n```')
    expect(html).toContain('pre class="md-code"')
    expect(html).toContain('const x = **not bold**')
    expect(html).not.toContain('<strong>')
  })

  it('renders GFM tables', () => {
    const html = render('| Fix | Result |\n| --- | --- |\n| A | done |')
    expect(html).toContain('<table class="md-table">')
    expect(html).toContain('<th>Fix</th>')
    expect(html).toContain('<td>done</td>')
  })

  it('shows links as non-navigating styled text with the url as title', () => {
    const html = render('See [the docs](https://example.com) for detail.')
    expect(html).toContain('md-link')
    expect(html).toContain('title="https://example.com"')
    expect(html).toContain('the docs')
    expect(html).not.toContain('href=')
  })

  it('renders blockquotes and horizontal rules', () => {
    expect(render('> quoted line')).toContain('<blockquote class="md-quote">')
    expect(render('text\n\n---\n\nmore')).toContain('<hr class="md-hr"/>')
  })

  it('does not throw on empty or plain input', () => {
    expect(render('')).toBe('<div class="history-md"></div>')
    expect(render('just a plain sentence')).toContain('just a plain sentence')
  })
})
