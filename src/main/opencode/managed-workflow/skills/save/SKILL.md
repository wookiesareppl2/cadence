---
name: save
description: Save session state to the project's Felix vault memory home, creating that memory home first if the project has not been set up yet, including tiered memory writes, hot-pin curation, drift checks, and the daily note. Use only for /save or an explicit checkpoint request.
compatibility: opencode
metadata:
  managed-by: Cadence
  workflow-revision: "3"
---

# Save Session State

Resolve the project's memory home first, then delegate the entire save workflow to exactly one worker.

## Step 1 — Get the memory route

Run this now. It is the first action of this skill:

```bash
bash "${OPENCODE_CONFIG_DIR:-$HOME/.config/cadence/opencode}/scripts/route.sh"
```

It prints the route in one call. Every write in this skill goes to the memory home it
names, so run it before reading files, running git, delegating, or writing anything.

Use the printed `MEMORY_ROUTE` verbatim. It is the only valid source of the route:

- `MEMORY_ROUTE=vault` → **Vault Mode**, writing to `<MEMORY_HOME>` as printed. That
  folder is this project's memory: read from it, write to it, and cite it. Any legacy
  bank still present in the repo is a frozen artifact the resolver has already accounted
  for.
- `BOOTSTRAP=required` → this project has no vault memory home **yet**. Run **Bootstrap**
  below to create one, then save to it in Vault Mode. This is the normal path for a
  project's first save. The resolver prints `MEMORY_HOME_DECISION=ask`: it never proposes
  a location, so you must get one from Sheldon before creating anything. Note the
  `MEMORY_HOME` on the line above is the LEGACY path it is routing away from — never
  bootstrap into it.
- `MEMORY_ROUTE=abort` → stop immediately, write nothing, and report exactly:
  `SAVE_ABORTED_BAD_ROUTE: <REASON>`.

**This skill has exactly one write destination: a vault memory home** — the
`<MEMORY_HOME>` the resolver printed, or the one Bootstrap just created. Every write goes
through the collector, pointed at that folder.

The Obsidian vault is the permanent single source of truth for Sheldon's AI work.

## Bootstrap — when the project has no vault memory home

A first save on an unmigrated project sets the memory system up, exactly as a first save
on a new project always has. Run the shipped script; do not create the files by hand — the
skeleton must satisfy the collector's validator, and hand-built ones do not.

**ASK FIRST — the location is never assumed.** Stop and ask Sheldon which vault area this
project belongs in, offering the areas the resolver printed in `VAULT_AREAS` and saying
which project you are asking about. Accept an area he names that is not on the list, or a
full path of his choosing; the list is what exists today, not a closed set. Only once he
has answered, compose the memory home as `MEMORY_HOME_FORM` describes and run the script.

Do not guess, do not default to whichever area other projects use, and do not proceed on
silence. A memory home cannot be relocated afterwards without tripping the guard that
stops one project's save landing in another project's vault, so a wrong answer here is
expensive and a question is cheap.

```bash
"$NODE" "$CFG/scripts/bootstrap-vault-memory.mjs" \
  --workspace "<WORKSPACE_ROOT>" \
  --memory "<VAULT_ROOT>/<area Sheldon chose>/<PROJECT_NAME>/memory"
```

- It creates the memory home, copies any legacy `.claude/` bank **verbatim** into
  `Archive/legacy-bank/`, and writes the memory-home marker into the project's `CLAUDE.md`.
- It refuses if the target already holds memory files. If it refuses, **stop and report** —
  never point it somewhere else to get past the refusal. That guard is what stops one
  project's save landing in another project's vault.
- If `VAULT_ROOT=unknown`, the vault itself could not be located — stop and ask; do not
  invent a path.
- On `BOOTSTRAP=ok`, continue with the Vault Mode contract using the new `<MEMORY_HOME>`.
  Treat the archived legacy bank as source material: promote entries it justifies as part
  of this save, rather than bulk-converting it.

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

- **Transmit the worker contract below verbatim.** Copy it as written; do not paraphrase
  it, summarize it, shorten it, or substitute instructions you remember from an earlier
  version of this skill. Only substitute the placeholder values (resolved mode, paths,
  resolved fidelity, session delta). Rewriting the contract silently drops its guards.
- Do not launch the task in the background.
- Do not call another worker, council, or nested task, including for pin review.
- Do not repeat worker reads, checks, or writes in the parent session.
- Wait for the worker result, then relay its summary without adding unverified claims.
- If the task tool is unavailable or the task fails to start, stop with exactly:
  `SAVE_ABORTED_NO_WORKER: Spec requires single-worker delegation. No save operations were run in the parent session.`

## Fidelity

There are exactly two: `incremental` and `max`. Any other value is a typo and the collector fails the save rather than silently doing less than asked.

- `incremental` (default): budgeted save. Read operational state fully, inspect bounded git/session deltas, and use targeted reads of append-only memory files and relevant pins.
- `max`: full audit; read every live memory file and evaluate every active DNO/PIN.

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
"$NODE" "$COLLECTOR" --mode state --memory "<MEMORY_HOME>" --workspace "<WORKSPACE_ROOT>" --fidelity <MODE>
```

`--fidelity` is passed HERE and nowhere else. The collector records it in the manifest, and both the apply and validate steps read it from there — so they cannot disagree about which mode this save is.

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
"$NODE" "$COLLECTOR" --mode validate --manifest "<MANIFEST>" --memory "<MEMORY_HOME>" --workspace "<WORKSPACE_ROOT>" --changed "<APPLIED_CHANGED>"
```

Require `SAVE_VALIDATION=PASS`. On FAIL, read the `ERROR=` lines, build ONE corrective plan (for example create a missing referenced entry, or fix content), re-apply, and re-validate once. If it still fails, return `SAVE_VALIDATION_FAILED` with the manifest path and exact errors — never claim a successful checkpoint. Do not fall back to hand-editing memory files.

### Step 7 — Report

Return only a 5-10 line summary: files updated and the material change; fidelity and any escalation; pin-review result; **hot-layer promotions/demotions explicitly**; anything archived; drift result; validation result; next manual and assistant actions.

## There is no legacy write mode

Earlier revisions of this skill could write directly into a project's `.claude/` bank. That
mode is gone. It existed only for projects that had not migrated, and Bootstrap above now
covers them by creating a proper vault memory home instead.

This matters because a mis-resolved route used to be able to write a session's memory into a
frozen bank, losing it. Removing the mode removes the destination: there is nothing to
mis-route *to*. If the resolver does not print `MEMORY_ROUTE=vault`, either Bootstrap runs
first, or the save aborts. Those are the only two outcomes.

A project's `.claude/` bank may be read and archived. It is never written.
