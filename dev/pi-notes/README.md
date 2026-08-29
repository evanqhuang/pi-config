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
- `/notes checkpoint` — request a model-authored checkpoint immediately when the agent is idle.
- `/notes resume` — explicitly seed a fresh fork/session identity from a compatible inherited checkpoint, baseline the materialized copy for integrity checks, and require a new checkpoint before relying on it.
- `/notes restore` — rematerialize the latest committed checkpoint for the active branch while preserving its clean/dirty state.

## Tool

`checkpoint_notes` is sequential, accepts bounded structured semantic state, and has no path/session/hash/generation arguments. The extension adds deterministic harness facts and atomically rewrites the fixed session-local `NOTES.md`.

While Notes is active, built-in `edit`/`write` calls targeting the canonical Notes file are blocked. Unexpected external changes are detected before checkpointing and, when goal integration is present, before allowing goal completion; `/notes restore` rematerializes the trusted committed snapshot.

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

- `goal_progress({ status: "done" })` is blocked while active Notes are dirty or the materialized checkpoint no longer matches the last committed hash.
- `Symbol.for("pi-subagents:child-context:v1")` prevents the extension from registering in child subagent sessions.
- `pi-plan-mode` may explicitly allowlist `checkpoint_notes`; child sessions do not load `pi-notes`.

A Notes checkpoint records continuity state. It is not verification evidence and does not replace a plan, goal, todo system, or completion verifier.
