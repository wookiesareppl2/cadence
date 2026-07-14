---
name: start
description: Resume a project from its Cadence Memory Bank and report a concise readiness briefing before implementation. Use only for /start or an explicit request to resume saved project context.
compatibility: opencode
metadata:
  managed-by: Cadence
  workflow-revision: "1"
---

# Start Session Briefing

Load the project's saved operating context before implementation. Prefer `.claude/HANDOFF.md`
(Memory Bank mode); fall back to a root `HANDOFF.md` (legacy mode).

## Non-negotiable delegation boundary

Use exactly one synchronous OpenCode worker for the entire operation. Before reading project or
memory files, running git commands, or checking ports, call the native task tool once with:

```text
task(
  description="Load the project Memory Bank",
  prompt="<the complete worker contract below, the requested fidelity, and the current user request>",
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

- `high` (default): read operational state fully, then use indexed and targeted reads for large
  append-only knowledge files. Escalate any uncertain file to a full read.
- `max`: read all Memory Bank files in full and perform the widest project audit.

Any blank or unsupported argument means `high`.

## Worker contract

The single worker owns every read and check below. It must not delegate.

1. Treat the current OpenCode working directory as `<WORKSPACE_ROOT>`. The git repository may be
   the workspace root or a child up to two levels deep. Locate `.git` first and run git commands
   from that repository.
2. Detect mode:
   - Memory Bank: `<WORKSPACE_ROOT>/.claude/HANDOFF.md` exists.
   - Legacy: otherwise use `<WORKSPACE_ROOT>/HANDOFF.md` when present.
3. In Memory Bank mode:
   - Always read `.claude/HANDOFF.md` in full.
   - Read `.claude/context-pins.md` in full when reasonably sized. If large, read every DNO/PIN
     heading, status, source reference, and recent review entry, then read every entry relevant to
     the current task, changed files, or workflow gates.
   - In `high`, inspect headings and recent tails of `.claude/patterns.md`,
     `.claude/decisions.md`, and `.claude/troubleshooting.md`; derive keywords from HANDOFF, the
     current user request, and git state; use `rg` to load matching sections. Read a file fully if
     it is small, lacks useful structure, has conflicting matches, or is needed for the next task.
   - In `max`, read those three files fully. Also read optional root
     `INTRANET_FULL_BUILD_OUTLINE.md` and `INTRANET_TESTING_OUTLINE.md` when present.
4. Read the shared project baseline from the repository:
   - root `CLAUDE.md`, then `.claude/CLAUDE.md` if distinct;
   - Claude-style `@relative/path.md` imports, recursively up to four hops where practical;
   - Markdown documents those files explicitly require before work;
   - `AGENTS.md` and `AGENTS.override.md` when present. Flag drift unless each is a pointer,
     symlink, or equivalent copy of the same shared baseline.
5. Validate saved progress with `git log --oneline -20`. Flag HANDOFF status that is stale or not
   supported by the commit history.
6. Run readiness gates:
   - `git status --porcelain`: `CLEAN`, `DIRTY` with count, or `KNOWN LOCAL` when HANDOFF explains
     every change as intentional non-feature state;
   - `git branch --show-current`: `SAFE` for a feature branch, `UNSAFE` for `main` or `master`;
   - expected dev port from Vite `server.port`, an explicit Next dev port, or fallback `3000`;
   - HTTP check of that port: `LISTENING` or `NOT RUNNING`. A stopped server blocks only when the
     saved next task requires live verification.
7. Verify that every required file/check above was completed or explicitly report the gap.

In legacy mode, read the root handoff and shared baseline, inspect git status and branch, and
return the same concise orientation without inventing Memory Bank counts.

## Required worker output

Return only this structure:

**Section 1: Readiness**
- `Tree:` CLEAN / DIRTY / KNOWN LOCAL, with count and short reason when applicable
- `Branch:` branch name - SAFE / UNSAFE
- `Dev server:` port - LISTENING / NOT RUNNING / NOT NEEDED
- `Overall:` READY / NOT READY; only unsafe branch, unexpected changes, missing required files,
  or a required stopped server are blockers

**Section 2: Current State**
- One-line project description
- Current task or stretch focus
- Current direction and next target
- Flag stale HANDOFF state and recommend `/save` when required

**Section 3: Blockers & Risks**
- Current blockers and carry-over risks; omit only when there are none

**Section 4: Next Steps**
- Next manual action
- Next assistant action

**Section 5: Verification**
- One line with fidelity, full versus targeted reads, baseline files, gaps/escalations, and active
  DNO/PIN counts when available

> Context loaded from `.claude/` Memory Bank and shared project baseline files. Refer to those files for detail.

