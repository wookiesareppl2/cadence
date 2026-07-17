---
name: cadence-merge-review
description: Enforce Cadence's optional independent review gate when a user asks to merge a pull request or branch, including commit-push-merge workflows. Check the Cadence environment flag before applying it.
---

# Cadence merge review

Apply this workflow only when `CADENCE_MERGE_REVIEW_ENABLED` is exactly `1`. Check the environment in the current terminal before changing the normal merge workflow. If the flag is absent or any other value, stop using this skill and proceed normally.

This gate applies when the requested work includes merging a pull request or branch into its target branch. A commit or feature-branch push by itself does not require the gate.

Before the merge:

1. Finish the intended implementation, run risk-proportionate verification, commit, and push the exact head that would be merged.
2. Record the target branch and exact head commit SHA.
3. Delegate exactly one independent, read-only reviewer. Give it the repository path, target branch, head SHA, user requirements, full diff scope, and verification evidence. Do not give it inherited conversation context or permission to edit, commit, push, merge, release, or approve its own fixes.
4. Require the reviewer to inspect the full target-to-head diff for correctness, regressions, security or data-loss risk, missing tests, and requirement coverage. Its response must identify the reviewed SHA and return exactly one verdict: `PASS`, `BLOCK`, or `ESCALATE`, with concrete findings.
5. Merge only after `PASS` and only if the user already authorized the merge. Immediately before merging, verify that the current remote head still equals the reviewed SHA.

If the verdict is `BLOCK`, do not merge. Address the findings, push a new head, and have the same independent reviewer review the new SHA. If the verdict is `ESCALATE`, or the head changed after review, stop and report the issue to the user.

This gate never authorizes a merge or a release. Releases remain a separate explicit user action.
