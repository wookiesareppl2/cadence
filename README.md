# Cadence

Cadence is a desktop control room for AI coding assistants. It runs alongside the
**Claude Code** and **OpenAI Codex** command-line tools and gives you one window for
your projects and sessions, live plan-usage tracking, terminals, a file manager with
live preview, per-project notes & tasks, global search, and a view into your project
memory/context.

You can connect **Claude, Codex, or both** — if you only use one, the platform
switcher hides and the app simply becomes that tool.

## Requirements

- Windows 10/11
- The **Claude Code** and/or **Codex** CLI. You don't need to install these yourself
  first — on first launch Cadence detects what's present and walks you through
  installing and signing in to whichever you use.

## Install

Download the latest installer from the
[Releases page](https://github.com/wookiesareppl2/cadence-releases/releases) and run it.

> **Heads-up:** the installer is not yet code-signed, so Windows SmartScreen may show
> an "unknown publisher" warning. Click **More info → Run anyway** to proceed. Code
> signing is planned for a future release.

On first launch, the setup screen checks whether the Claude/Codex tools are installed
and signed in, and guides you through anything that's missing.

## Privacy

Cadence is **local-first and collects no telemetry or analytics**. It reads the
credential and session files that the Claude/Codex CLIs already store on your computer
to show your usage and history. Your access tokens stay on your device and are used
only to call the official Anthropic/OpenAI usage endpoints — they are never sent
anywhere else. Disconnecting a tool simply moves its local credential file to the
Recycle Bin.

## Development

This repo holds the app code. pnpm is required.

```bash
pnpm install      # install dependencies
pnpm dev          # run the app in development (rebuilds native modules for Electron)
pnpm test         # run the test suite (stop the dev server first; rebuilds native ABI)
pnpm run build    # type-check and build
pnpm run dist     # build the distributable installer
```

Before working on any UI, read [`docs/DESIGN.md`](docs/DESIGN.md) — the design system
and conventions the app follows.

## License

[MIT](LICENSE) © Sheldon Kumm
