# pi-subagents-local

A local, intentionally small variant of `@tintinweb/pi-subagents` **v0.18.2**.

This package carries the upstream source plus the approved durable-routing
change: explicit `Agent` model/thinking parameters take precedence over
agent-card defaults, while other card safety/strategy fields retain their
upstream precedence.

This local fork also deliberately publishes a small compatibility probe for
sibling extensions. `Symbol.for("pi-subagents:child-context:v1")` contains a
function, not a cached boolean; call it while loading an extension to determine
whether execution is currently inside `runInChildSessionContext`. Its result is
read dynamically from the async-local context, so concurrent parent and child
session loading remains isolated. The versioned global is a local divergence
from upstream and is intentionally limited to this compatibility contract.

## Durable routing and verifier contracts

**Fresh type resolution.** Every fresh spawn reloads the current project/global
agent cards before resolving `subagent_type`. A name must identify exactly one
enabled card (case-insensitive matching is allowed only when unambiguous);
unknown, disabled, missing, and case-ambiguous names fail closed before a
spawn. `fallbackSubagent` defaults to `"none"`: only an explicitly configured,
uniquely resolvable, enabled fallback card may replace a bad request. An invalid
fallback also fails closed; nothing silently falls back to `general-purpose`.
Settings merge global defaults first and project values second, so
`<project>/.pi/subagents.json` overrides `~/.pi/agent/subagents.json`, including
an explicit `"none"`.

**Global installation contract.** The default global install must provide these
canonical cards under `~/.pi/agent/agents/`: `ImplementationWorker.md`,
`LunaCompliance.md`, and `LunaTestVerifier.md`. It must also keep the global
fallback strict in `~/.pi/agent/subagents.json`:

```json
{"fallbackSubagent":"none"}
```

Project cards may replace global cards with the same name, but cannot replace
the verifier safety contract. For fresh runs, the immutable Luna policy is
looked up by the canonical resolved type and reapplied after project-card and
call-site resolution. `LunaCompliance` has no `bash`/Bash tool. `LunaTestVerifier` requires a
disposable, detached source-snapshot worktree: `isolation: "worktree"`,
`finalization: "discard"`, and `snapshotSource: true`; if worktree isolation
is unavailable, it fails instead of downgrading to the shared checkout.

**Worktree strategy and snapshots.** The effective strategy fields are
`finalization: "commit" | "discard"` and `snapshotSource: boolean` (the
agent-card/call-site strategy fields resolve into these values). They default
to ordinary commit finalization and no source snapshot; discard implies a
snapshot unless explicitly overridden. A disposable verifier worktree starts
at detached `HEAD`, has no branch, and is never committed or branched. Its
snapshot includes the tracked `HEAD` diff (staged and unstaged changes,
including deletions/binaries) and all untracked paths. Paths, symlinks, and the
copied overlay are validated, and the source is re-read to reject a changing or
incomplete snapshot. Snapshotting and cleanup never modify, stage, commit,
clean, or copy changes back to the source checkout.

**Terminal cleanup.** Every terminal path is explicit: failed worktree
creation/overlay/validation removes any partial worktree and prunes Git
metadata; disposable completion, agent failure, or inspection failure always
force-removes and prunes in `finally` (an inspection error is still surfaced),
without staging, committing, or branching—even after an internal commit.
Ordinary completion or agent failure with no changes removes the worktree;
ordinary changes or an existing agent commit are finalized on a branch and then
removed. Ordinary commits run normal repository hooks (never `--no-verify`). If
ordinary commit, hook, branch, or other finalization fails, the worktree and
changes are preserved and the error, including its path, is surfaced. Shutdown
also prunes orphaned worktree registrations.

Resume semantics are unchanged: resume reopens the existing session/transcript
with its historical context and tools, is not a fresh spawn, creates no new
worktree, and does not reinterpret the session through current fallback or
verifier policy.

This is a local fork, not an independently maintained implementation. Rebase
onto the installed upstream `@tintinweb/pi-subagents@0.18.2` before carrying
forward future upstream changes; do not merge unrelated local edits.
