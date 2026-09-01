# pi-notes

`pi-notes` keeps one compact durable continuation/task-state handoff for the current top-level Pi session. `NOTES.md` is not general notes, a diary, or proof.

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

`checkpoint_notes` is sequential, accepts bounded structured semantic state, and has no path/session/hash/generation arguments. It writes a compact durable continuation/task-state handoff—not general notes—to the fixed session-local `NOTES.md`. Each payload field has a mutually exclusive role: `current` is the present objective/status; `completed` is finished work; `findings` are observed facts and constraints; `decisions` are chosen approaches and rationale; `failed_approaches` are failed attempts; `blockers` are unresolved impediments; `verification` contains verification commands/outcomes only; and `next_action` is the one next concrete action. Do not put verification in `completed`, repeat `current` in `next_action`, or copy deterministic working-set facts into authored sections. The extension adds deterministic harness facts internally and atomically rewrites the fixed session-local `NOTES.md`.

`current` and `next_action` accept 1–2,048 characters. Every list item accepts 1–1,024 characters; `completed`, `findings`, `decisions`, and `verification` accept at most 40 items, while `failed_approaches` and `blockers` accept at most 30. The extension validates these limits before Pi's generic tool validator and reports the offending field/path and measured size without echoing rejected state. It never silently truncates, drops, or relocates oversized authored content; summarize it and retry. The tool guidance recommends a smaller budget: `current` ≤400 characters, `next_action` ≤250 characters, at most 3 items per list, and ≤180 characters per item; do not paste plans, logs, raw test output, or file lists.

While Notes is active, built-in `edit`/`write` calls targeting the canonical Notes file are blocked. Unexpected external changes are detected before checkpointing and, when goal integration is present, before allowing goal completion; `/notes restore` rematerializes the trusted committed snapshot.

## Lifecycle

Automatic activation is intentionally conservative: 8 turns or 32 tool calls after high-signal activity, or 10 consecutive read-only turns. Activation signal and checkpoint freshness are independent. Once the handoff is active, high-signal mutations, verification/build/test outcomes, errors, and completed subagent handoffs mark a clean checkpoint dirty immediately. Ordinary successful source reads, searches, and research remain low-signal continuity activity: they do not individually dirty a clean checkpoint or increment the 32-result pressure counter. Sustained read-only investigation marks the handoff dirty once the existing 10-consecutive-turn threshold is reached; normal dirty-turn pressure then applies. Checkpoint commit resets that read-only streak. Checkpoint pressure otherwise begins after 10 additional dirty turns or 32 continuity-relevant high-signal results; each due episode emits at most one ambient checkpoint reminder until a fresh checkpoint or a newly armed due episode. Compaction and completion still enforce freshness immediately.

The extension uses Pi core APIs only:

- `tool_result` for independent high-signal activation, hybrid freshness tracking, and verification tracking.
- `before_agent_start` for the static Notes policy.
- `context` for transient de-duplicated checkpoint/re-entry reminders.
- `pi.appendEntry()` for branch-local dirty/checkpoint state.
- `session_start`, `session_tree`, `session_compact`, and `session_compact_failed` for recovery.

It does not call `pi.setActiveTools()`. If another mode hides `checkpoint_notes`, reminder pressure pauses until the tool becomes available again.

Lifecycle tests cover fresh identities, branch restoration, resume rematerialization, deferred read/research freshness, read-only threshold and streak reset, delayed checkpoint pressure, compaction pressure, inherited-resume integrity, and external-mutation gating.

## Optional integrations

The core has no dependency on goal, plan mode, orchestrator, subagents, memory, or compaction extensions.

When present:

- `goal_progress({ status: "done" })` is blocked while active Notes are dirty or the materialized checkpoint no longer matches the last committed hash.
- `Symbol.for("pi-subagents:child-context:v1")` prevents the extension from registering in child subagent sessions.
- `pi-plan-mode` may explicitly allowlist `checkpoint_notes`; child sessions do not load `pi-notes`.

A task-state checkpoint records continuity state. It is not verification evidence and does not replace a plan, goal, todo system, or completion verifier.
