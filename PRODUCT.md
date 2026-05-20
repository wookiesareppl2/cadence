# Product

## Register

product

## Users

Solo developer using this as a primary daily-driver coding interface. Context: managing multiple AI coding assistant sessions (Claude Code, OpenAI Codex), monitoring token usage against subscription limits, switching between projects and sessions throughout the workday. The user is an expert who knows what every number means; the interface should respect that expertise, not explain it.

## Product Purpose

A desktop Electron app that unifies AI coding assistants behind a single interface. The #1 job is accurate usage tracking: parsing local JSONL files for exact per-message token counts, aggregating into 5-hour rolling windows and weekly views, so the user always knows where they stand against their Pro subscription limits. Secondary jobs: session browsing across all projects, integrated terminal per platform, and instant platform switching between Claude Code and Codex.

Success looks like: the user never opens a separate terminal for Claude Code again. Every coding session starts and ends in this app. Usage data is always visible, always trusted, never inflated.

## Brand Personality

Precise, dense, professional.

The voice is a Bloomberg terminal for AI coding: information-rich, confident, zero fluff. Every element earns its place. Labels are terse. Numbers are prominent. Whitespace is deliberate rhythm, not padding for comfort. The tool assumes you know what you're looking at and doesn't waste space explaining.

## Anti-references

- Generic SaaS aesthetic: Notion-cream backgrounds, rounded-everything, emoji-heavy labels, pastel accents, "friendly" illustrations, startup template vibes. This tool is not trying to onboard strangers or convert visitors.
- Hero-metric templates: big number + small label + supporting stat + gradient accent. SaaS cliche.
- Identical card grids: same-sized cards with icon + heading + text, repeated endlessly.
- Dashboard template kits: anything that looks like it was assembled from a Figma admin template.

## Design Principles

1. **Density is a feature.** More information visible at once means fewer context switches. Optimize for glanceability, not scannability. A user who knows the layout should extract meaning from a 200ms glance.
2. **Two platforms, zero blending.** Claude Code and Codex are completely independent views with distinct accent colors (terracotta and green). Switching platforms swaps everything. No shared UI state leaks between them.
3. **Numbers you can trust.** Usage data is the core value proposition. Token counts must be deduplicated, aggregation logic must be transparent, and estimates must be labeled as estimates. Precision in data, honesty in presentation.
4. **Keyboard-first, mouse-permitted.** Inspired by Raycast: the primary interaction model is keyboard-driven. Mouse works, but the interface should be navigable and operable without it.
5. **Earned complexity.** Every panel, widget, and data point serves a daily workflow. Nothing is added for visual completeness or feature-list padding. If the user wouldn't miss it after a week, it doesn't belong.

## Accessibility & Inclusion

Standard best practices: good contrast ratios against the dark theme, keyboard navigation throughout, no accessibility-breaking patterns. Reduced-motion preference respected (disable non-essential animations). No formal WCAG target, but don't create barriers.

## References

- **Bloomberg Terminal**: information density, tinted dark theme, data-forward layout, terse labeling
- **Raycast**: sleek keyboard-first desktop tool, dark theme, snappy transitions, command palette UX
