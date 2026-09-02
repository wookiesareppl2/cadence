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
- **Global panel controls:** `Collapse all` / `Expand all` live in the titlebar's **View** menu. They apply only to the active platform and set Projects & Sessions, Files, History, and Notes & Tasks together.
- **Hover model (matches the History panel):**
  - *Expanded* → only the triangle/chevron whitens to `--text-1`. No section/background highlight.
  - *Collapsed bar or rail* → the clickable region gets the **accent border**: `background: var(--surface-2); border-color: var(--accent);`. Use the element's real 1px border or the collapsed parent panel's border, not an inset box-shadow, so rounded corners render cleanly.
  - Differentiate states with the collapsed marker already on the element: `[aria-expanded="false"]` (header buttons) or the `.collapsed` class (accordion sections).
- **Collapsed sidebars** (Projects & Sessions/Files/History) become a 32px vertical rail: a chevron icon on top + a vertical `writing-mode: vertical-rl` label.
- **Open panel resize:** Projects & Sessions, Files, and History expose an invisible 8px vertical drag handle on their inner edge; Notes & Tasks exposes the same 8px handle on its top edge. Handles use the shared `.panel-resize-handle` classes and persist size per active platform without changing the 32px collapsed rail. **The visible cue is a hairline, never a fill:** the 8px hit area stays invisible, and on hover/drag a **2px accent line** (a `::before`) appears along the handle's active edge — inset from its ends by `--radius-panel` so it never pokes past a rounded `.panel` corner. Keep it **easy on the eyes**: the line is soft on hover (`opacity: 0.4`, since incidental mouse passes shouldn't flash a bright line) and only brightens while actually dragging (`.resizing`, `opacity: 0.85`) — never a solid full-opacity accent. Do not reintroduce the old full-width accent *wash* — a thin line is the house style for every resize affordance.
- **Split resize (within a sidebar):** the Projects list and Sessions list inside the Projects & Sessions sidebar are split by a draggable horizontal divider (`.project-session-divider`). Same hairline treatment, but **in normal flow** rather than an absolute edge handle: a generous 8px grab zone straddling the line via negative margins (`cursor: row-resize`, `bottom` resize edge — drag down grows Projects); at rest the Projects list's 1px `border-bottom` is the only cue, and on hover/drag a centered 2px accent line (`::before`) sharpens in over it. The Projects list height is driven by `--project-list-height` and persisted per platform under the `projectList` size key (default 260px, so several projects are always visible); a `max-height: calc(100% - …)` always reserves room for Sessions. Use this in-flow divider pattern whenever splitting two stacked lists inside one panel.

### Task reordering

Tasks in Notes & Tasks reorder within their current status tab; Open and Done each
retain an independent visible order backed by the shared persisted task array. Every
row starts with an 18px drag handle using the canonical line-icon treatment. Dragging
shows the moved row with reduced opacity and marks the destination with a **2px accent
hairline between rows**, never an accent wash over the target. The handle remains a
keyboard control: when focused, Up / Down moves the task one visible position and an
`aria-live` region announces its new position. Reordering uses the existing debounced
workspace save and must never cross the Open / Done boundary or mutate task content.

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

## Split actions (a default plus a riskier alternate)

When one action has a safe default and a variant that should not be a slip away —
resuming a session normally vs. resuming in the CLI's bypass-every-permission mode —
use a **split control**, not a second sibling button.

- One accent shape, two buttons: the labelled primary (`border-radius: 6px 0 0 6px`)
  and a ~20px caret (`0 6px 6px 0`), seamed by a single `border-left` tinted with
  `color-mix(in srgb, var(--surface-0) 35%, var(--accent))`. Both share the primary's
  height, hover, disabled and focus treatment, so the pair reads as one control.
- The caret opens a fixed-position menu measured from the **group's** rect, dismissed
  per the Overlays rule below (Esc / outside-click / scroll) and repositioned on resize.
  **Portal it to `<body>`.** A fixed overlay is positioned relative to the nearest
  ancestor with a `transform`, `will-change: transform`, or `contain: layout`, and
  `contain: paint` clips it outright — the history sidebar has all of these for its
  open/close animation, so a menu left in place is offset into nowhere and then hidden.
  A portalled menu is no longer inside the trigger's subtree, so the outside-click
  handler must check the menu too; otherwise `mousedown` unmounts the row before its
  `click` fires and the action silently never runs. It also leaves the `.app-shell`
  subtree, where `--accent` / `--accent-dim` / `--accent-hover` are set inline per
  platform — those stop resolving, and a property whose value names an unresolved
  variable is invalid at computed-value time, so e.g. `outline: 1px solid var(--accent)`
  becomes no outline rather than a differently-coloured one. Pass any accent a
  portalled overlay needs in through its inline style. Close the menu whenever it would
  otherwise be left pointing at something that changed — a different selection, the
  action becoming unavailable, or the containing panel collapsing.
- The primary keeps its full one-click behaviour. The alternate is always a second
  deliberate click; never promote it to the button and never persist it as the new
  default, or the control silently stops meaning what it did yesterday.
- Mark a dangerous row with `--caution` (the house warning colour — no new red) and a
  one-line `--font-mono` note in `--text-3` saying plainly what it turns off.
- Where a mode belongs to an external tool, use **that tool's own word** for it
  (Claude "skip perms", Codex "yolo"), derived from one shared source
  (`src/shared/ai-launch.ts`) rather than spelled out at each button. That file is also
  the only place that knows each CLI's launch and resume invocations.

Reference implementation: the Resume control in `session-panels.tsx`
(`.history-resume-group`).

## Overlays

- **Modals** (`*-modal-backdrop` + dialog): `position: fixed; inset: 46px 0 0 0` (below the titlebar), centered, `rgba(0,0,0,0.5)` backdrop, dialog on `--surface-1` with a soft shadow; close on backdrop click + Esc.
- **Tooltips/menus/context menus**: `position: fixed`, positioned in JS from a rect (so they escape scroll clipping); dismiss on Esc / outside-click / scroll.

### Settings surface

Application-wide preferences live in the Settings modal opened from **Tools → Settings**.
Use a compact category rail on the left and bordered preference groups on the right;
the first category is General. Settings copy must state its scope and when it takes
effect. Binary preferences use the shared switch treatment: muted `--surface-3` track,
accent track when enabled, and a high-contrast circular thumb. The whole control must
be a keyboard-focusable `role="switch"` with `aria-checked`; do not hide a checkbox
behind an unlabelled decorative track.

### Repository import / account modals

Use the `github-import-*` modal family as the canonical pattern for account-backed
project import flows (GitHub OAuth, repository picking, context-vault sync). It is
a compact operational dialog, not a setup wizard or landing page.

Context-vault sync is currently banked behind `CONTEXT_VAULT_SYNC_ENABLED`; while the
gate is off this modal is import-only and must not show sync, restore, vault, or
conflict-status controls. The patterns below remain the preserved design for later work.

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
- **Missing prerequisite:** when the flow needs a program Cadence does not bundle,
  say so on open rather than at failure. `.github-import-prereq` sits at the top of
  the modal body using the caution treatment of `.github-import-status` — same class
  of message, so the same colour — with one plain sentence and the install command in
  a `<code>` block. Never leave the user to discover it by filling the form and
  hitting a spawn error. Detect on open, and on a probe failure leave the state
  unknown rather than claiming the tool is missing.

## Empty states

An empty list must say what would fill it. `.session-placeholder` is the terse mono
status voice — right for "No matching projects" or "Scanning…", where the user already
knows the context. It is wrong for a first run.

When a surface is empty because the user has *nothing yet*, use the
`.project-empty-first-run` pattern: the same frame as `.session-placeholder` but
`--font-ui` prose — a short `--text-1` title, a `--text-3` sentence explaining how
entries get here, and accent buttons for the ways to add one. Projects appear in
Cadence by being worked in with a provider CLI, so a new user has none and a bare
"No projects found" is a dead end with no stated way out.

Distinguish *empty* from *filtered to nothing*. Offer first-run actions only when the
underlying collection is genuinely empty and no query is active; showing "open a
folder" to someone whose search simply missed reads as though their work vanished.

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

## Scrollbars

- **Style scrollbars with `::-webkit-scrollbar` only.** The rules live once, app-wide,
  at the top of `styles.css` (10px, transparent track, `--surface-4` thumb on a 2px
  transparent border so it reads as inset).
- **Never add `scrollbar-width` or `scrollbar-color`.** Chromium ignores *every*
  `::-webkit-scrollbar` rule the moment either standard property is set, so adding
  them silently reverts the whole app to the platform scrollbar — on Windows 11 the
  Fluent one, with arrow buttons, which is visibly off-theme.
- This is load-bearing in the terminal, not just cosmetic. `.xterm-viewport` is
  absolutely positioned **over** `.xterm-screen`, and FitAddon reserves a fixed
  **14px** for the scrollbar when choosing a column count. Any scrollbar wider than
  that reserve paints over the last column and reads as "terminal text cut off on the
  right". Keep the scrollbar ≤ 14px.

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
- **Terminal background must equal `--surface-0`.** `TERMINAL_THEME.background` and the
  `.xterm-viewport` / `.xterm-screen` rules must all resolve to the same colour. FitAddon
  floors the column count, so a terminal always leaves an unused right-hand gutter (its
  fixed 14px scrollbar reserve plus the rounding remainder — 17–20px in practice). If the
  gutter is a different shade from the text area, the two meet in a hard vertical seam that
  looks like a black scrollbar, and text ending flush against it looks truncated. That
  seam — not any real clipping — was the long-standing "terminal text is cut off on the
  right" report.
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

### Vault save engine

The `start` / `save` skills that Claude Code and Codex run share one canonical engine in
`src/main/vault-save/`. The rules below are properties of that engine, not of any one
provider, and each exists because its absence shipped a real defect.

- `/start` defaults to targeted high-fidelity loading and accepts `max`. `/save` defaults
  to an incremental checkpoint and accepts exactly one other fidelity, `max`, with automatic
  escalation when targeted reads cannot prove safety. There are only these two save
  fidelities — the former `full`/`audit` synonyms were removed, and the collector now
  rejects any other value rather than silently saving less than was asked for. The mode is
  passed once, when the manifest is created, and both the apply and validate steps read it
  from there so they cannot disagree. Validate accepts a stamped mode at least as thorough
  as the one requested, because the skill may escalate mid-run; escalation is one-directional.
- **The save manifest accumulates checkpoints; it never rewrites the first one.** `memoryFiles`
  is pre-save state and stays untouched, because validate diffs against it to derive the change
  set. `apply` additionally records `appliedFiles` (what it wrote) and `patch` records
  `projectedFiles` (what it expects a harness patch helper to produce). The tamper guard
  passes if memory matches **any** of them. That is what makes the Step 6 recovery path
  executable: a corrective re-apply after a failed validate is measured against the post-write
  state instead of pre-save state, while an outside edit still matches no checkpoint. Accepting
  any checkpoint — not merely the newest — is required so that regenerating a patch that was
  never applied keeps working. When adding a write path, record its checkpoint too or its
  recovery step will be refused.
- **Write where the reader reads.** The Pin Review Log line is appended relative to the
  `## Pin Review Log` heading, not to the end of `Pins-Reference.md`, because `latestPinReview`
  parses only that section. An end-of-file append satisfied the reader by coincidence — the
  section happened to be last — so adding any section after it would have put every save's line
  outside the reader's window and failed validation with an error pointing nowhere near the
  cause. Appends anchor on the last dated line in the section, or on the heading when the log
  is empty, and a missing heading is a hard error rather than a silent end-of-file append.
- **A memory-home marker is resolved, not merely read.** The marker records one machine's
  literal path, but the vault reaches other machines through OneDrive, where every segment
  matches except the account name. So each recorded path stands for several locations it could
  mean here, tried in order: exactly as written, then with `%VAR%` / `${VAR}` / `$VAR` / `~`
  expanded, then re-homed onto the current account. The recorded form is always tried first, so
  the machine that wrote the marker resolves exactly as before. A candidate is only ever accepted
  by `isDirectory`, so this can widen where a memory home is *found* but can never invent one —
  and the whole tail below the account segment must still match, down to the project's own
  `memory` folder. An unset variable makes the path resolve to nothing rather than expanding to
  empty, because `%NOPE%\OneDrive\…` collapsing to `\OneDrive\…` is still a path and would be
  tested as a real location. The accounts root is derived from `USERPROFILE`, never assumed to be
  `<drive>:\Users` — that assumption mis-slices any path with an earlier `Users` segment. Under
  WSL there is no `USERPROFILE`, so the accounts present under `/mnt/<drive>/Users` are offered
  instead. When nothing resolves, the abort message lists every location tried, not just the one
  written: on a second machine those differ, and naming only the recorded path sends the reader to
  fix something that was never the problem.
- **A DNO must state its authority.** Every new or replaced `DNO-` entry must carry
  `**Authority:** Explicit user approval — <evidence>` or `**Authority:** Authoritative project
  decision — <file and heading>`; the collector refuses the write otherwise. DNOs are the one
  entry class later sessions are told not to re-litigate, so a DNO minted from the engine's own
  inference — "the code does X, therefore X is a rule" — converts an implementation accident into
  a permanent constraint that nothing downstream will question. The guard lives in the shared hunk
  builder, so the `apply` and `patch` front ends inherit it identically.
- **Bootstrap verifies its own writes.** It reports success from having checked the result, not
  from having run the steps: the skeleton files, the `Archive/` directory, exactly one live memory
  marker, and the three hot-layer `@` imports, or it throws. The marker only tells a session where
  memory lives; the imports are what actually load it, so a bootstrap that wrote the marker alone
  produced a project that looked correctly wired and silently began every session with no memory.
  Import paths normalise separators and escape spaces — vault paths contain them — and a path with
  a newline is refused rather than written as two broken imports. An import under the user's home
  is written `~/…` rather than `C:/Users/<name>/…`, because `CLAUDE.md` travels between machines
  and a baked-in account name is the same defect the marker had; spaces are escaped after the
  tilde substitution, or an escaped path would never match an unescaped home. Claude Code's tilde
  expansion was verified by running it on Windows rather than taken from the documentation.
  These imports are always *external* — the vault sits outside the project — so Claude Code asks
  for approval once per project. Accepting is what makes the hot layer load by itself; declining
  disables them permanently and silently, which is why `/start` reads the same three files through
  the marker and the imports are treated as a convenience rather than the mechanism.
- **Derive, never restate.** One fact, one source. Every shipped defect in this path came from
  restating a single value for two consumers — a fidelity held in two places, a changed-file set
  computed twice, a hand-written `.d.mts` declaring a module's exports a second time. The scripts
  are LF-pinned in `.gitattributes` because the test suite imports them directly and a CRLF
  shebang breaks Vite's module transform on a fresh Windows checkout.
- **The repo copy is canonical; the installed copies must match it byte for byte.** The engine runs
  from `~/.claude/skills/save/scripts/` and `~/.codex/skills/save/scripts/`, so the repo copy exists
  to be the tested source of truth. When an installed copy drifts, the suite guards an engine nobody
  runs while the one that runs is unguarded: Claude's copy gained the two rules above, Codex's did
  not, and the two providers ran different save engines for three weeks with a green suite
  throughout. A test now compares the installed copies against the repo copy, skipping only where
  none is installed. Change the repo copy first, then sync outward.
- **App code may import the engine, but only to ask it a question — never to restate one.** The
  Memory viewer imports `resolveRoute` from `resolve-memory-route.mjs` to find a project's memory
  home. That is deliberate: re-implementing marker resolution in TypeScript would put the same fact
  in two places, and the viewer would drift from the engine until it displayed a different memory
  home than the one being written to. Import the engine's answer; do not copy its logic. Anything
  imported this way must keep its `.d.mts` honest, since a declaration that lies about shape is
  checked by nothing at runtime.

## Memory viewer

The Memory overlay shows a project's memory grouped by where it actually lives,
resolved per project rather than assumed. A project carrying a vault memory-home
marker shows its hot layer, its deeper on-demand files and its `Archive/`; a project
without one shows its in-repo `.claude/` bank exactly as before. The routing question
is answered by the save engine's own `resolveRoute`, never by a second implementation
here — see the vault save engine section.

- **Vault memory is read-only in the viewer.** The save engine enforces required
  frontmatter, unique entry ids, no dangling references and index counts that match
  the files; a hand edit in this window satisfies none of that and would surface as a
  validation failure at the next save, pointing nowhere near the edit that caused it.
  `/save` stays the single writer. `Archive/` is read-only for the same reason plus
  its own: archived entries are a record.
- **A frozen bank is shown, not hidden.** When a project has migrated, its `.claude/`
  bank still holds the pre-migration history and reading it is often the point. It is
  relabelled `Frozen old bank — …` and locked rather than dropped, because a bank that
  silently disappears looks like lost memory. Group ids stay unchanged so existing
  search deep-links keep resolving.
- **An unreachable vault is a state of its own, never "no vault".** A project can carry
  a valid marker whose home does not resolve on this machine — a second PC, a drive
  still syncing, WSL not running, an unclosed fence swallowing the marker line. The
  engine returns `abort` for exactly these, and the viewer must keep them distinct from
  a project that never migrated: no vault groups, the bank still labelled frozen and
  locked, and the engine's own `reason` shown. Collapsing `abort` into "no vault" puts
  the frozen bank back under its ordinary heading, editable, with nothing on screen to
  say the live memory is missing — which is the defect this section exists to prevent,
  and it is reachable in ordinary multi-machine use.
- **Cache the routing for display; never for a rule.** Resolving where memory lives
  reads files synchronously — the engine's callback interface is sync so one function
  can serve both the CLI workflows and this process — and for a WSL project that means
  stat/readdir over a `\wsl.localhost\…` UNC path on the main thread. Browsing the
  viewer asks the same question repeatedly, so the answer is cached for a few seconds.
  The write path never consults it: a stale answer costs an out-of-date file list, but
  on the write path it could decide a locked file is editable. Three properties keep
  that cache honest, each of which was got wrong first: age is measured on a monotonic
  clock, because a backwards wall-clock jump makes a `Date`-based age negative and pins
  entries indefinitely; **any** successful write drops the project's entry, because
  enumerating which files affect routing missed that the marker is read from
  `.claude/CLAUDE.md` as well as `CLAUDE.md` and that the former is an ordinary
  editable file here; and entries are pruned rather than only overwritten, so a
  long-running process does not retain one per project ever viewed.
- **Read-only is a main-process rule, not a hidden button.** The service decides
  read-only state and `writeMemoryFile` refuses on the same rule independently. The
  renderer's flag shapes the UI only; a write path that trusts the renderer to have
  honoured it is not a rule.
- **Say why, not just no.** A missing Edit button with no explanation reads as a bug.
  Show the muted `.memory-readonly` badge in the header and the one-sentence
  `.memory-readonly-note` beneath it. Both use `--text-3`, not `--caution`: nothing has
  gone wrong, this is how it is meant to work.

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

The 46px titlebar **flows** with three regions: `.titlebar-brand` (brand lockup plus
application menus), `.platform-switcher` (center), and `.titlebar-right` (search only).
The brand and right regions are `flex: 1 1 0; min-width: 0`, which keeps the switcher
centered when there is room. **Never pin these regions with `position: absolute`.** The
only absolute child is `.window-controls` (the OS min/max/close strip, pinned `right: 0`);
the titlebar reserves it with `padding-right: 146px`.

Secondary actions use two low-chrome desktop-style menus immediately after the Cadence
lockup:

- **View:** Collapse all, Expand all.
- **Tools:** Connections, Memory, Commands, Settings.

Menu triggers are concise text labels because they establish application navigation,
not isolated toolbar actions. Menu rows carry the canonical 14px SVG line icon, a label,
and optional short helper copy. Active toggle-like surfaces (Memory and Commands) show a
small accent state marker. Menus are fixed-position overlays measured from their trigger;
only one opens at a time, and they close on selection, Esc, outside-click, or scroll.

Responsive tiers track the 1180px minimum window width:

- **≤1560px** — hide `.app-version` and reduce platform-tab width.
- **≤1340px** — compact search to its glyph (see below) and reduce platform tabs again.
- **≤1200px** — hide the brand wordmark/version lockup, retaining the logo and menus.

When adding a titlebar destination, place it in the most specific existing menu and give
its row a canonical SVG icon. Add a new top-level menu only when several related actions
justify a stable category; do not restore individual framed titlebar buttons.

**Compact search:** below 1340px the `.titlebar-search` collapses to just its glyph (the
input stays present at zero width; the container's `onClick` focuses it so the glyph is
tappable) and expands on `:focus-within`. When expanded it lifts to `position: absolute`
(`right: 146px`, clearing the window controls with the same 8px gap) so it overlays leftward
rather than shoving the other actions.
