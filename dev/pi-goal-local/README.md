# pi-goal-local

Owned native `/goal` implementation for this pi-config profile.

## Commands

- `/goal <objective>`
- `/goal <objective> -- <criterion 1>; <criterion 2>`
- `/goal status`
- `/goal pause`
- `/goal resume`
- `/goal stop`
- `/goal clear`

Goal state is append-only under `pi-goal-state-v1` and is reconstructed from the currently selected session branch. Legacy `goal-state` entries are ignored.

Evaluation runs only after `agent_settled`. Active/queued subagents conservatively defer evaluation. `GoalJudge` is a one-turn non-mutating completion judge; candidate completion must then pass the independent read-only `GoalVerifier` in a disposable source-snapshot worktree.

This package intentionally does **not** implement runtime-task infrastructure, background shell execution, task ownership/attribution, foreground detachment, Pi-core changes, or automatic code review.
