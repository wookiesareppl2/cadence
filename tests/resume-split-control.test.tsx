// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WINDOWS_ORIGIN, type AssistantSession } from '../src/shared/sessions'
import { SessionHistorySidebar } from '../src/renderer/src/components/session-browser/session-panels'

// The Resume split control decides, per click, whether a past session is rejoined
// normally or in the CLI's bypass-every-permission mode. That decision is one
// literal argument in JSX with no type to protect it — passing the wrong one runs
// an agent with every guard off — and the whole control had shipped reviewed only
// by eye. These are the wiring assertions that eye-review had to make by hand.

afterEach(cleanup)

// Fully typed, deliberately not cast: if AssistantSession gains a required field,
// this fixture should fail to compile rather than quietly drift from the real shape.
const session: AssistantSession = {
  id: 'sess-1',
  platform: 'claude',
  projectId: 'p1',
  title: 'A past session',
  rawTitle: null,
  inferredTitle: null,
  generatedTitle: null,
  titleSource: 'raw',
  titleStatus: null,
  titleUpdatedAt: null,
  project: 'Fixture',
  projectPath: 'C:/fixture',
  branch: null,
  origin: WINDOWS_ORIGIN,
  usageLabel: null,
  status: 'idle',
  age: '1h',
  updatedAt: null,
  contextTokens: null,
  contextWindow: null,
  model: null
}

function renderSidebar(overrides: Record<string, unknown> = {}) {
  const onResume = vi.fn()
  render(
    <SessionHistorySidebar
      session={session}
      historyState={{ history: null, loading: false, error: null }}
      open
      width={380}
      onToggle={() => undefined}
      onResizeStart={() => undefined}
      onShowDetails={() => undefined}
      platform="claude"
      onResume={onResume}
      {...overrides}
    />
  )
  return { onResume, user: userEvent.setup() }
}

const caret = (): HTMLElement => screen.getByRole('button', { name: /other ways to resume/i })

describe('the primary Resume button', () => {
  it('resumes in the safe mode, never the bypass one', async () => {
    const { onResume, user } = renderSidebar()
    await user.click(screen.getByRole('button', { name: /resume this session in a terminal/i }))
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledWith(false)
  })
})

describe('the caret menu', () => {
  it('stays shut until the caret is used', () => {
    renderSidebar()
    expect(screen.queryByRole('menu')).toBeNull()
    expect(caret()).toHaveProperty('ariaExpanded', 'false')
  })

  it('offers the safe resume and the CLI-named bypass mode', async () => {
    const { user } = renderSidebar()
    await user.click(caret())
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(items).toEqual(['Resume', 'Resume (skip perms)'])
  })

  it('uses the other CLI own word for the mode', async () => {
    const { user } = renderSidebar({ platform: 'codex' })
    await user.click(caret())
    expect(screen.getByRole('menuitem', { name: /resume \(yolo\)/i })).toBeDefined()
  })

  // The bug this file exists for. The menu is portalled to <body>, so it is outside
  // the trigger's subtree; if the outside-click handler does not recognise it, the
  // mousedown half of a click unmounts the row before the click half lands and the
  // resume silently never runs. user-event fires the real pointer sequence, so this
  // fails against that mistake.
  it('still fires when a row is clicked, mousedown and all', async () => {
    const { onResume, user } = renderSidebar()
    await user.click(caret())
    await user.click(screen.getByRole('menuitem', { name: 'Resume' }))
    expect(onResume).toHaveBeenCalledWith(false)
  })

  it('asks for the bypass mode only from the bypass row', async () => {
    const { onResume, user } = renderSidebar()
    await user.click(caret())
    await user.click(screen.getByRole('menuitem', { name: /skip perms/i }))
    expect(onResume).toHaveBeenCalledTimes(1)
    expect(onResume).toHaveBeenCalledWith(true)
  })

  it('closes after a choice, so the next Resume starts from the safe default', async () => {
    const { user } = renderSidebar()
    await user.click(caret())
    await user.click(screen.getByRole('menuitem', { name: /skip perms/i }))
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('closes on Escape and on a click outside it', async () => {
    const { user } = renderSidebar()
    await user.click(caret())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()

    await user.click(caret())
    expect(screen.getByRole('menu')).toBeDefined()
    await user.click(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('cannot be opened when there is no session to resume', async () => {
    const { user } = renderSidebar({ session: null })
    await user.click(caret()).catch(() => undefined)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('carries the accent in, so the portalled rows keep a focus ring', async () => {
    const { user } = renderSidebar()
    await user.click(caret())
    expect(screen.getByRole('menu').style.getPropertyValue('--accent')).toBeTruthy()
  })
})
