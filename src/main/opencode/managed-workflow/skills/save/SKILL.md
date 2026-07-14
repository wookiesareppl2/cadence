---
name: save
description: Save current project state into the Cadence Memory Bank or legacy handoff so another Claude, Codex, or OpenCode session can resume reliably. Use only for /save or an explicit checkpoint request.
compatibility: opencode
metadata:
  managed-by: Cadence
  workflow-revision: "1"
---

# Save Session State

Checkpoint the current work for reliable cross-provider continuation. Prefer
`.claude/HANDOFF.md` (Memory Bank mode); fall back to root `HANDOFF.md` (legacy mode).

## Non-negotiable delegation boundary

Use exactly one synchronous OpenCode worker for the entire save. The parent may summarize facts
already present in the conversation, but before reading project or memory files, running git
commands, checking ports, or writing anything, call the native task tool once with:

```text
task(
  description="Save the project Memory Bank",
  prompt="<the complete worker contract below, requested fidelity, and a factual session delta>",
  subagent_type="deep-fixer",
  run_in_background=false,
  load_skills=[]
)
```

The session delta must include only facts already known to the parent: current task, completed
work, validation performed, unresolved risks, important user decisions, touched files, and next
actions. The worker verifies those facts against the workspace.

- Do not launch the task in the background.
- Do not call another worker, council, or nested task, including for pin review.
- Do not repeat worker reads, checks, or writes in the parent session.
- Wait for the worker result, then relay its summary without adding unverified claims.
- If the task tool is unavailable or the task fails to start, stop with exactly:
  `SAVE_ABORTED_NO_WORKER: Spec requires single-worker delegation. No save operations were run in the parent session.`

## Fidelity

- `incremental` (default): read operational state fully, inspect bounded deltas, and use targeted
  reads for append-only knowledge and relevant pins.
- `max`, `full`, or `audit`: full audit; read every Memory Bank file and evaluate every active
  DNO/PIN.

Escalate incremental to `max` when the memory structure is missing or malformed, bounded search
cannot prove non-duplication, existing drift is `warn`, pins need bootstrapping, or this follows a
release or major architecture change.

## Worker contract

The single worker owns every read, check, analysis step, and write. It must not delegate.

### 1. Locate and inspect

1. Treat the current OpenCode working directory as `<WORKSPACE_ROOT>`. Locate a git repository at
   the root or up to two levels below it, then run git commands from that repository.
2. Gather:
   - `git log --oneline -20`
   - `git status --short`
   - `git diff --stat`
   - `git branch --show-current`
   - in incremental mode, a bounded name/status log since the last reliable save date or commit;
   - in max mode, also a name/status log for the last three days.
3. Detect Memory Bank mode from `<WORKSPACE_ROOT>/.claude/HANDOFF.md`. Otherwise use legacy mode.

### 2. Load Memory Bank safely

In Memory Bank mode:

- Read `.claude/HANDOFF.md` in full.
- Read `.claude/context-pins.md` in full when reasonably sized. If large, read every DNO/PIN
  heading, status, source reference, recent review entry, and full entries intersecting current
  changes, workflow gates, prior warnings, or the session delta.
- In incremental mode, inspect headings and recent tails of `.claude/patterns.md`,
  `.claude/decisions.md`, and `.claude/troubleshooting.md`; use `rg` with changed paths, symbols,
  distinctive phrases, ADR/PIN titles, and task terms before reading matching sections.
- In max mode, read all Memory Bank files fully.
- Escalate to max when targeted reads cannot establish whether a durable entry is new.

Cross-reference HANDOFF status and the supplied session delta with git history and current files.
Correct stale or unsupported claims instead of preserving them.

### 3. Extract only durable knowledge

Identify new, reusable information from current changes:

- patterns: naming, imports, structures, components, and repeatable workflows;
- decisions: dependencies, architecture, integration boundaries, and deliberate trade-offs;
- troubleshooting: root causes, fixed regressions, environmental constraints, and workarounds.

Search before appending. Never duplicate an existing entry. Append only facts that will matter in
a later session, and escalate to max when duplicate detection remains ambiguous.

### 4. Review pins in the same worker

Evaluate every DNO plus all pins touched by changed files, source references, current gates,
HANDOFF, the session delta, or prior drift warnings. In max mode, evaluate every DNO and PIN.

Use these lifecycle rules:

- IDs are `DNO-###` and `PIN-###`.
- Status is `Active`, `Superseded`, or `Deprecated`.
- Never delete a pin. On replacement, keep it and add `superseded_by: <NEW_ID>`.
- Add a pin only when forgetting the rule would cause regression, rework, or production risk.

If `context-pins.md` is absent, bootstrap the established sections: title, last-updated date, usage
rules, do-not-overwrite invariants, pin lifecycle, active pins, and pin review log. Continue with
the review and use result `INITIAL_BOOTSTRAP`.

### 5. Check drift and dev-server state

- Spot-check all DNOs and relevant pins against current state; check every active pin in max mode
  where feasible. Report `pass` or `warn`, and record any conflicts in HANDOFF and the review log.
- Resolve the expected dev port from Vite `server.port`, an explicit Next dev port, or fallback
  `3000`; record `LISTENING` or `NOT RUNNING`.

### 6. Write the checkpoint

Write Memory Bank files under `<WORKSPACE_ROOT>/.claude/`, even when the git repo is a child.

- `HANDOFF.md`: full replace while preserving its established headings and format. Refresh date,
  workflow state and gates, branch, server, safety checkpoint, quality checks, current task,
  progress, recent changes, stretch focus, blockers, next manual/assistant actions, and important
  versions or risks.
- `patterns.md`, `decisions.md`, `troubleshooting.md`: append-only. Do not touch a file when no new
  durable entry exists, and preserve existing numbering/format.
- `context-pins.md`: targeted edits only. Never rewrite or delete prior entries. Append one review
  log entry on every save:
  `- <DATE> | branch=<BRANCH> | mode=<incremental|max> | result=<RESULT> | drift=<pass|warn> | notes=<SUMMARY>`
- `<RESULT>` must be `PINS_UPDATED`, `NO_PIN_CHANGES`, `INITIAL_BOOTSTRAP`, or
  `MANUAL_BASELINE_UPDATE`. Include a short reason for no-change runs.

In legacy mode, validate git state and fully refresh root `HANDOFF.md` with task, completed work,
next steps, decisions, risks, branch, dirty state, server state, validation, and the supplied
session delta. Do not create `.claude/` implicitly.

### 7. Verify and report

Re-read the changed portions, confirm append-only files were not rewritten, confirm the review log
was appended in Memory Bank mode, and ensure no project source file was modified by the save.

Return only a 5-10 line summary containing:

- files updated and the material change;
- fidelity and any escalation;
- pin-review result and drift result;
- current progress/checkpoint status;
- next manual and assistant actions.

