# pi-eval-metrics

`pi-eval-metrics` is an observational Pi extension and unattended benchmark
harness for long-horizon agentic tasks. Loading the package enables recording;
omitting or disabling the package disables recording. The extension does not
add an LLM-callable tool, inject instructions, add context messages, or write
Pi session entries.

## Run the full unattended benchmark

From this directory, one command sets up dependencies, creates clean detached
worktrees from repository-specific baseline commits, and runs all twelve
scenarios sequentially:

```sh
npm run benchmark -- --repo /private/tmp/records-dd-eval
```

Scenarios 1–8 run against the Records repository supplied by `--repo`.
Scenarios 9–12 run against `~/hostelhawk` by default; override that with
`--hostelhawk-repo`. Each scenario runs `notes-absent` first (pi-notes is
omitted entirely), then `notes-present` (pi-notes is loaded). The default model is
`qwen38-main/qwen3.8-27b` at medium thinking and each arm has a three-hour
timeout. Override `--model`, `--provider`, `--thinking`, or `--timeout` when
needed. Use `--dry-run` to validate the 24-run plan without starting agents,
`--scenario <id>` to select a subset, `--resume <harness-id>` after an
interruption, and `--cleanup-worktrees` to remove result worktrees.

The runner preserves source changes by never resetting the target checkout.
It uses clean Git worktrees, symlinks an existing `node_modules` and ignored
environment files when present, and stores the resumable harness manifest,
per-arm session directories, raw JSON activity streams, stderr logs, reports,
and summary under `~/.pi/evals/harness`.
The final `summary.md` links each scenario's filtered report and raw Pi
`sessionFile` paths for deeper investigation.

The scenario prompts live in
[`benchmarks/scenarios`](benchmarks/scenarios/README.md). They cover case
files, county refresh, recorded documents, owner requests, agent tasks,
screening, provenance/drift, deterministic investigation exports, multi-phase
investigation, late requirements, failure recovery, and independent review.

While an arm runs, the harness prints every turn, tool start/result, context
compaction, and a 30-second heartbeat with elapsed time and cumulative counters.
The heartbeat includes repeated tool calls and post-compaction rediscovery.
Full JSON events—including assistant messages, reasoning, tool arguments, and
tool results—are retained in the arm's `activity.jsonl`; stderr is retained in
`stderr.log`. The final summary records first-tool/mutation/verification
latencies and other live counters alongside the evaluator report.

## Automatic metadata

The recorder waits for the first top-level task prompt, hashes its normalized
text, and stores only the hash and length. It derives the Pi session ID, model,
provider, thinking level, Git revisions, compaction fingerprint, Notes arm, and
replicate ordinal automatically. No environment variables or manually supplied
run labels are required.

The arm is inferred from the tool surface:

- `notes-present`: `checkpoint_notes` is registered (load `dev/pi-notes`).
- `notes-absent`: `checkpoint_notes` is not registered (omit `dev/pi-notes`).

Do not use `/notes off` as the control: that leaves the Notes tool in the model
surface and is not a Notes-absent run.

The evaluator extension's derived events remain sanitized JSONL under
`~/.pi/evals`. After each successful compaction, it stores a small bounded and
redacted assistant thinking/response window for convenient reports. The
unattended harness additionally retains Pi's complete JSON-mode stdout and
stderr per arm because these runs execute on trusted local infrastructure.
Those raw artifacts may contain prompts, reasoning, tool arguments/results,
paths, logs, and credentials returned by tools; keep `~/.pi/evals` private.
Queue drops and write failures are reported in the run manifest so compromised
runs can be excluded. The authoritative Pi session also remains at the
manifest's `sessionFile` path.

## Benchmark protocol

1. Start from the same clean Git commit and a fresh top-level Pi session for
   each arm.
2. Load `dev/pi-eval-metrics` in both sessions.
3. Load `dev/pi-notes` only for the Notes-present arm.
4. Paste the exact prompt in
   [`benchmarks/saved-due-diligence-case-file.md`](benchmarks/saved-due-diligence-case-file.md).
5. Repeat with fresh sessions. At least three replicates per arm are
   recommended; one Notes-present/one Notes-absent pair is useful as a smoke
   evaluation.

The extension is independent of the Pi profile directory, so both arms write
to the shared `~/.pi/evals` root.

## Report

From this package directory, run:

```sh
npm run report
```

The command takes no metadata arguments. It selects the most recent experiment
with both arms, validates comparability, excludes incomplete/dirty/dropped or
mismatched runs with explicit reasons, and writes JSON, CSV, and Markdown
artifacts under `~/.pi/evals/reports/`. Completion is reported as an
observational goal signal; verification/test/build outcomes remain separate.
Matching replicate IDs are preferred. If one arm contains short accidental
attempts that consumed replicate numbers, substantive runs (at least 10
provider requests or tool calls) are paired by start order and labeled as
`substantive-fallback` in the report. Per-scenario reports also include a
`Post-compaction transcript excerpts` section, and the harness writes a
cross-scenario `summary.md` and `summary.json` after all scheduled runs.

## Non-interference

Lifecycle handlers enqueue asynchronous writes and return immediately. The
queue is bounded and failures are contained. Shutdown is the only lifecycle
point that awaits the queue. Child sessions marked by `pi-subagents-local` are
not instrumented.
