# pi-goal-local

A persistent, session-scoped `/goal` loop backed by the existing
`pi-subagents-local` runtime.

- `/goal <condition>` sets or replaces the active goal.
- `/goal` reports the latest state.
- `/goal clear` clears it.
- `/goal resume` restarts a paused goal with a fresh generation and budget.

After a parent turn settles, the extension waits only for runtime tasks carrying
the exact active `{goalId, goalGeneration}`. It then runs the isolated,
tool-less `GoalJudge` agent against bounded transcript evidence. A failed or
malformed evaluator run retains the goal and returns control; it is never
interpreted as successful completion.

The loop rejects stale evaluator results after replacement, restores state from
the active session branch, and pauses after eight evaluations or one hour.
