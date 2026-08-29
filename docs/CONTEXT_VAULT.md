# Context Vault — cross-device memory/context sync

Status: **banked / postponed** (2026-07-16). This document preserves the design and
implementation record, but cross-device sync is not part of the current release prototype.

## Re-read this before resuming (2026-08-29)

The premise below has shifted, and three statements in this document are now wrong. Resuming
from the banked plan without reading this section will build for a layout that no longer exists.

1. **Project memory left the project.** Five days after this was banked, memory moved into the
   Felix Obsidian vault (`…/Felix/Brain/<area>/<project>/memory`), outside the project folder.
   `buildContextBundle` collects `CLAUDE.md`/`AGENTS.md`, `.claude/`, `.codex/`, Claude's central
   memory, and the project workspace — **it does not collect the vault memory home.** So the
   feature as built would sync the marker that points at memory without syncing the memory. Any
   Phase 3 work must settle that first; it is a design question, not an implementation detail.
2. **OneDrive already does most of this.** The vault lives under OneDrive, so the memory itself is
   cross-device today on Windows. What is genuinely unsynced is Cadence's own project workspace
   (notes/tasks, local database only) and the git-ignored instruction files. That is a much
   smaller problem than the one this document was written to solve.
3. **Two "why it never worked" reasons are fixed.** The missing OAuth client ID (reason 2) shipped
   in `72e24ea`; a built-in device-flow client ID is present. The repo-keying hazard was fixed in
   `28626b9` — sync keys by the project's own remote, so a caller-supplied repo can no longer
   point one project's sync at another project's vault. Reasons 1 (manual/opt-in) and 3
   (GitHub-repo-only) still stand.

**Phase 3 was never built** — no auto-restore, no auto-save, no conflict UI. `syncProjectContextToVault`
has exactly one caller: an IPC handler behind a button in the import modal. That, not the feature
gate, is why the vault repo is still empty.

Separately, marker paths are no longer machine-specific: the resolver expands environment
variables and re-homes a path recorded under another account (see `docs/DESIGN.md`, "A
memory-home marker is resolved, not merely read"). The `@` hot-layer imports written into
`CLAUDE.md` remain literal absolute paths — Claude Code reads those, not our resolver, so their
portability is unverified.

## Banked behaviour

`CONTEXT_VAULT_SYNC_ENABLED` in `src/shared/context-vault-feature.ts` is the single
re-entry gate and is intentionally `false`.

- Cadence does not mount project vault status indicators, so local Felix/Obsidian
  changes cannot produce persistent `Conflict` pills in the Sessions sidebar.
- GitHub import remains available, but its context restore and manual sync controls
  are hidden and every import passes `restoreContext: null`.
- The preload bridge rejects direct vault calls with a banked-feature message, and
  the main process does not register vault sync/status/key-management IPC handlers.
- Existing encrypted snapshots, local link metadata, implementation modules, and
  focused crypto/identity tests are preserved untouched for a future dedicated
  cross-device design phase.

Re-enable only as an explicit project after Cadence is a stable release prototype and
Felix has a deliberate multi-device storage, identity, merge, and recovery design.

## Goal

Open a project on any device and Cadence already has the latest memory/context; work
normally; on leave it saves back automatically — and it **never silently overwrites**
newer memory produced on another device. The user must never be permanently locked out.

Content synced is the assistant context that makes Cadence useful, not raw session
history: project `CLAUDE.md` / `AGENTS.md` / `AGENTS.override.md`, everything under
`.claude/` and `.codex/`, native-Windows central memory, and the project workspace
store. (This is what `buildContextBundle` already collects.)

## What already exists (reuse)

- Encrypted snapshot machinery (`github-import-service.ts`): `buildContextBundle`,
  `encryptBundle`/`decryptBundle`, snapshot + `manifest.json` writes to a private
  `cadence-context-vault` GitHub repo via the Contents API, repo-keyed under
  `projects/<repo.key>/`. Restore is repo-matched, passphrase-gated, safe-joined.
- GitHub device-flow OAuth (`github-auth-service.ts`): token stored via Electron
  `safeStorage`, status/sign-out/repo-list, `githubApiJson` helper.

## Why it never worked before

1. **Manual/opt-in** — sync only ran from the import modal on an explicit click.
2. **No OAuth App client ID is shipped** — `configuredClientId` needs
   `CADENCE_GITHUB_CLIENT_ID`/`GITHUB_CLIENT_ID`; without it device-flow sign-in
   errors, so Cadence never had its own token and never created a vault. (The empty
   `wookiesareppl2/cadence-context-vault` repo was created out-of-band by Codex via
   the `gh` CLI's separate auth; Cadence will adopt it since it is private.)
3. **GitHub-repo-only** — `syncProjectContextToVault` bails ("Could not identify a
   GitHub repository") for local-only projects.
4. Prior scoping note said "no cross-machine sync" — that referred to *session
   history*; memory/context sync is the intended mechanism and is now required.

## Design decisions (approved)

- **Sync behaviour:** automatic + safe. Restore-check on project open / app start;
  save on memory-file change (debounced) and on close/switch; warn-before-overwrite
  on divergence. Never auto-merge silently.
- **Recovery model:** an auto-generated random **Data Encryption Key (DEK)** encrypts
  snapshots. Each device unlocks the DEK **automatically** via `safeStorage` (nothing
  typed day-to-day). Two recovery paths so the user can't be locked out:
  1. **GitHub account** — the DEK is retrievable after OAuth (stored in the private
     vault, gated by account access).
  2. **Recovery Key** — a high-entropy code, re-viewable/rotatable from any active
     device; a KEK derived from it (scrypt/HKDF) wraps a copy of the DEK in the vault
     keyring.
  Accepted trade-off: a full GitHub-account takeover could expose decrypted context
  (the ciphertext already lives in that account; GitHub 2FA covers this). Replaces the
  current single-passphrase (scrypt→aes-256-gcm, no recovery) scheme.

## Security-review decisions (2026-07-03, ship gate)

Independent `/security-review` of the Phase 4 crypto found **no HIGH/MEDIUM exploitable
defects**; verdict PASS. The three deferred design questions were settled by the owner:

1. **GitHub-account recovery — BUILD IT (was deferred).** Recovery-Key-only was judged too
   fragile: losing the one key = permanent lockout. So the originally-designed second path
   is implemented: a copy of the DEK lives in the private vault (`keyring.github`), so a
   user who has lost every enrolled device **and** the Recovery Key can still recover by
   signing into GitHub. **This is a conscious, owner-approved override of the "GitHub only
   ever stores ciphertext" guardrail for the recovery copy only** — repo read-access now
   implies context access. Justified because the ciphertext already lives in that account,
   GitHub has mature account recovery (email/2FA backup codes), and the whole identity model
   is GitHub. The Recovery Key remains the zero-trust, fully-offline path for anyone who
   wants it; GitHub recovery is the safety net. Snapshots themselves stay DEK-encrypted (no
   change to at-rest confidentiality of the actual context on GitHub).
2. **scrypt cost (N=32768, r=8, p=1) — KEEP.** Security rests on the Recovery Key's 160-bit
   CSPRNG entropy, not the KDF; brute-force is infeasible at any cost, so the params are
   already conservative. No change.
3. **Snapshot/keyring integrity — GCM + DEK-check is sufficient; anti-rollback deferred.**
   Per-snapshot confidentiality+integrity is solid (AES-256-GCM under the DEK). There is no
   freshness/anti-rollback binding, so an entity with repo **write** (i.e. account
   compromise — already conceded game-over) could downgrade or lock out; this is bounded by
   the local drift model surfacing it as `remote-ahead`/`conflict`. Signed, monotonically
   versioned manifests are a future hardening, not a launch blocker.

Also fixed from the review: **LOW-2** — the API restore path now runs the manifest-supplied
snapshot path through `normalizeBundlePath` (matching the git path's `safeJoin` guard).

## Device-independent project identity (Phase 1)

The same logical project lives at different local paths on different devices, so the
vault key must not be path-derived.

- **GitHub-backed projects** key naturally off the remote:
  `github.com__<owner>__<repo>` — every device agrees with no setup.
- **Other projects** use a generated `vaultProjectId` (UUID) that Cadence persists in
  a local link record (`userData`) and records in the vault **index** with a human
  label + last-synced. On a second device the user links a local folder to a vault
  entry once (Cadence suggests matches by folder name / remote); thereafter automatic.

Pure resolver + index helpers live in `src/shared/context-vault.ts` (Electron-free,
unit-tested) so identity and drift logic are testable without network/auth.

## Drift safety (Phases 2–3)

Every save keeps a full timestamped snapshot (nothing destroyed; manifest keeps 50).
Each device records the snapshot id it last restored/synced from (its **base**).

`detectDivergence({ base, remoteLatest, localChanged })`:

| base vs remoteLatest | localChanged | result | action |
|---|---|---|---|
| both null | — | `uninitialized` | first sync |
| equal | no | `in-sync` | nothing |
| equal | yes | `local-ahead` | safe to push |
| differ | no | `remote-ahead` | safe to restore |
| differ | yes | `conflict` | **ask the user** (keep mine / take theirs / diff) |

## Status surface (Phase 2)

Per-project indicator: **In sync ✓ / Syncing… / Newer available / Conflict / Not
connected**, plus last-synced time. Styled to match the existing GitHub import modal
(PAT-112). Never shows tokens, the DEK, or decrypted context.

## Phased build

- **Phase 0 — Sign-in foundation.** Register a GitHub OAuth App (device flow) and ship
  its (non-secret) client ID; make the in-app Connect flow reachable outside the import
  modal. *Owner action: register the OAuth App and provide the client ID.*
- **Phase 1 — Universal identity.** `src/shared/context-vault.ts` (pure) + local link
  store + vault index; make sync/restore work for non-GitHub projects.
- **Phase 2 — Auto-restore + status.** Restore-check on open; status indicator.
- **Phase 3 — Auto-save + conflict safety.** Memory-file watcher → debounced save;
  `detectDivergence` gating; conflict UI.
- **Phase 4 — Recovery-key model + hardening.** DEK + multi-wrap keyring, Recovery Key
  UI with an unmissable "save this" prompt, integrity checks, tests, and a
  security-review pass on the crypto before ship. *(4a–4d shipped the Recovery-Key path;
  4e adds GitHub-account recovery per the decision above, then this phase is done.)*

## Guardrails

- Nothing pushes to GitHub until built, tested, and the user turns it on.
- Never log the DEK, Recovery Key, or tokens; never persist them to renderer state or to
  local disk in plaintext. safeStorage for at-rest device secrets. Snapshots on GitHub are
  always DEK-encrypted (ciphertext). **Exception (owner-approved, see Security-review
  decisions):** a DEK copy is stored in the private vault to enable GitHub-account
  recovery — the one place the DEK is intentionally retrievable via account access.
- Get the Phase 4 crypto reviewed (security-review) before shipping. *(Done 2026-07-03,
  PASS; GitHub-account recovery is a well-understood addition of the already-analysed
  decision-1 trade-off, not new crypto.)*
