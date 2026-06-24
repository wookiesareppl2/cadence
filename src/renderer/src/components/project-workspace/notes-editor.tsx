import { useState } from 'react'
import type { JSX } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import './notes-editor.css'

// Notes are stored as HTML produced by this editor. Legacy plain-text notes are
// converted to paragraphs (preserving line breaks) so they load cleanly; content
// that already looks like editor HTML passes straight through.
function storedNotesToHtml(stored: string): string {
  if (!stored) return ''
  if (/<(p|h[1-6]|ul|ol|li|blockquote|pre|code|strong|em|br)\b/i.test(stored)) return stored
  const escaped = stored.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return escaped
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

export function NotesEditor({
  initialHtml,
  onChange
}: {
  initialHtml: string
  onChange: (html: string) => void
}): JSX.Element | null {
  // Re-render the toolbar when the selection/formatting context changes.
  const [, setTick] = useState(0)
  const rerender = (): void => setTick((tick) => tick + 1)

  const editor = useEditor({
    extensions: [StarterKit],
    content: storedNotesToHtml(initialHtml),
    immediatelyRender: false,
    editorProps: { attributes: { class: 'notes-editor-content', 'aria-label': 'Project notes' } },
    onUpdate: ({ editor }) => {
      // Empty editor serializes to "<p></p>"; persist "" so the entry can prune.
      onChange(editor.isEmpty ? '' : editor.getHTML())
      rerender()
    },
    onSelectionUpdate: rerender
  })

  if (!editor) return null

  return (
    <div className="notes-editor">
      <NotesToolbar editor={editor} />
      <EditorContent editor={editor} className="notes-editor-scroll" />
    </div>
  )
}

function NotesToolbar({ editor }: { editor: Editor }): JSX.Element {
  const tool = (
    active: boolean,
    title: string,
    label: JSX.Element | string,
    run: () => void
  ): JSX.Element => (
    <button
      type="button"
      className={`notes-tool ${active ? 'active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      // Keep the editor selection while clicking the toolbar.
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      {label}
    </button>
  )

  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()

  return (
    <div className="notes-toolbar" role="toolbar" aria-label="Formatting">
      {tool(
        editor.isActive('bold'),
        'Bold',
        <span className="notes-text-icon notes-bold-icon" aria-hidden="true">
          B
        </span>,
        () => chain().toggleBold().run()
      )}
      {tool(
        editor.isActive('italic'),
        'Italic',
        <span className="notes-text-icon notes-italic-icon" aria-hidden="true">
          i
        </span>,
        () => chain().toggleItalic().run()
      )}
      <span className="notes-toolbar-sep" aria-hidden="true" />
      {tool(editor.isActive('heading', { level: 1 }), 'Heading', 'H1', () =>
        chain().toggleHeading({ level: 1 }).run()
      )}
      {tool(editor.isActive('heading', { level: 2 }), 'Sub-heading', 'H2', () =>
        chain().toggleHeading({ level: 2 }).run()
      )}
      {tool(editor.isActive('heading', { level: 3 }), 'Sub-heading (small)', 'H3', () =>
        chain().toggleHeading({ level: 3 }).run()
      )}
      <span className="notes-toolbar-sep" aria-hidden="true" />
      {tool(editor.isActive('bulletList'), 'Bulleted list', <BulletedListIcon />, () =>
        chain().toggleBulletList().run()
      )}
      {tool(editor.isActive('orderedList'), 'Numbered list', <NumberedListIcon />, () =>
        chain().toggleOrderedList().run()
      )}
      {tool(editor.isActive('blockquote'), 'Quote', <QuoteIcon />, () => chain().toggleBlockquote().run())}
      {tool(editor.isActive('codeBlock'), 'Code block', <CodeBlockIcon />, () => chain().toggleCodeBlock().run())}
    </div>
  )
}

function BulletedListIcon(): JSX.Element {
  return (
    <svg className="notes-format-icon notes-list-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <circle cx="4" cy="4" r="1.2" />
      <circle cx="4" cy="9" r="1.2" />
      <circle cx="4" cy="14" r="1.2" />
      <path d="M7.75 4h6.25" />
      <path d="M7.75 9h6.25" />
      <path d="M7.75 14h6.25" />
    </svg>
  )
}

function NumberedListIcon(): JSX.Element {
  return (
    <svg className="notes-format-icon notes-list-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <text x="1.3" y="6.15">1</text>
      <text x="1.3" y="11.15">2</text>
      <text x="1.3" y="16.15">3</text>
      <path d="M7.75 4h6.25" />
      <path d="M7.75 9h6.25" />
      <path d="M7.75 14h6.25" />
    </svg>
  )
}

function QuoteIcon(): JSX.Element {
  return (
    <svg className="notes-format-icon notes-quote-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d="M7.1 4.15c-1.95 1.3-2.95 2.8-2.95 4.5v4.15h4.2V8.7H6.15c.15-1.05.85-1.95 2.1-2.7z" />
      <path d="M13.45 4.15c-1.95 1.3-2.95 2.8-2.95 4.5v4.15h4.2V8.7h-2.2c.15-1.05.85-1.95 2.1-2.7z" />
    </svg>
  )
}

function CodeBlockIcon(): JSX.Element {
  return (
    <svg className="notes-format-icon notes-code-icon" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d="M7 5.2 3.6 9 7 12.8" />
      <path d="M11 5.2 14.4 9 11 12.8" />
    </svg>
  )
}
