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
line icons that inherit `currentColor` and sit in the same 24px action button
frame. File creation uses document-plus / folder-plus; nearby refresh controls
use the same stroke weight and size. Notes rich-text controls use a 24px button
frame with a 14px optical glyph box for text glyphs and SVGs. List controls use
the standard bullets or numbers plus horizontal lines form; quote icons must be
large enough to read at toolbar size without visually overpowering adjacent
text-format buttons. Keep these SVGs monochrome and token-coloured.

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

## Default toggle animation

For non-sidebar show/hide (vertical reveal), use the shared `.collapsible-content` + `.collapsible-inner` classes (grid-rows `0fr→1fr` with `--motion-panel`/`--ease-out-expo`), toggled via `data-open`. This is the Session Details accordion motion.
