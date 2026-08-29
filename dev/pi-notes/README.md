# pi-notes

`pi-notes` keeps one compact durable execution checkpoint for the current top-level Pi session.

## Storage

Notes are never written into the project tree. Each top-level session owns:

```text
<getAgentDir()>/notes/<notes-id>/NOTES.md
```

`/new` and `/fork` create fresh identities. `/tree` keeps the same identity and rematerializes the checkpoint belonging to the selected branch.

## Commands

- `/notes` or `/notes status` — show activation, dirty state, generation, path, and tool-policy status.
- `/notes on` — activate immediately.
- `/notes off` — disable tracking/reminders without deleting the file.
- `/notes auto` — use conservative automatic activation.
- `/notes checkpoint` — request a model-authored checkpoint on the next turn.
- `/notes resume` — explicitly seed a fresh fork/session identity from a compatible inherited checkpoint.
- `/notes restore` — rematerialize the latest committed checkpoint for the active branch.

## Tool

`checkpoint_notes` is sequential, accepts bounded structured semantic state, and has no path/session/hash/generation arguments. The extension adds deterministic harness facts and atomically rewrites the fixed session-local `NOTES.md`.

While Notes is active, built-in `edit`/`write` calls targeting the canonical Notes file are blocked. Unexpected external changes are detected at checkpoint/restore boundaries.

## Lifecycle

The extension uses Pi core APIs only:

- `tool_result` for meaningful activity and verification tracking.
- `before_agent_start` for the static Notes policy.
- `context` for transient de-duplicated checkpoint/re-entry reminders.
- `pi.appendEntry()` for branch-local dirty/checkpoint state.
- `session_start`, `session_tree`, `session_compact`, and `session_compact_failed` for recovery.

It does not call `pi.setActiveTools()`. If another mode hides `checkpoint_notes`, reminder pressure pauses until the tool becomes available again.

## Optional integrations

The core has no dependency on goal, plan mode, orchestrator, subagents, memory, or compaction extensions.

When present:

- `goal_progress({ status: "done" })` is blocked while active Notes are dirty.
- `Symbol.for("pi-subagents:child-context:v1")` prevents child sessions from writing parent Notes.
- `pi-plan-mode` may explicitly allowlist `checkpoint_notes`; child sessions remain blocked by `pi-notes` itself.

A Notes checkpoint records continuity state. It is not verification evidence and does not replace a plan, goal, todo system, or completion verifier.
