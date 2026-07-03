# Context Vault — cross-device memory/context sync

Status: **in progress** (approved 2026-07-01). This document is the design of record;
build against it and keep it updated as phases land.

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
