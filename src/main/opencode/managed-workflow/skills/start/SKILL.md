---
name: start
description: Resume a project session from its declared Felix vault memory home, a legacy Memory Bank, or a root handoff, with targeted context retrieval and readiness gates. Use only for /start or an explicit request to resume saved project context.
compatibility: opencode
metadata:
  managed-by: Cadence
  workflow-revision: "3"
---

# Start Session Briefing

Resolve the project's memory home first, then delegate the entire read/check workflow to exactly one worker.

## Resolve the memory home first — MANDATORY FIRST TOOL CALL

**Do not decide the memory route yourself. The route is computed, not inferred.**

Your first tool call in this skill MUST be the command below, before any other bash
command, file read, glob, grep, or task call. In particular, do **not** test for
`.claude/HANDOFF.md`, `.Codex/HANDOFF.md`, or any other memory file before running it —
that test is part of this command, and running it early is what produces a wrong route.

```bash
# Anchor on the NEAREST project baseline at or above the working directory.
# Never use the git toplevel: a project nested below a git root would resolve to
# the outer repo and miss both its own marker and its own bank.
ROOT="$(pwd -P)"
while [ "$ROOT" != "/" ] && [ ! -f "$ROOT/CLAUDE.md" ] && [ ! -f "$ROOT/.claude/CLAUDE.md" ]; do
  ROOT="$(dirname "$ROOT")"
done
if [ "$ROOT" = "/" ] && [ ! -f "/CLAUDE.md" ]; then ROOT="$(pwd -P)"; fi

# Read baselines with fenced code blocks stripped, so a documented example
# marker cannot be mistaken for the live one.
unfenced() { if [ -f "$1" ]; then awk 'BEGIN{f=0} /^[[:space:]]*```/{f=!f; next} !f{print}' "$1"; fi; return 0; }
BASELINES="$(unfenced "$ROOT/CLAUDE.md"; unfenced "$ROOT/.claude/CLAUDE.md")"
CANDIDATES="$(printf '%s\n' "$BASELINES" | grep 'Felix memory home' || true)"

# Take the path after the WSL: label — never merely the first backticked
# segment starting with "/", which an earlier segment could hijack. Try every
# candidate line in order; the first that resolves to a real directory wins.
MEMORY_HOME=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  cand="$(printf '%s' "$line" | grep -o 'WSL:[[:space:]]*`[^`]*`' | head -1 | sed 's/^WSL:[[:space:]]*`//; s/`$//')"
  if [ -n "$cand" ] && [ -d "$cand" ]; then MEMORY_HOME="$cand"; break; fi
done <<CANDIDATES_EOF
$CANDIDATES
CANDIDATES_EOF

NEARMISS="$(printf '%s\n' "$BASELINES" | grep -i 'felix memory home' || true)"

if [ -n "$MEMORY_HOME" ]; then
  echo "MEMORY_ROUTE=vault"; echo "MEMORY_HOME=$MEMORY_HOME"
elif [ -n "$CANDIDATES" ]; then
  echo "MEMORY_ROUTE=abort"; echo "REASON=vault marker present but no memory home resolved"
elif [ -n "$NEARMISS" ]; then
  echo "MEMORY_ROUTE=abort"; echo "REASON=marker-like text present but unparsed; refusing to fall back to a frozen bank"
elif [ -f "$ROOT/.claude/HANDOFF.md" ]; then
  echo "MEMORY_ROUTE=legacy-bank"; echo "MEMORY_HOME=$ROOT/.claude"
else
  echo "MEMORY_ROUTE=legacy-root"; echo "MEMORY_HOME=$ROOT"
fi
echo "WORKSPACE_ROOT=$ROOT"
```

Use the printed `MEMORY_ROUTE` verbatim. It is the only valid source of the route:

- `MEMORY_ROUTE=vault` → **Vault Mode**, with `<MEMORY_HOME>` as printed. The project's
  `.claude/` bank is FROZEN: never read it as memory, never cite it, and never let its
  contents influence the briefing. Legacy Bank Mode is **forbidden** in this case even
  though `.claude/HANDOFF.md` exists — its existence is not evidence of anything.
- `MEMORY_ROUTE=legacy-bank` → **Legacy Bank Mode** using the printed `<MEMORY_HOME>`.
- `MEMORY_ROUTE=legacy-root` → **Legacy Root Mode** using root `HANDOFF.md`.
- `MEMORY_ROUTE=abort` → stop immediately and report exactly:
  `START_ABORTED_BAD_ROUTE: <REASON>`. Do not fall back to any legacy mode.

If you did not run the command, you do not know the route. Run it.

The Obsidian vault is the permanent single source of truth for Sheldon's AI work. Legacy modes are transition scaffolding for projects not yet migrated, never the preferred endpoint.

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

- **Transmit the worker contract below verbatim.** Copy it as written; do not paraphrase
  it, summarize it, shorten it, or substitute instructions you remember from an earlier
  version of this skill. Only substitute the placeholder values (resolved mode, paths,
  resolved fidelity, current user request). Rewriting the contract silently drops its
  guards — notably the port rule, which forbids falling back to `3000`.
- Do not launch the task in the background.
- Do not call another worker, council, or nested task.
- Do not repeat any worker checks in the parent session.
- Wait for the worker result, then relay its briefing without adding unverified claims.
- If the task tool is unavailable or the task fails to start, stop with exactly:
  `START_ABORTED_NO_WORKER: Spec requires single-worker delegation. No context or readiness checks were run in the parent session.`

## Fidelity

Resolve the fidelity before delegating, then pass the **resolved** value to the worker:

| Command argument | Resolved fidelity |
| --- | --- |
| *(blank / no argument)* | `lean` |
| `lean` | `lean` |
| `high` | `lean` (deprecated alias; authorizes no broader reads) |
| `max` | `max` |
| anything else | `lean` |

- `lean` — lean resume. Read the personal layer and operational project state in full, then retrieve only task-relevant on-demand entries.
- `max` — full audit resume, and the only mode that authorizes all live memory files to be read in full.

`lean` and `max` are the only two resolved values that exist. **Never announce, pass, or
report the fidelity as `high`** — `high` is an input alias only, and reporting it
misstates what was read. When no argument is supplied the resolved fidelity is `lean`;
say `lean`.

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
