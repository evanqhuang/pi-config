# Local mode

Local mode is off by default. The normal model scope contains only the configured OpenAI models, while local providers remain available to background extensions such as observational memory.

## Commands

- `/local` — enable local mode in automatic medium reasoning; use this as the normal entrypoint.
- `/local on` — alias for `/local`.
- `/local off` — disable it and restore the previous model and theme.
- `/local auto` — alias for `/local`; restores automatic medium reasoning after a manual thinking-level selection.
- `/local subagent-27b off` — disable the 27B child-agent lane; the main 27B and read-only 9B Explore lane remain available.
- `/local subagent-27b on` — re-enable the 27B child-agent lane.
- Resuming or reloading a session restores the local-mode state saved in that session.
- `/local model` — enable local mode if needed, then open a picker containing only the local 27B and 9B models.

When enabled, the extension:

- selects `qwen38-main/qwen3.8-27b` with the default medium profile;
- exposes only low, medium, and xhigh in Pi's thinking-level cycle for both 27B providers;
- keeps low (4K thinking/12K output) and medium (8K/20K) bounded, while dynamically scaling xhigh to the available context;
- starts every automatic task at medium; after inspecting relevant code, the model can request one xhigh response when extra reasoning materially improves correctness; automatic mode returns to medium when the task settles;
- preserves explicit manual thinking-level selections until `/local` or `/local auto` is used;
- switches to the `local-green` theme, including green editor borders;
- shows a green `LOCAL` status and working indicator;
- shows the measured local output generation rate in the statusline after a response (`tok/s`) and keeps the latest rate visible across tool turns;
- retries a local 27B provider turn up to five times when the final provider stop reason is `repetition`, preserving the conversation and discarding partial output from interrupted attempts;
- requires the main local agent to create and update parent-session todos for multi-step work; Explore remains read-only and cannot update those todos;
- adds concise local working-style, parent-session todo, and non-blocking delegation instructions to each turn;
- remaps built-in `Explore` calls to the read-only `LocalExplore` profile on `qwopus-subagent/qwopus3.5-9b-coder-mtp` and blocks other child launches while the 27B child-agent lane is disabled;
- limits `/local model` and Option-Tab model cycling to `qwen38-main/qwen3.8-27b` and `qwopus-subagent/qwopus3.5-9b-coder-mtp`.

When local mode is disabled, the configured model scope keeps local models out of the default `/model` view and Option-Tab cycle. The picker can still expose Pi's explicit “all models” view, and local providers remain registered so background extensions can use them.

Mode changes are stored as custom session entries. A resumed or reloaded session returns to local mode only when its latest saved local-mode state is enabled; new sessions remain in default mode.

The global `~/.pi/agent/agents/LocalExplore.md` profile is always discoverable, but automatic remapping to it occurs only while local mode is active. Outside local mode, built-in `Explore` retains its normal configured model.

## Adaptive Qwen budgets

Local model context windows come from the active model metadata in `~/.pi/agent/models.json`; local mode does not maintain a second provider catalog or hard-code those windows. The 27B subagent remains a separate 96K provider with its own output ceiling, while the read-only 9B provider is unaffected by the Qwen profile logic.

Compaction thresholds come from the active `pi-auto-compact` policy through its `pi-auto-compact:policy-request:v1` / `pi-auto-compact:policy:v1` protocol. That policy resolves configured `auto-compact.json` rules or Pi's native fallback. If no policy responds, local mode does not invent a percentage threshold; it still requests compaction when too little generation headroom remains.

Low and medium keep their fixed target budgets, while xhigh starts from the provider-specific schedule in `session-policy.ts`. Every request then clamps generation to the active model's remaining context, reserves 8K of context safety headroom, and reserves at least 4K of the generation allowance for a final answer. At extreme pressure, the request builder retains a 1K emergency answer allowance while compaction is pending.

The extension sends Qwen's thinking-mode sampling defaults (`temperature=1.0`, `top_p=0.95`, `top_k=20`, `min_p=0`, zero presence penalty, and repetition penalty 1.0). It also sends `enable_thinking`, `preserve_thinking`, the routed `reasoning_effort`, and the dynamically computed `thinking_token_budget` and `max_tokens` on every local Qwen request.

There is no fixed tool-turn cutoff. Compaction and checkpoints are driven by context pressure, repeated lack of progress, or real phase transitions instead of an arbitrary number of tool calls. Automatic compaction waits until the agent is settled—never between tool iterations—then queues a continuation from the compacted task summary.

## Repetition recovery

Local mode wraps the `qwen38-main` and `qwen38-subagent` agent callers. If an attempt ends with provider `rawStopReason: "repetition"`, local mode buffers and discards that attempt, then retries the same conversation up to five times. Retry attempts add a transient instruction to continue from the conversation state and set `skip_reading_prefix_cache: true`; other stop reasons are not retried by this policy. If all retries repeat, only the final sanitized error is exposed—interrupted partial text is not rendered or persisted.

Local mode enforces a process-wide local-provider and 27B profile policy. While it is active, main-session model changes and child subagent sessions are forced onto the registered `qwen38-main`, `qwen38-subagent`, or `qwopus-subagent` providers before a turn starts. A final provider-request guard aborts any non-local request rather than allowing it to leave the process. Child sessions launched with an explicit local subagent provider preserve that selection without inheriting the parent's local-mode UI state.
