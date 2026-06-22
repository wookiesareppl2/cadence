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

## Collapsible panels (Files, Session Detail, History, Notes & Tasks)

These MUST look and behave identically regardless of dock edge.

- **Toggle glyph:** a single filled-triangle family pointing toward the dock edge when open, inward when collapsed: top `▴`/`▾`, bottom `▾`/`▴`, left `◂`/`▸`, right `▸`/`◂`. No other chevron families.
- **Toggle icon style:** `--font-mono`, **15px**, colour `--text-2`, **no box** (no border/background). Use the shared `.panel-collapse-toggle` class for header toggles.
- **Global panel controls:** `Collapse all` / `Expand all` live in the titlebar as compact text actions. They apply only to the active platform and set Files, Session Detail, History, and Notes & Tasks together.
- **Hover model (matches the History panel):**
  - *Expanded* → only the triangle/chevron whitens to `--text-1`. No section/background highlight.
  - *Collapsed bar or rail* → the clickable region gets the **accent border**: `background: var(--surface-2); border-color: var(--accent);`. Use the element's real 1px border or the collapsed parent panel's border, not an inset box-shadow, so rounded corners render cleanly.
  - Differentiate states with the collapsed marker already on the element: `[aria-expanded="false"]` (header buttons) or the `.collapsed` class (accordion sections).
- **Collapsed sidebars** (Files/History) become a 32px vertical rail: a chevron icon on top + a vertical `writing-mode: vertical-rl` label.

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
- **Clickable `file.ts:42` mentions:** real project files the agent prints become
  links (`pointerCursor` + `underline`) that open the File Preview scrolled to the
  line. Only paths that exist under the project root are linked — never style arbitrary
  path-like text as a link.
- **Copy:** drag-select copies on mouse-up (copy-on-select) and `Ctrl+Shift+C` /
  `Cmd+C` copy an existing selection; `Ctrl+C` alone stays SIGINT. A plain click
  leaves no selection and copies nothing.

## Default toggle animation

For non-sidebar show/hide (vertical reveal), use the shared `.collapsible-content` + `.collapsible-inner` classes (grid-rows `0fr→1fr` with `--motion-panel`/`--ease-out-expo`), toggled via `data-open`. This is the Session Details accordion motion.
