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
      {tool(editor.isActive('bold'), 'Bold', <b>B</b>, () => chain().toggleBold().run())}
      {tool(editor.isActive('italic'), 'Italic', <i>I</i>, () => chain().toggleItalic().run())}
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
      {tool(editor.isActive('bulletList'), 'Bulleted list', '•', () => chain().toggleBulletList().run())}
      {tool(editor.isActive('orderedList'), 'Numbered list', '1.', () => chain().toggleOrderedList().run())}
      {tool(editor.isActive('blockquote'), 'Quote', '❝', () => chain().toggleBlockquote().run())}
      {tool(editor.isActive('codeBlock'), 'Code block', '〈〉', () => chain().toggleCodeBlock().run())}
    </div>
  )
}
