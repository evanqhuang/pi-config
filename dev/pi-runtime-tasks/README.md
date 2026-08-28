# pi-runtime-tasks-local

Session-owned runtime jobs for Pi. Runtime jobs represent executing work; they
intentionally remain separate from `rpiv-todo` work items and dependencies.

The package provides:

- `run_background_bash` for explicit detached, noninteractive shell execution
- `runtime_task_list`, `runtime_task_output`, `runtime_task_wait`, and
  `runtime_task_kill`
- a session-scoped provider registry with a packaged adapter for the canonical
  `pi-subagents-local` records
- exact optional ownership metadata (`goalId`, `goalGeneration`) for `/goal`
  coordination

The subagent adapter observes normal `Agent` tool launches plus programmatic and
lifecycle surfaces. It does not create another runner or notification system.
Waits consume results through the existing subagent RPC so the manager's held
completion nudge is not duplicated, and stop requests use the manager's own
queued/running-agent behavior. Internal `GoalJudge` records are hidden from the
public task list.

Shell output is written outside the project checkout under Pi's session state,
read through bounded cursor-based calls, and capped at 5 GiB per task. Shell
process groups are terminated on explicit stop and session shutdown.

## Detachment boundary

Pi's extension API does not expose the child-process handle for an already
running built-in Bash tool call. Therefore this package provides explicit
background execution rather than pretending to convert an in-flight built-in
Bash call into a background job by restarting it. True in-place Ctrl+B
conversion requires a Pi core hook that preserves the same process and output
stream.
