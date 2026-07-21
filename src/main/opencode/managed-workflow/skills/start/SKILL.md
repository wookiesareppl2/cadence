---
name: start
description: Resume a project session from its declared Felix vault memory home, a legacy Memory Bank, or a root handoff, with targeted context retrieval and readiness gates. Use only for /start or an explicit request to resume saved project context.
compatibility: opencode
metadata:
  managed-by: Cadence
  workflow-revision: "2"
---

# Start Session Briefing

Resolve the project's memory home first, then delegate the entire read/check workflow to exactly one worker.

## Resolve the memory home first

The parent may read only the project baseline needed for routing (`CLAUDE.md` at the workspace/repo root and `.claude/CLAUDE.md` if distinct) and test file existence. It must not read memory content, run git checks, or check ports itself.

Choose the first matching mode:

1. **Vault Mode** — a project baseline contains this machine-readable marker:
   `Felix memory home — Windows: ` `` `<win path>` `` ` · WSL: ` `` `<wsl path>` ``
   Extract both backtick-quoted paths. OpenCode runs under WSL, so **select the WSL path**. Call it `<MEMORY_HOME>`.
2. **Legacy Bank Mode** — no marker, but `<WORKSPACE_ROOT>/.claude/HANDOFF.md` exists.
3. **Legacy Root Mode** — neither condition matches; use root `HANDOFF.md`.

The Obsidian vault is the permanent single source of truth for Sheldon's AI work. Legacy modes are transition scaffolding for projects not yet migrated, never the preferred endpoint. When the vault marker is present, do not read the project's `.claude/` bank as memory — it is frozen.

## Non-negotiable delegation boundary

Use exactly one synchronous OpenCode worker for the entire operation. Before reading project or memory files, running git commands, or checking ports, call the native task tool once with:

```text
task(
  description="Load the project memory",
  prompt="<the complete worker contract below, the resolved mode and paths, the requested fidelity, and the current user request>",
  subagent_type="deep-fixer",
  run_in_background=false,
  load_skills=[]
)
```

- Do not launch the task in the background.
- Do not call another worker, council, or nested task.
- Do not repeat any worker checks in the parent session.
- Wait for the worker result, then relay its briefing without adding unverified claims.
- If the task tool is unavailable or the task fails to start, stop with exactly:
  `START_ABORTED_NO_WORKER: Spec requires single-worker delegation. No context or readiness checks were run in the parent session.`

## Fidelity

Pass the command argument to the worker:

- `/start` or `/start lean` (default): lean resume. Read the personal layer and operational project state in full, then retrieve only task-relevant on-demand entries.
- `/start high`: deprecated compatibility alias for `lean`; it does not authorize broader reads.
- `/start max`: full audit resume, and the only mode that authorizes all live memory files to be read in full.

Any blank or unsupported argument means `lean`.

## Vault Mode worker contract

The single worker owns every read and check. It must not delegate.

`<MEMORY_HOME>` is a project folder in the Obsidian vault under `/mnt/c` (it may be slow; do not retry a successful read):

- Hot layer (ALWAYS load in full): `_Index.md`, `HANDOFF.md`, `Pins.md`
- On demand only: `Pins-Reference.md`, `Decisions.md`, `Patterns.md`, `Troubleshooting.md`
- Cold: `Archive/` (read only if a live result or entry points there)

**Step 1: Personal + project layers**

1. Walk upward from `<MEMORY_HOME>` until the first `VAULT-INDEX.md` is found; read it in full as the personal layer. If none exists before the filesystem root, report it missing.
2. Read `_Index.md`, `HANDOFF.md`, and `Pins.md` in full as the project hot layer.

**Step 2: On-demand retrieval**

In `lean`, derive task keywords from `HANDOFF.md`, the current user request, changed paths, and recent commits. Use `rg` against `Pins-Reference.md`, `Decisions.md`, `Patterns.md`, and `Troubleshooting.md` and read only complete matching entries. Never load those files wholesale. Read `Archive/` only when a live result or entry points there. In `max`, read the four live on-demand files in full and inspect `Archive/` only to resolve live references or contradictions.

**Step 3: Shared project baseline**

After locating the git repo root, read `CLAUDE.md` at the repo root and `.claude/CLAUDE.md` if distinct, plus any Markdown baseline docs they require before work (for example `docs/DESIGN.md`), and Claude-style `@relative/path.md` imports recursively up to four hops where practical. Inspect `AGENTS.md` / `AGENTS.override.md` if present and flag drift unless each is a pointer, symlink, or equivalent copy of the same baseline.

**Step 4: Validate against git + gate checks**

1. Treat the current OpenCode working directory as `<WORKSPACE_ROOT>`. The git repository may be the workspace root or a child up to two levels deep. Locate `.git` first and run git from that repository.
2. Run `git log --oneline -20`, `git status --porcelain`, and `git branch --show-current`; cross-reference HANDOFF progress against commits and note discrepancies.
3. Resolve the optional preview port only when the current request requires live UI; otherwise report `NOT NEEDED`. For Electron Vite, use explicit `electron.vite.config.*` `renderer.server.port`, else the Electron/Vite default `5173`. For ordinary Vite, use explicit `server.port`, else Vite default `5173`. For Next, use explicit `-p`/`--port`, else Next default `3000`. Check the expected port once. If Electron/Vite auto-incremented because the port was occupied, resolve the actual renderer URL from running-process/listener evidence; if that cannot be established, report `UNRESOLVED (expected 5173)` and **never substitute `3000`**. A refused connection is final evidence — do not retry it.

**Step 5: Self-verify** — personal layer and hot layer read in full; on-demand retrieval applied (or live files full in `max`); baseline read or confirmed absent; git validated; gates checked. Note every unreadable file and any escalation explicitly.

In Legacy Bank Mode, read `.claude/HANDOFF.md` in full and `.claude/context-pins.md` (full when reasonably sized, else every DNO/PIN heading, status, source reference, and recent review entry plus every entry relevant to the current task, changed files, or workflow gates); in `lean` use targeted `rg` reads of `.claude/patterns.md`, `.claude/decisions.md`, and `.claude/troubleshooting.md`, and in `max` read them fully plus optional root `INTRANET_FULL_BUILD_OUTLINE.md` and `INTRANET_TESTING_OUTLINE.md`. Then apply Steps 3-5 unchanged. In Legacy Root Mode, read the root handoff and shared baseline, inspect git status and branch, and return the same orientation without inventing memory counts.

## Required worker output

Return only this structure:

**Section 1: Readiness**
- `Tree:` CLEAN / DIRTY / KNOWN LOCAL, with count and short reason when applicable
- `Branch:` branch name - SAFE / UNSAFE
- `Dev server:` port - LISTENING / NOT RUNNING / NOT NEEDED / UNRESOLVED
- `Overall:` READY / NOT READY; only actionable blockers make it NOT READY (unsafe branch,
  unexpected dirty project changes, missing required files, or a dev server required by the next
  task but not running)

**Section 2: Current State**
- One-line project description
- Current task or stretch focus
- Current direction and next target
- Flag stale HANDOFF state versus git and recommend `/save` when required

**Section 3: Blockers & Risks**
- Current blockers and carry-over risks; omit only when there are none

**Section 4: Next Steps**
- Next manual action
- Next assistant action

**Section 5: Verification**
- One line: fidelity, personal layer, files read full versus targeted, baseline read, gaps or
  escalations, DNO count and hot PIN count (for example `11 DNOs, 10 hot pins - Active, no drift`)

**Footer (Vault Mode)**
> Context loaded from the Felix vault memory home and shared project baseline. Deeper entries are retrieved on demand or via `/start max`.

**Footer (legacy modes)**
> Context loaded from `.claude/` Memory Bank and shared project baseline files. Refer to those files for detail.
