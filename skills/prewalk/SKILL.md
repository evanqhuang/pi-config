---
name: prewalk
description: Use when the user explicitly requests a guided exploration followed by an implementation handoff after the first accepted file change. Launches the local prewalk runner; do not use for ordinary tasks.
---

# Prewalk

This skill is an explicit launcher for a two-phase coding session.

The current session is an orchestrator only. Do not edit files, run tests, or
start a second implementation path yourself. Launch the runner and report its
progress and final status.

## Invocation

Use the bundled launcher with the complete user task:

```bash
"$HOME/.agents/skills/prewalk/scripts/run-prewalk" --prompt-stdin <<'PREWALK_TASK'
<the user's task, copied exactly>
PREWALK_TASK
```

Use a single-quoted heredoc delimiter so task text is passed literally. Do not
put secrets in the task. The runner operates on the current working directory.

## Defaults

- Guide model: `PREWALK_GUIDE_MODEL` or `gpt-5.6-sol`, with `medium` effort by
  default (`PREWALK_GUIDE_EFFORT`).
- Executor model: `PREWALK_EXECUTOR_MODEL` or `gpt-5.6-luna`, with `max` effort
  by default (`PREWALK_EXECUTOR_EFFORT`).
- Use full model IDs such as `gpt-5.6-luna`; do not pass the shorthand
  `luna` to the runner.
- Sandbox: workspace-write.
- Approvals: on-request. The optional `--auto-approve-workspace-writes` flag is for host integrations that cannot safely own `/dev/tty`: it accepts only file changes whose declared grant root and each changed path resolve under `--cwd`, and declines command, permission, and interactive-input requests.
- Maximum checklist items: 8.
- Phase instructions are scoped per turn through the app-server collaboration
  mode: the guide receives the opening-phase instruction, while the executor
  resets to built-in instructions. The thread and working context remain the
  same.
- Completion summary: the runner writes one `[prewalk] summary {JSON}` line to
  stderr with `checklist_ready`, `file_change_seen`, `handoff_triggered`,
  `interrupt_confirmed`, `executor_started`, `executor_model`, `guide_status`,
  `executor_status`, and `final_status`.

If either model is unavailable, rerun with explicit `--guide-model` and
`--executor-model` values. If the user did not explicitly request prewalk,
do not launch it implicitly.

The runner resolves the Codex executable before launch, serializes prewalk
startup per user, retries transient app-server initialization failures, and
preserves child stderr in the final error. A failure should therefore be
treated as a real startup error only after the retry budget is exhausted.

## After the runner exits

Report:

1. Whether the guide produced the checklist.
2. Whether a completed file change triggered the handoff.
3. Which executor model ran.
4. The final turn status.

The structured summary is the machine-readable source for these values.

If the runner reports an error, stop and report it. Do not modify the working
tree from the parent session to compensate.
