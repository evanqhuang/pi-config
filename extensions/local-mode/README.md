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
- requires the main local agent to create and update parent-session todos for multi-step work; Explore remains read-only and cannot update those todos;
- adds concise local working-style, parent-session todo, and non-blocking delegation instructions to each turn;
- remaps built-in `Explore` calls to the read-only `LocalExplore` profile on `qwopus-subagent/qwopus3.5-9b-coder-mtp` and blocks other child launches while the 27B child-agent lane is disabled;
- limits `/local model` and Option-Tab model cycling to `qwen38-main/qwen3.8-27b` and `qwopus-subagent/qwopus3.5-9b-coder-mtp`.

When local mode is disabled, the configured model scope keeps local models out of the default `/model` view and Option-Tab cycle. The picker can still expose Pi's explicit “all models” view, and local providers remain registered so background extensions can use them.

Mode changes are stored as custom session entries. A resumed or reloaded session returns to local mode only when its latest saved local-mode state is enabled; new sessions remain in default mode.

The global `~/.pi/agent/agents/LocalExplore.md` profile is always discoverable, but automatic remapping to it occurs only while local mode is active. Outside local mode, built-in `Explore` retains its normal configured model.

## Adaptive Qwen budgets

The 240K main provider uses these xhigh ceilings before applying a remaining-context clamp:

| Existing context | Thinking budget | Total generation |
|---:|---:|---:|
| Below 100K | 64K | 96K |
| 100K–140K | 48K | 64K |
| 140K–175K | 32K | 48K |
| 175K or more | Request compaction | Recompute afterward |

The 96K 27B subagent has a separate schedule: 32K/48K below 32K context, 24K/32K from 32K, 16K/24K from 56K, and compaction pressure at 72K. Every request reserves 8K context safety headroom and at least 4K of the generation allowance for a final answer. At extreme pressure, the request builder retains a 1K emergency answer allowance while compaction is pending.

The extension sends Qwen's thinking-mode sampling defaults (`temperature=1.0`, `top_p=0.95`, `top_k=20`, `min_p=0`, zero presence penalty, and repetition penalty 1.0). It also sends `enable_thinking`, `preserve_thinking`, the routed `reasoning_effort`, and the dynamically computed `thinking_token_budget` and `max_tokens` on every local Qwen request.

There is no fixed tool-turn cutoff. Compaction and checkpoints are driven by context pressure, repeated lack of progress, or real phase transitions instead of an arbitrary number of tool calls. Automatic compaction waits until the agent is settled—never between tool iterations—then queues a continuation from the compacted task summary.

Local mode enforces a process-wide local-provider and 27B profile policy. While it is active, main-session model changes and child subagent sessions are forced onto the registered `qwen38-main`, `qwen38-subagent`, or `qwopus-subagent` providers before a turn starts. A final provider-request guard aborts any non-local request rather than allowing it to leave the process. Child sessions launched with an explicit local subagent provider preserve that selection without inheriting the parent's local-mode UI state.
