# Cadence — Design System

The single source of truth for visual + interaction conventions. **Read this before
building or restyling any UI element, and reuse the existing tokens/classes instead
of reinventing them.** If a new pattern is genuinely needed, add it here.

All values are CSS custom properties defined in `src/renderer/src/styles.css` (`:root`).
Never hard-code a hex colour or a raw motion duration — use a token.

## Tokens

### Surfaces & borders
- `--surface-0` … `--surface-4` — background ramp, darkest → lightest. `0` = app/inputs background, `1` = panels, `2` = hover/raised, `3`/`4` = elevated/active.
- `--border` (default), `--border-subtle` (quieter dividers).

### Text
- `--text-1` (primary), `--text-2` (secondary), `--text-3` (muted/labels).

### Accent & status
- `--accent`, `--accent-dim`, `--accent-hover` — set **per platform** on `.app-shell` (Claude vs Codex), so never hard-code an accent.
- `--caution` (warnings/destructive), `--success`.

### Type & motion
- `--font-ui` (prose/labels), `--font-mono` (commands, counts, glyph icons).
- `--ease-out-expo`; durations `--motion-panel` (220ms), `--motion-sidebar` (180ms). Respect `prefers-reduced-motion` (handled globally).

## Collapsible panels (Projects & Sessions, Files, History, Notes & Tasks)

These MUST look and behave identically regardless of dock edge.

- **Toggle glyph:** a single filled-triangle family pointing toward the dock edge when open, inward when collapsed: top `▴`/`▾`, bottom `▾`/`▴`, left `◂`/`▸`, right `▸`/`◂`. No other chevron families.
- **Toggle icon style:** `--font-mono`, **15px**, colour `--text-2`, **no box** (no border/background). Use the shared `.panel-collapse-toggle` class for header toggles.
- **Global panel controls:** `Collapse all` / `Expand all` live in the titlebar as compact text actions. They apply only to the active platform and set Projects & Sessions, Files, History, and Notes & Tasks together.
- **Hover model (matches the History panel):**
  - *Expanded* → only the triangle/chevron whitens to `--text-1`. No section/background highlight.
  - *Collapsed bar or rail* → the clickable region gets the **accent border**: `background: var(--surface-2); border-color: var(--accent);`. Use the element's real 1px border or the collapsed parent panel's border, not an inset box-shadow, so rounded corners render cleanly.
  - Differentiate states with the collapsed marker already on the element: `[aria-expanded="false"]` (header buttons) or the `.collapsed` class (accordion sections).
- **Collapsed sidebars** (Projects & Sessions/Files/History) become a 32px vertical rail: a chevron icon on top + a vertical `writing-mode: vertical-rl` label.
- **Open panel resize:** Projects & Sessions, Files, and History expose an invisible 8px vertical drag handle on their inner edge; Notes & Tasks exposes the same 8px handle on its top edge. Handles use the shared `.panel-resize-handle` classes and persist size per active platform without changing the 32px collapsed rail. **The visible cue is a hairline, never a fill:** the 8px hit area stays invisible, and on hover/drag a **2px accent line** (a `::before`) appears along the handle's active edge — inset from its ends by `--radius-panel` so it never pokes past a rounded `.panel` corner. Keep it **easy on the eyes**: the line is soft on hover (`opacity: 0.4`, since incidental mouse passes shouldn't flash a bright line) and only brightens while actually dragging (`.resizing`, `opacity: 0.85`) — never a solid full-opacity accent. Do not reintroduce the old full-width accent *wash* — a thin line is the house style for every resize affordance.
- **Split resize (within a sidebar):** the Projects list and Sessions list inside the Projects & Sessions sidebar are split by a draggable horizontal divider (`.project-session-divider`). Same hairline treatment, but **in normal flow** rather than an absolute edge handle: a generous 8px grab zone straddling the line via negative margins (`cursor: row-resize`, `bottom` resize edge — drag down grows Projects); at rest the Projects list's 1px `border-bottom` is the only cue, and on hover/drag a centered 2px accent line (`::before`) sharpens in over it. The Projects list height is driven by `--project-list-height` and persisted per platform under the `projectList` size key (default 260px, so several projects are always visible); a `max-height: calc(100% - …)` always reserves room for Sessions. Use this in-flow divider pattern whenever splitting two stacked lists inside one panel.

## Buttons

- **Icon/action buttons** (rename, refresh, +file): ~24px, transparent border at rest, hover = `background: var(--surface-3); border-color: var(--surface-4); color: var(--text-1)`.
- **Primary/accent buttons** ("+ Add"): `border: 1px solid var(--accent); color: var(--accent)`, hover fills `background: var(--accent); color: var(--surface-0)`.
- **Focus:** `outline: 1px solid var(--accent); outline-offset: 2px` on `:focus-visible`.

## Action icons (use these glyphs consistently)

`✕` close/cancel · `✓` confirm/done · `✎` rename/edit · `🗑` delete · `⋯` more/menu · `⟳` refresh · `+ <label>` create.

For dense toolbars where a text glyph is ambiguous, use compact 14-16px semantic
line icons that inherit `currentColor` and sit in the same action button frame.
Notes rich-text controls use a 24px button frame with a 14px optical glyph box;
list controls use the standard bullets/numbers-plus-lines form; quote icons must
read at toolbar size without overpowering adjacent text-format buttons.

### SVG line-icon recipe (canonical method — use this for every new/improved icon)

This is the single approach for any meaningful icon in the app. When asked to add
or fix an icon, follow these steps exactly so it's never a one-off:

1. **Inline SVG, not a font symbol.** Author a small React component returning an
   `<svg>`. **Never** use a decorative Unicode/emoji symbol (`⛁`, `🧠`, `📁`…) for
   a meaningful icon — they render inconsistently across fonts and go illegible at
   small sizes. (Plain ASCII that reads cleanly as mono text, like a literal `+`,
   is the only glyph exception.)
2. **Canvas:** `viewBox="0 0 16 16"`, plus `aria-hidden="true"` and
   `focusable="false"` (the button's label/`title` carries the meaning).
3. **Stroke, don't fill:** draw outlines with `fill: none; stroke: currentColor;
   stroke-width: 1.35; stroke-linecap: round; stroke-linejoin: round`. Using
   `currentColor` is what makes the icon track its button's hover/active colour for
   free — never hard-code a colour.
4. **Reuse a shared size class, don't inline styles:** `.files-action-icon` (15px,
   panel toolbars) or `.titlebar-action-icon` (14px, titlebar actions). Both define
   the stroke rules above; a new context gets one matching `*-action-icon` class,
   not bespoke styling.
5. **Keep the geometry simple and monochrome** — a few stroked paths that read at
   14-16px. Match the stroke weight/size of neighbouring icons.

Reference implementations to copy: `NewFileIcon` / `NewFolderIcon` / `RefreshIcon`
in `file-tree-panel.tsx`, and `MemoryIcon` / `CommandsIcon` in `App.tsx`.

## Destructive actions

Use a **two-step inline confirm**, not a blocking dialog: the `🗑` swaps to `Delete?` with a `✓` (danger, `--caution`) and `✕` (cancel). The confirm stays visible after the row is no longer hovered. Heavier modal confirms (`.files-confirm`) are only for higher-stakes deletes (e.g. files), and WSL deletes must warn they are permanent.

## Overlays

- **Modals** (`*-modal-backdrop` + dialog): `position: fixed; inset: 46px 0 0 0` (below the titlebar), centered, `rgba(0,0,0,0.5)` backdrop, dialog on `--surface-1` with a soft shadow; close on backdrop click + Esc.
- **Tooltips/menus/context menus**: `position: fixed`, positioned in JS from a rect (so they escape scroll clipping); dismiss on Esc / outside-click / scroll.

### Repository import / account modals

Use the `github-import-*` modal family as the canonical pattern for account-backed
project import flows (GitHub OAuth, repository picking, context-vault sync). It is
a compact operational dialog, not a setup wizard or landing page.

- **Mode switch:** use the same segmented-toggle model as File Preview modes:
  a two-segment control (`GitHub` / `Manual`) with shared border, `--surface-0`
  background, inactive `--text-3`, active `color-mix(... var(--accent) 16% ...)`,
  and `aria-pressed`.
- **Account state:** show sign-in state as a dense bordered row on `--surface-0`.
  Display the account/login and storage state as compact text; keep access tokens
  and credential details out of the renderer UI.
- **Device codes:** render OAuth device codes as a mono, high-contrast status row
  with a separate `Open` action. Do not place codes in helper copy or hidden text.
- **Repository pickers:** use a bordered scroll list of full-width row buttons.
  Rows show `owner/repo` plus a small mono visibility label (`public`/`private`);
  active rows use `border-color: var(--accent)` and hover uses `--surface-2`.
- **Vault state:** show the resolved private vault repo as a quiet mono fact row,
  not as another card. Manual fallback may expose a vault URL field; OAuth mode
  must prefer the managed private `cadence-context-vault` repo.
- **Security messaging:** UI may show high-level states (`encrypted`, `memory`,
  `private`) but must not display tokens, raw auth headers, or decrypted context.

## Splash / loading screen

Shown on launch until the active platform's first project scan resolves, then faded
out. Use the `.splash` class (full-shell overlay on `--surface-0`, `z-index: 50`,
`-webkit-app-region: drag` so the frameless window stays movable). Centered wordmark
(`--font-ui`, 22px, `--text-1`), a muted `--font-mono` status line (`--text-3`), and a
thin indeterminate bar whose fill is `--accent` (so it matches the active platform).
Fade out with `--motion-panel`/`--ease-out-expo` via the `.splash-leaving` modifier;
keep it mounted through the fade, then unmount. A minimum visible time avoids a flash
on a warm cache, and a max timeout guarantees it never traps the user.

## Segmented toggle (e.g. Auto-follow / Pinned)

A two-option pill for picking one of a small set of mutually-exclusive modes (the
File Preview "Auto-follow" vs "Pinned" update mode). Use `.files-preview-mode-toggle`
as the model: an `inline-flex` group with a `1px solid var(--border)` outline,
`6px` radius, `--surface-0` background, and `overflow: hidden` so the segments share
one rounded frame.
- **Segments:** borderless 24px buttons, `--text-3`, 11px; a `1px solid var(--border)`
  divider only *between* segments (`button + button`).
- **Hover (inactive segment):** `background: var(--surface-2); color: var(--text-1)`.
- **Active segment:** `background: color-mix(in srgb, var(--accent) 16%, var(--surface-1));
  color: var(--accent); cursor: default` (and the same on hover — the active one
  doesn't react). Mark it with `aria-pressed` and the `.active` class.
- Pair with a quiet `--font-mono` 10.5px status word when the mode has live state
  (e.g. `watching` / `polling`, switching to `--caution` on `watch error`).

## File preview line states

The File Preview header shows the filename as the primary mono label and a compact
mono breadcrumb directly underneath it (`project / folder / file`) so search-opened
files keep their location visible. Keep this as metadata, not a second toolbar:
`--text-3` for the path, `--text-2` for the current file segment, one line with
ellipsis overflow.

Two accent bands distinguish *why* a code line is marked, so don't reuse one for the other:
- **`.changed`** — a transient edit highlight in Auto-follow: faint band
  `color-mix(in srgb, var(--accent) 12%, var(--surface-0))` + accent line number.
- **`.target`** — the line a terminal `file.ts:42` jump landed on: a steadier band
  `color-mix(in srgb, var(--accent) 22%, var(--surface-0))` + accent line number, so
  the line stays identifiable after the scroll settles.

Loading vs empty must read as different states, never one ambiguous spinner: a brief
`Loading...` message while the file resolves, and a distinct empty line ("Select a
file from Files." / "Waiting for source edits…") when there's nothing to show. The
terminal deck mirrors this — `Loading project…` while a project is still resolving
vs. `Select a project to open a terminal` when none is picked.

## Terminals

- **Detached terminal window:** reuse `.detached-terminal-shell` (full window on
  `--surface-0`). Its own 44px `.detached-terminal-titlebar` on `--surface-1` is
  `-webkit-app-region: drag` with right padding reserved for the OS window controls;
  interactive children (`.detached-terminal-actions`) opt back out with
  `-webkit-app-region: no-drag`. Body is `.detached-terminal-body` holding the same
  `.terminal-panel` as the docked deck, so a detached window looks identical to its
  in-app counterpart.
- **Action buttons** use `.terminal-action` (26px, `--surface-2`, `--border`, hover →
  `border-color: var(--accent); color: var(--text-1)`) — the deck's Detach / + Add /
  Restart controls share this one class. The close button adds `.terminal-close` and
  uses the standard `✕` glyph.
- **Selection colour:** xterm renders its own canvas, so selection is set in the JS
  `TERMINAL_THEME`, not via a CSS token — this is the one sanctioned place to write a
  concrete colour. Use a **translucent accent** so selected text stays readable:
  `selectionBackground: rgba(224, 122, 95, 0.40)` (active) / `…0.26` (inactive). That
  RGB is `--accent`; keep them in step if the accent changes.
- **Cursor:** use a static 1px bar cursor in a muted foreground colour, not an
  accent block cursor. Codex/Claude status lines redraw in place, and a block cursor
  reads as flickering orange artifacts while those lines animate.
- **Clickable `file.ts:42` mentions:** real project files the agent prints become
  links (`pointerCursor` + `underline`) that open the File Preview scrolled to the
  line. Only paths that exist under the project root are linked — never style arbitrary
  path-like text as a link.
- **Background terminal locator:** when terminals are running in other sessions,
  the header count is a compact disclosure. It opens a fixed-position menu with one
  row **per session** (not per terminal — every terminal in a session jumps to the
  same place, so rows group by session via `backgroundTerminalSessions` and show a
  per-session terminal count): session title, `project · N terminals`, and cwd.
  Selecting a row jumps to that session. Keep it dense (`--font-mono` for
  paths/counts) and clipped with ellipsis, not a modal.
- **Copy:** copying is explicit only — there is deliberately no copy-on-select.
  `Ctrl+C` copies when text is selected and stays SIGINT when there is no
  selection; `Ctrl+Shift+C` / `Cmd+C` also copy an existing selection. A
  drag-selection is left uncopied because under the CLI fullscreen renderers it is
  a meaningful in-app gesture (e.g. select-to-delete); auto-copying it would
  silently clobber the user's clipboard.
- **Prompt newlines:** the embedded terminals intercept a modifier+Enter shortcut
  and inject bytes straight to the pty (bypassing xterm, which collapses modified
  Enter keys to a plain carriage return). Plain `Enter` always falls through as
  submit. The correct injection differs per CLI because they read input differently
  on native Windows:
  - **Codex** (`Shift+Enter`) is Rust/crossterm and reads console `INPUT_RECORD`
    key events through ConPTY, not raw VT bytes — so a raw LF (Ctrl+J), CSI-u
    (`\x1b[13;2u`), and bracketed paste all fail to register. The working sequence
    is win32-input-mode (`ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`): inject a
    Shift+Enter key-down then key-up, which ConPTY turns into a real Shift+Enter
    event that Codex maps to `insert_newline`.
  - **Claude Code** (`Ctrl+Enter`) is Node/Ink and reads a byte stream (libuv), so
    a raw escape sequence works where a win32-input key record would be collapsed
    to a bare CR. Inject `\x1b\r` (Meta+Enter / ESC+CR) — the same sequence Claude's
    `/terminal-setup` writes for a newline.

  Do not use xterm's `paste('\n')` helper for either (it normalizes LF to CR and
  submits).

## Context-usage gauge

The selected session shows a **context gauge** (`.context-gauge`) in the History
panel header and, in fuller form, in the session-details modal: a thin track plus a
mono `<used> / <window> · <pct>%` readout of how full the session's model context
window is (`session.contextTokens` / `session.contextWindow`, computed in the main
scanner from the latest turn's prompt size). It's a "context rot" early-warning — the
cue to `/save` and start a fresh session before quality degrades.

- **Two colours only (on-token):** green `--success` while healthy, amber `--caution`
  once past the user's wrap-up threshold (and at the `CONTEXT_CRITICAL` 80% auto-compact
  ceiling, where the readout also bolds and the label escalates to "Save now"). No new
  red token — `--caution` is the house warning/destructive colour.
- **Adjustable threshold:** the amber line is a global preference (default 60%, the
  Claude Code team's proactive-compaction guidance), stored in `localStorage` via
  `useContextWrapThreshold` and adjusted with the slider in the session-details modal.
  Edits sync to every gauge in the window through a manual `storage` event — never
  prop-drill it.
- Renders nothing when the transcript exposes no token usage (e.g. some Codex
  sessions), so it never shows a misleading empty gauge.

## History Transcript

- **Code blocks:** rendered user/assistant History code fences, indented code, and
  standalone inline-code commands use the same copyable code block frame. Tool and
  system payloads also render in that frame. The `Copy` action copies the source
  text through the app clipboard bridge so multi-line code keeps its authored
  structure independent of terminal wrapping.
- **Resume action:** the History panel header carries a primary, accent-filled
  `Resume` button (`.history-resume-button`, the accent-"active" pattern) — the main
  thing to do with a past session. It brings the session to the front and, only if
  the session has no terminal yet, opens one in its project folder / WSL distro and
  auto-runs the CLI resume command (`claude --resume <id>` / `codex resume <id>`) via
  the tab's one-shot `initialInput`. If the session already has a terminal, the
  resume command is sent into that terminal instead (no duplicate tab) — assuming it
  is at a shell prompt. Disabled for new/pending sessions (nothing to resume).
- **Search:** a `.history-search-bar` sits between the header and the feed (shown
  only when the loaded transcript has entries). It is Ctrl+F-style — the whole
  transcript stays visible and the matched **word** is highlighted in place. Matches
  are painted with the **CSS Custom Highlight API** (`CSS.highlights` +
  `::highlight(history-search)` / `::highlight(history-search-active)`), which colours
  ranges over the already-rendered markdown/code without mutating the DOM — so React
  is untouched and the markdown is never re-parsed on a keystroke. Every occurrence
  gets a soft accent wash; the active one is solid accent and scrolled into view.
  Prev/next (`Enter` / `Shift+Enter`, or the `.history-search-nav` buttons) step
  through occurrences in document order; the count shows `current / total` (or
  `No matches`). Range collection skips `.history-entry-meta` and `.md-code-toolbar`
  (so role tags, timestamps, and Copy buttons don't match). Resets on session change.

## Default toggle animation

For non-sidebar show/hide (vertical reveal), use the shared `.collapsible-content` + `.collapsible-inner` classes (grid-rows `0fr→1fr` with `--motion-panel`/`--ease-out-expo`), toggled via `data-open`. This is the Session Details accordion motion.

## Titlebar (responsive)

The 46px titlebar **flows** — it is `display: flex` with three regions: `.titlebar-brand`
(left), `.platform-switcher` (center), `.titlebar-right` (the action group). The brand
and right regions are `flex: 1 1 0; min-width: 0`, which keeps the switcher centered when
there's room. **Never pin titlebar regions with `position: absolute`** — that was the old
approach and it let the right group slide under the centered switcher. The only absolute
child is `.window-controls` (the OS min/max/close strip, pinned `right: 0`); the titlebar
reserves it with `padding-right: 146px` (3 × 46px strip + an 8px gap, matching the
inter-action gap, so the search bar doesn't butt against the minimize button's hover fill).

**Overlap is NOT automatic — it is prevented by keeping the right group narrow.** With the
equal-flex centering, if the right group's content is wider than its half of the bar it
overflows *leftward over the switcher* (justify-content is flex-end). Buttons don't shrink,
so the only way to keep it narrow is to collapse action labels to icons early enough. The
tiers below (media queries in `styles.css`, tracking the 1180px minimum window width) do
that:
- **≤1560px** — hide `.app-version`, and collapse **every** action to its icon at once:
  Connections / Memory / Commands (`.titlebar-action-label` hides) **and** Collapse all /
  Expand all (`.panel-layout-action-label` → `.panel-layout-action-icon`). Shrink the
  switcher `min-width`. Early + all-together so the group stays compact on common laptop
  widths (≈1366–1536) no matter how many actions exist.
- **≤1340px** — the search collapses to its glyph (see below); switcher `min-width` shrinks again.
- **≤1200px** — `.titlebar-brand-name` hides, leaving the logo only.

> **Rule when adding/removing a titlebar action (this is mandatory, not optional):** give
> it an SVG icon **and** a label in a `*-action-label` span so it collapses in the ≤1560
> tier; never add a label-only action. After adding one, re-check that the ≤1560 icon-mode
> group still clears the centered switcher at the 1180px minimum width. Adding an action
> without doing this is exactly what re-introduces the "Collapse all overlaps the switcher"
> bug.

**Collapsible label pattern:** an action carries both an SVG icon (per the line-icon recipe
above, reusing `.titlebar-action-icon`) and a `.titlebar-action-label` / `.panel-layout-action-label`
span; the tier toggles which shows. Use this instead of duplicating buttons.

**Compact search:** below 1340px the `.titlebar-search` collapses to just its glyph (the
input stays present at zero width; the container's `onClick` focuses it so the glyph is
tappable) and expands on `:focus-within`. When expanded it lifts to `position: absolute`
(`right: 146px`, clearing the window controls with the same 8px gap) so it overlays leftward
rather than shoving the other actions.
