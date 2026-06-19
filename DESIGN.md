<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->
---
name: Cadence
description: Bloomberg terminal for AI coding assistants
---

# Design System: Cadence

## 1. Overview

**Creative North Star: "The Control Room"**

A single-operator control room for AI coding sessions. Every surface is a readout. Every number is live. The aesthetic is functional surveillance: dark, dense, tinted toward warmth, stripped of decoration. The interface assumes its operator knows what every indicator means and never interrupts to explain.

This is not a consumer product trying to be approachable. It is not a SaaS dashboard trying to convert visitors. It is not a template kit assembled from components. It is a personal instrument panel where information density is the primary design goal, and clarity comes from structure, not from whitespace.

The system uses two platform accent colors (terracotta for Claude Code, muted green for Codex) that never appear simultaneously. Switching platforms swaps the entire chromatic identity. Neutrals are warm-tinted, never pure gray. Motion is restrained to state changes only: hover, focus, toggle. No entrance animations, no choreography.

**Key Characteristics:**
- Information density over visual comfort
- Warm-tinted dark neutrals, never pure black or gray
- Platform-specific accent colors that define chromatic identity per view
- Monospace-forward data presentation with sans-serif UI labels
- Flat surfaces with tonal layering, no decorative elevation
- Keyboard-first interaction model

## 2. Colors

A full palette with two deliberate accent roles and a warm-tinted dark neutral family. Each platform owns its accent completely; the other platform's accent never appears, even as a secondary.

### Primary

- **Kiln Terracotta** (#E07A5F / oklch(65% 0.14 40)): Claude Code's accent. Active states, progress indicators, selected items, platform badge. Appears on less than 15% of the Claude Code view surface.
- **Patina Green** (#81B29A / oklch(72% 0.08 170)): Codex's accent. Same role as terracotta, but exclusively within the Codex view.

### Neutral

- **Control Surface** [to be resolved: ~oklch(20% 0.005 40)]: primary background. Dark, warm-tinted toward the terracotta hue at near-zero chroma.
- **Panel Elevated** [to be resolved: ~oklch(24% 0.005 40)]: sidebar, card, elevated panel background. One step lighter than Control Surface.
- **Divider** [to be resolved: ~oklch(30% 0.005 40)]: borders, separators. Subtle, never high-contrast.
- **Text Primary** [to be resolved: ~oklch(92% 0.005 40)]: primary text. Warm off-white, never #fff.
- **Text Secondary** [to be resolved: ~oklch(65% 0.005 40)]: secondary labels, timestamps, metadata.
- **Text Muted** [to be resolved: ~oklch(45% 0.005 40)]: disabled, placeholder, tertiary information.

### Semantic

- **Alert** [to be resolved: warm red]: error states, destructive actions. Must not be confused with Kiln Terracotta.
- **Caution** [to be resolved: amber]: warnings, rate limit indicators.
- **Success** [to be resolved: cool green]: confirmation. Must not be confused with Patina Green.

### Named Rules

**The Platform Monopoly Rule.** Only one platform accent is ever visible. When Claude Code view is active, Patina Green does not exist anywhere in the UI. When Codex view is active, Kiln Terracotta does not exist. Switching platforms is a chromatic identity change, not a tab swap.

**The Warm Neutral Rule.** Every neutral is tinted toward the warm hue family (chroma 0.005-0.01 in OKLCH). Pure gray (#808080, oklch with chroma 0) is prohibited. The tint is subtle but present.

## 3. Typography

**Body/UI Font:** Segoe UI Variable / Segoe UI (with system-ui, -apple-system fallback)
**Data/Terminal Font:** Cascadia Code / Cascadia Mono (with JetBrains Mono, Consolas fallback)

**Character:** Functional and dense, but easier on the eyes for long sessions. Segoe UI gives the Windows desktop shell a native feel with softer UI text. Cascadia dominates wherever data is displayed: token counts, session IDs, timestamps, terminal output. The pairing is workstation-native, not editorial.

### Hierarchy

- **Display** (Segoe UI 600, clamp(1.5rem, 2vw, 2rem), 1.1): rarely used. Section titles in expanded views only.
- **Headline** (Segoe UI 600, 1.125rem, 1.2): panel titles, view headers.
- **Title** (Segoe UI 500, 0.875rem, 1.3): card titles, session names, widget labels.
- **Body** (Segoe UI 400, 0.8125rem, 1.5): descriptions, metadata. Max line length 65-75ch.
- **Label** (Segoe UI 500, 0.6875rem, 1.2, uppercase tracking 0.05em): status badges, column headers, axis labels.
- **Data** (Cascadia Code 400, 0.8125rem, 1.4): token counts, percentages, session IDs, timestamps.
- **Data Large** (Cascadia Code 500, 1.25rem, 1.1): headline metrics in usage widgets.
- **Terminal** (Cascadia Code 400, 0.8125rem, 1.4): terminal output.

### Named Rules

**The Data-in-Mono Rule.** Any value that represents a measurement, count, identifier, or timestamp is rendered in Cascadia Code / Cascadia Mono. Segoe UI is for labels and descriptions only. If a string could be copy-pasted into a terminal and make sense, it's mono.

## 4. Elevation

Flat by default. Depth is conveyed through tonal layering (progressively lighter warm neutrals), not through shadows. The dark theme provides natural depth: darker = further back, lighter = closer to the user.

No box-shadows on resting elements. No decorative elevation. If a shadow ever appears, it is functional: a dropdown menu, a modal overlay, a drag preview. These are the only permitted shadow contexts.

### Named Rules

**The Flat-By-Default Rule.** Surfaces are flat at rest. Tonal steps create hierarchy. Shadows appear only on floating layers (dropdowns, modals, tooltips) and are subtle, diffuse, and dark (never colored).

## 5. Components

[To be defined during implementation. Re-run `/impeccable document` once components exist.]

## 6. Do's and Don'ts

### Do:

- **Do** use Cascadia Code / Cascadia Mono for all numeric data, token counts, and identifiers.
- **Do** tint every neutral toward the warm hue family. Test by desaturating to grayscale: if the neutral is indistinguishable from pure gray, add more chroma.
- **Do** swap the entire chromatic identity when switching platforms. Every accent-colored element changes.
- **Do** label estimates as estimates. "~62% (est.)" not "62%".
- **Do** prefer terse labels. "5h" not "5 Hour Rolling Window". "In" not "Input Tokens".
- **Do** design for keyboard navigation first. Every interactive element must be reachable and operable via keyboard.

### Don't:

- **Don't** use Notion-cream backgrounds, rounded-everything, emoji-heavy labels, pastel accents, or friendly illustrations. This is not a SaaS onboarding flow.
- **Don't** use hero-metric templates (big number + small label + supporting stat + gradient accent). Find a denser, less cliched way to present metrics.
- **Don't** use identical card grids (same-sized cards with icon + heading + text, repeated). Vary the rhythm.
- **Don't** use anything that looks assembled from a Figma admin template or dashboard kit.
- **Don't** use border-left or border-right greater than 1px as a colored accent stripe on cards or list items.
- **Don't** use gradient text (background-clip: text with gradient).
- **Don't** use glassmorphism, blur effects, or frosted-glass cards.
- **Don't** use bounce or elastic easing. Ease-out-quart/quint/expo only.
- **Don't** show both platform accent colors at the same time. The Platform Monopoly Rule is absolute.
- **Don't** use pure black (#000) or pure white (#fff) anywhere. Every extreme is warm-tinted.
