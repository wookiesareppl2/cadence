// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PLATFORM_CONFIG } from '../src/shared/platform'
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

// Typed against the real prop shape rather than a bag of unknowns: a misspelled
// override should fail to compile here, not be silently dropped on the floor.
type SidebarProps = ComponentProps<typeof SessionHistorySidebar>

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
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

const caret = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /other ways to resume/i }) as HTMLButtonElement

const resumeButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /resume this session in a terminal/i }) as HTMLButtonElement

describe('the primary Resume button', () => {
  it('resumes in the safe mode, never the bypass one', async () => {
    const { onResume, user } = renderSidebar()
    await user.click(resumeButton())
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

  // Two independent guards stop the menu opening with nothing to resume: the caret
  // is disabled, and the menu is not rendered while Resume is unavailable. Asserted
  // separately on purpose — testing only the outcome passed even with the `disabled`
  // attribute removed, which is the visible regression: a caret that looks usable
  // and silently does nothing.
  it('disables the caret when there is no session to resume', () => {
    renderSidebar({ session: null })
    expect(caret().disabled).toBe(true)
    expect(resumeButton().disabled).toBe(true)
  })

  it('still refuses to open the menu if that disabled state is ever bypassed', async () => {
    const { onResume, user } = renderSidebar({ session: null })
    await user.click(caret())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(onResume).not.toHaveBeenCalled()
  })

  // The portalled menu sits outside `.app-shell`, where `--accent` is defined, so it
  // has to carry its own. The value matters, not just its presence: a shared default
  // would resolve — and paint Claude's orange focus ring on a Codex menu.
  it.each([
    ['claude' as const],
    ['codex' as const]
  ])('carries %s own accent into the portalled menu', async (platform) => {
    const { user } = renderSidebar({ platform })
    await user.click(caret())
    expect(screen.getByRole('menu').style.getPropertyValue('--accent')).toBe(
      PLATFORM_CONFIG[platform].accent
    )
  })

  it('gives the two platforms visibly different accents, or the check above proves nothing', () => {
    expect(PLATFORM_CONFIG.claude.accent).not.toBe(PLATFORM_CONFIG.codex.accent)
  })
})
