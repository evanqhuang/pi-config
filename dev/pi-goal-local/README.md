# pi-goal-local

Owned native `/goal` implementation for this pi-config profile.

## Commands and syntax

- `/goal <objective>` — the existing branch-local V1 goal.
- `/goal <objective> -- <criterion 1>; <criterion 2>` — add acceptance criteria.
- `/goal <objective> --loop --plan <path>` — start an opt-in V2 fixed-point loop from an explicit plan.
- `/goal <objective> --loop` — start from the latest plan approved by `pi-plan-mode`.
- `/goal <objective> --loop --max-cycles <n>` — bound corrective replans (`1`–`100`).
- `/goal <objective> --verify` — start V2 with one no-edit parent verification turn.
- `/goal <objective> --implement` — start V2 at the normal implementation entry.
- `/goal fresh` — start a new V2 loop from the latest approved plan.
- `/goal fresh --verify` or `/goal fresh --implement` — choose the fresh loop entry.
- `/goal status`, `/goal pause`, `/goal resume`, `/goal stop`, `/goal clear`

Loop and entry flags may be combined with an objective and criteria in any order. `--verify` and `--implement` are mutually exclusive boolean switches. Either switch implies V2, so `--loop` is not required. Quoted plan paths are supported. The `/goal` autocomplete offers management, loop, and entry switches; while editing a `--plan` value it delegates to Pi's ordinary file/path completion. `/goal start` remains a V1 objective, not a subcommand.

The startup flags `--goal-loop`, `--goal-plan <path>`, and `--goal-max-cycles <n>` retain their existing behavior. The global `--verify` and `--implement` switches provide V2 startup entry selection, for example `pi --verify --goal-plan plans/approved.md` or `pi --implement --goal-plan plans/approved.md`. An explicit plan always wins over the approved-plan bridge, and `--verify` still requires a plan through that same resolution path. Without either source, a loop start fails closed rather than treating an ordinary V1 goal as a loop.

A verify entry performs one no-edit parent verification turn against the immutable plan snapshot, then follows the unchanged `GoalJudge` → `GoalVerifier` flow. The `verifying` phase remains evaluator-only: it never grants the parent permission to edit. `--verify` and `--implement` cannot be supplied together. Start a fresh Pi process after changing this extension; a full Pi restart is required to load extension changes.

## Effective boundary

V1 goals retain their existing behavior and format. Only an active V2 loop (`implementing`, `verifying`, or `replanning`) changes provider context: the `context` hook retains the latest valid loop epoch marker and complete current tool traffic. V1 goals, ordinary/non-loop `/goal` commands, paused loops, and terminal loops are not filtered.

`/goal status` for a loop includes its loop ID, generation, correction cycle/max, context epoch, phase, and the latest bounded reason. Goal loops are strictly opt-in: plan approval and PLAN, YOLO, ORCHESTRATOR, or PREWALK transitions never start one. An explicit `/goal ... --loop` command may resolve the latest approved plan and preserves its approved YOLO, ORCHESTRATOR, or PREWALK strategy; the goal controller does not silently substitute another strategy.

## Artifacts and recovery

Loop-owned files are private, append-once artifacts under:

```text
~/.pi/agent/goal-loops/<loopId>/original-plan.md
~/.pi/agent/goal-loops/<loopId>/cycle-<n>-plan.md
```

The original plan is copied and hashed before V2 state is published. Corrective plans are similarly bounded, immutable, and hash-recorded. Durable V2 state and hidden context-epoch markers are reconstructed from the selected session branch; mutable source plans are never used for later evaluation.

A reopened active loop is paused and requires `/goal resume`. Explicit tree selection carries an active loop onto an empty branch as paused; only an ordinary `/goal resume` with verified selected-branch continuity adopts that branch at a fresh epoch. Manual same-branch pause/resume retains its current epoch. Compaction remains its own context boundary, and an ordinary queued post-compaction continuation may advance the leaf without invalidating its rebootstrap; navigation still invalidates stale wakes and in-flight evaluations. Failed or aborted compaction is not treated as a recovery boundary. Session shutdown cancels pending work and removes bridge listeners.

## Safety

Loop state is strict V2 data and malformed/latest conflicting markers fail closed. Epoch bootstraps are canonical, size-bounded, hash-checked, and tied to the loop generation, correction cycle, and context epoch. The context filter never mutates its input and never keeps an incomplete tool-call/result suffix; a missing or incomplete current epoch pauses automatic continuation instead of issuing a provider turn with reset context. Artifact sources and destinations must be regular, non-symlinked files in the intended roots. User pause/stop/clear, navigation, aborts, missing approved plans, unavailable evaluators, and unsafe PREWALK continuation do not fall back to unrestricted automation.

This package intentionally does **not** implement runtime-task infrastructure, background shell execution, task ownership/attribution, foreground detachment, Pi-core changes, automatic code review, or plan-mode approval itself.
