---
name: save
description: Save session state to its declared Felix vault memory home, a legacy Memory Bank, or a root handoff, including tiered memory writes, hot-pin curation, drift checks, and the daily note. Use only for /save or an explicit checkpoint request.
compatibility: opencode
metadata:
  managed-by: Cadence
  workflow-revision: "2"
---

# Save Session State

Resolve the project's memory home first, then delegate the entire save workflow to exactly one worker.

## Resolve the memory home first

The parent may read only the project baseline needed for routing (`CLAUDE.md` at the workspace/repo root and `.claude/CLAUDE.md` if distinct) and test file existence. It must not read memory content, run git checks, or write anything itself.

Choose the first matching mode:

1. **Vault Mode** — a project baseline contains this machine-readable marker:
   `Felix memory home — Windows: ` `` `<win path>` `` ` · WSL: ` `` `<wsl path>` ``
   Extract both backtick-quoted paths. OpenCode runs under WSL, so **select the WSL path**. Call it `<MEMORY_HOME>`.
2. **Legacy Bank Mode** — no marker, but `<WORKSPACE_ROOT>/.claude/HANDOFF.md` exists.
3. **Legacy Root Mode** — neither condition matches; use root `HANDOFF.md`.

The Obsidian vault is the permanent single source of truth for Sheldon's AI work. Legacy modes are transition scaffolding for projects not yet migrated, never the preferred endpoint. **Never write to a project's `.claude/` bank when the vault marker is present** — that bank is frozen.

## Non-negotiable delegation boundary

Use exactly one synchronous OpenCode worker for the entire save. The parent may summarize facts already present in the conversation, but before reading project or memory files, running git commands, checking ports, or writing anything, call the native task tool once with:

```text
task(
  description="Save the project memory",
  prompt="<the complete worker contract below, the resolved mode and paths, requested fidelity, and a factual session delta>",
  subagent_type="deep-fixer",
  run_in_background=false,
  load_skills=[]
)
```

The session delta must include only facts already known to the parent: current task, completed work, validation performed, unresolved risks, important user decisions, touched files, and next actions. The worker verifies those facts against the workspace.

- Do not launch the task in the background.
- Do not call another worker, council, or nested task, including for pin review.
- Do not repeat worker reads, checks, or writes in the parent session.
- Wait for the worker result, then relay its summary without adding unverified claims.
- If the task tool is unavailable or the task fails to start, stop with exactly:
  `SAVE_ABORTED_NO_WORKER: Spec requires single-worker delegation. No save operations were run in the parent session.`

## Fidelity

- `incremental` (default): budgeted save. Read operational state fully, inspect bounded git/session deltas, and use targeted reads of append-only memory files and relevant pins.
- `max`, `full`, or `audit`: full audit; read every live memory file and evaluate every active DNO/PIN.

Escalate incremental to `max` when the memory structure is missing or malformed, bounded search cannot prove non-duplication, existing drift is `warn`, pins need bootstrapping, or this follows a release or major architecture change.

## Vault Mode worker contract

**All memory WRITES go through the shared collector engine** (`scripts/collect-vault-save.mjs`, byte-identical to the Claude and Codex copies) so all three platforms produce identical, validated results — parity is guaranteed by shared code, not by three prose skills agreeing. The collector owns all mechanical correctness: it stamps the four `_Index` live counts to the true post-apply value, normalizes every appended/inserted entry heading to the file's canonical level, guarantees a Pin Review Log line, and validates the whole save (counts, dangling references, frontmatter, HANDOFF headings, ascending daily sessions, frozen-bank safety). The worker supplies CONTENT and JUDGMENT; it NEVER hand-edits a memory file.

Resolve the tools first, in the worker's shell:

```bash
COLLECTOR="${OPENCODE_CONFIG_DIR:-$HOME/.config/cadence/opencode}/scripts/collect-vault-save.mjs"
NODE="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; NODE="$(command -v node 2>/dev/null || true)"; fi
[ -z "$NODE" ] && NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -1)"
```

If `$NODE` or `$COLLECTOR` cannot be resolved, stop with `SAVE_ABORTED_NO_COLLECTOR: <what was missing>` and write nothing.

Tiered layout at `<MEMORY_HOME>` (do not flatten): `_Index.md` (map — counts owned by the collector), `HANDOFF.md` (hot state, full-replace, kept tight), `Pins.md` (HOT: all DNOs + high-impact PINs), `Pins-Reference.md` (other active PINs + Pin Review Log), `Decisions.md`/`Patterns.md`/`Troubleshooting.md` (live entries), `Archive/` (superseded + `_Archive Index.md`). `<VAULT_ROOT>` is the first ancestor of `<MEMORY_HOME>` containing `VAULT-INDEX.md`. The vault lives under `/mnt/c` and may be slow; do not retry a successful read.

### Step 0 — Daily note (create only if absent)

If today's NZ-dated note `<VAULT_ROOT>/01 - Daily Notes/YYYY-MM-DD.md` does NOT exist, create it now from `01 - Daily Notes/Daily Note Template.md` for body structure, forcing frontmatter `status: active` / `project: personal` / `type: log`, removing every HTML template-comment line, and writing your first `## Session 1` with the session body. Do this BEFORE Step 1 so the manifest snapshots it. If it already exists, do nothing here — append a session via the plan in Step 4.

### Step 1 — Orientation + manifest (collector)

```bash
"$NODE" "$COLLECTOR" --mode state --memory "<MEMORY_HOME>" --workspace "<WORKSPACE_ROOT>"
```

Capture `MANIFEST=<path>`, plus the git state, changed paths, `NEXT_IDS` (next DNO/PIN/ADR/PAT/TS ids), the NZ daily path, and the latest Pin Review Log line. The manifest snapshots pre-save state — do NOT hand-edit any memory file or the daily note after this point (the collector rejects a save if they change out from under it).

### Step 2 — Load context (read-only)

Read `HANDOFF.md` and `Pins.md` in full. In `incremental`, read `Pins-Reference.md`/`Decisions.md`/`Patterns.md`/`Troubleshooting.md` targeted (headings + tails + `rg` for candidate terms, changed paths, ADR/PIN titles); in `max`, read them in full. Read the shared project baseline (`CLAUDE.md`, `.claude/CLAUDE.md` if distinct, required docs, `AGENTS.md` drift check). Cross-reference HANDOFF and the session delta against git; correct stale or unsupported claims in the new HANDOFF rather than preserving them.

### Step 3 — Decide durable changes (judgment)

- New patterns/decisions/troubleshooting: only genuinely new + durable, using `NEXT_IDS`. Search before appending; never duplicate. Escalate to `max` when duplicate detection stays ambiguous.
- New PIN → `Pins-Reference.md`; new DNO (foundational) → `Pins.md`.
- **Auto-curate the hot layer (required every save):** always hot = every `DNO` (never demoted); a `PIN` is hot iff BOTH (a) high blast radius — violating it causes a security hole, data loss, a build/packaging failure, the app failing to launch, a release/publish break, or a broken CORE workflow — AND (b) cross-cutting — constrains many tasks or is a process/workflow gate, not a localized single-component/UI detail. No fixed cap; never drop a qualifying pin to hit a number; anti-thrash (demote only on a CLEAR failure of the criteria). Promotion/demotion is a MOVE between `Pins.md` and `Pins-Reference.md`; nothing is deleted.
- **Archive** genuinely superseded/retired entries: MOVE them into the matching `Archive/Superseded *.md` and add a line to `Archive/_Archive Index.md`. Archive is distinct from demotion (demotion = still active but not hot). Never delete.
- **Pin review + drift:** evaluate every DNO, pins whose source refs intersect changed files, and pins named by HANDOFF/task/diff/session delta (every pin in `max`); spot-check against the codebase; determine drift `pass`/`warn` (on `warn`, record conflicts in the new HANDOFF and the review line).
- **Referential integrity:** every entry ID you cite in a Source/Refs field must be created in THIS save or already exist, or validation fails with a dangling-reference error.

### Step 4 — Build the plan JSON

Express ALL writes as one plan object and write it to `<MANIFEST>.plan.json` (omit empty keys):

```json
{
  "replace": { "HANDOFF.md": "<complete new TIGHT HANDOFF, headings preserved>" },
  "appendEntries": { "Decisions.md": ["## ADR-<next>: ..."], "Patterns.md": ["## PAT-<next>: ..."], "Troubleshooting.md": ["## TS-<next>: ..."], "Pins.md": ["### DNO-<next>: ..."] },
  "insertBefore": { "Pins-Reference.md": [{ "heading": "## Pin Review Log", "text": "### PIN-<next>: ..." }] },
  "replaceEntries": { "<file>": [{ "id": "PIN-...", "text": "<full replacement entry>" }] },
  "removeEntries": { "<source file>": ["<id being promoted/demoted/archived>"] },
  "appendText": { "Pins-Reference.md": "- <DATE> | branch=<BRANCH> | mode=<MODE> | result=<PINS_UPDATED|NO_PIN_CHANGES> | drift=<pass|warn> | hot_changes=<ids or none> | notes=<summary>" },
  "daily": { "indexLine": "- **Topic** - outcome.", "session": "## Session N - <NZ time>: Title\n..." }
}
```

Rules: NEVER put `_Index.md` counts in the plan (the collector stamps them; include `_Index.md` in `replace` only for material structure/status PROSE). A promotion/demotion/archival is `removeEntries` in the source file + `appendEntries`/`insertBefore` in the destination. HANDOFF stays TIGHT (it is hot/always-loaded); deep detail belongs in the on-demand files. Include `daily` ONLY if today's note already existed at Step 0 (append a new `## Session N`, never overwrite an earlier one). Preserve frontmatter and `[[wikilinks]]` in any full replacement. Provide a real drift-checked Pin Review Log line via `appendText`; if you omit it the collector adds an honest `drift=unverified` placeholder, which is worse than a real one.

### Step 5 — Apply (collector writes)

```bash
"$NODE" "$COLLECTOR" --mode apply --manifest "<MANIFEST>" --plan "<MANIFEST>.plan.json" --cleanup-plan true
```

Capture `APPLIED_CHANGED` from the output.

### Step 6 — Validate (required)

```bash
"$NODE" "$COLLECTOR" --mode validate --manifest "<MANIFEST>" --memory "<MEMORY_HOME>" --workspace "<WORKSPACE_ROOT>" --fidelity <MODE> --changed "<APPLIED_CHANGED>"
```

Require `SAVE_VALIDATION=PASS`. On FAIL, read the `ERROR=` lines, build ONE corrective plan (for example create a missing referenced entry, or fix content), re-apply, and re-validate once. If it still fails, return `SAVE_VALIDATION_FAILED` with the manifest path and exact errors — never claim a successful checkpoint. Do not fall back to hand-editing memory files.

### Step 7 — Report

Return only a 5-10 line summary: files updated and the material change; fidelity and any escalation; pin-review result; **hot-layer promotions/demotions explicitly**; anything archived; drift result; validation result; next manual and assistant actions.

## Legacy Bank Mode (no vault marker; `.claude/HANDOFF.md` exists)

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

### 2. Load Memory Bank safely

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

### 7. Verify and report

Re-read the changed portions, confirm append-only files were not rewritten, confirm the review log
was appended, and ensure no project source file was modified by the save. Return the same 5-10 line
summary shape as Vault Mode.

## Legacy Root Mode (no vault marker and no `.claude/HANDOFF.md`)

Validate git state and fully refresh root `HANDOFF.md` with task, completed work, next steps,
decisions, risks, branch, dirty state, server state, validation, and the supplied session delta. Do
not create `.claude/` implicitly. Return a brief save summary.

## Context preservation rules (legacy modes only)

These do not override Vault Mode, where Step 3 authorizes archiving only entries proven genuinely
superseded or retired.

- Prefer additive updates over replacement in long-term memory files.
- Do not archive, prune, or compress Memory Bank content unless explicitly requested.
- When uncertain about long-term importance, keep the detail.
- When uncertain whether targeted reads are sufficient, escalate to `max` before writing.
