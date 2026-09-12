# Pi Tool-Projection Diagnosis and Long-Term Fix

## Symptom

The local Qwen session alternated between model-facing request tool surfaces of
62 and 50 tools. The alternating prefixes caused vLLM prefix-cache misses and,
because the two serialized prompts were large and different, could evict each
other from the available KV-cache capacity.

## Confirmed diagnosis

The target request sequence is correlated to Pi session `01a08f4b` using
timestamps and an exact SHA-256 match of the user message without retaining or
printing prompt text:

| Capture | Tool count | Preceding session event |
| --- | ---: | --- |
| `bdf89b4701bdd184` | 62 | Assistant `read` tool result |
| `8f92c5661c18c1ae` | 50 | Manual user message |
| `9e0e77314096bcba` | 62 | Assistant `ctx_batch_execute` result |
| `a4be628e50da755b` | 62 | Assistant `bash` results |

All captures identify `qwen38-main / qwen3.8-27b / openai-completions`.
The full session scan found 609 assistant responses and no model/provider
transitions around the target sequence. Earlier Qwen/Luna transitions exist in
the session during setup and mode changes, but none occur at the target turn.

The 12 extra tools are the Codex adapter registrations:

```text
change_reasoning, exec_command, write_stdin, apply_patch, exec, wait,
notebook, view_image, new_context, get_context_remaining, history, notes
```

The 62-tool request places those tools at registry positions 49–60. Codex
adapter enablement would prepend its adapter tools, so this ordering identifies
the 62-tool snapshot as Plan mode's YOLO `getAllTools()` refresh, not a hidden
Codex/cloud model request.

## Why the oscillation occurs

The production extension order is:

1. `local-mode`
2. `pi-plan-mode`
3. Ask User
4. `pi-codex-conversion`

Relevant behavior:

- Codex `syncAdapter()` runs on normal `input`. For Qwen, the Codex adapter is
  inactive and strips adapter-owned tools, producing 50 tools.
- Plan mode runs `refreshTools()` at every `turn_start`. In YOLO mode it copies
  the complete registered tool list, producing 62 tools.
- Pi snapshots the request context before `turn_start`.
- Internal tool continuations do not emit a normal `input` event.
- No local-mode hook writes active tools; Ask User only reconciles its own tool.

The effective sequence is therefore:

```text
manual input
  -> Codex syncAdapter()
  -> request context snapshots 50 tools
  -> Plan turn_start refreshes live state to 62 tools

internal continuation
  -> next context snapshots the live 62-tool state
  -> Plan refreshes it to 62 again
```

The current `pi.setActiveTools()` API is imperative and last-writer-wins. It
does not distinguish a mode selection from a model-compatibility constraint.

## Short-term fix applied

The short-term fix is in the loaded development Plan mode extension:

```text
~/.pi/agent/dev/pi-plan-mode/index.ts
~/.pi/agent/dev/pi-plan-mode/test/extension.test.mjs
```

On `turn_start`, YOLO and ORCHESTRATOR now preserve the active model-facing
projection supplied by another extension, removing only names that are no
longer registered. They no longer blindly replace it with `getAllTools()`.
Mode changes still force a complete refresh, and PLAN still reapplies its
explicit allowlist. This removes the observed Qwen transition from 50 back to
62 without coupling Plan mode to Codex-specific tool names.

The tradeoff is deliberate: newly registered tools are not automatically added
to an existing YOLO/ORCHESTRATOR projection during `turn_start`; a mode change
or another extension's reconciliation must activate them. This avoids making
Plan mode reintroduce tools that a model-specific adapter has intentionally
removed.

The earlier Codex-side artifact patch was reverted; the Codex package is back
to its pre-investigation contents. No installed NPM artifact needs to be
replaced for this Plan-mode fix because settings load `dev/pi-plan-mode` from
`index.ts` directly.

Validation performed for this local patch:

- The focused Plan-mode regression test covers preserving a reduced active
  projection during YOLO `turn_start`.
- Full Plan-mode test run passes: 76 tests, 0 failures.
- Plan-mode TypeScript typecheck passes.
- Pi was not restarted. Start a new Pi process/session before expecting the
  changed development extension to load.

## Long-term Pi-core fix

The durable solution belongs in Pi agent core, not in the dashboard and not as
another competing extension callback.

Pi should support layered tool-scope policies and resolve one final ordered
projection before creating a request context:

```text
registered tools
  -> mode scope (YOLO all tools or PLAN allowlist)
  -> model/provider compatibility projection
  -> dynamic-tool and permission constraints
  -> dedupe + deterministic ordering
  -> request context snapshot
```

Possible core API shape:

```ts
registerToolScopeProvider({
  name: "plan-mode",
  resolve: ({ allTools, mode }) => mode === "PLAN" ? planAllowlist : allTools,
});

registerToolConstraint({
  name: "codex-adapter",
  filter: ({ tools, model }) => projectForModel(tools, model),
});
```

The existing `setActiveTools()` API should either become a scoped compatibility
operation or be deprecated for per-turn policy changes. The core resolver must
run before the context snapshot; a `turn_start` callback alone is too late for
the current request and only affects the following turn.

## Future implementation checklist

- Add core-owned layered tool-scope registration and deterministic precedence.
- Define whether mode scopes and model constraints compose by intersection,
  ordered projection, or an explicit policy result.
- Preserve PLAN allowlists while filtering tools unavailable to the model.
- Reconcile dynamic extension registration through a registry revision rather
  than blindly resetting the full list every turn.
- Emit metadata-only diagnostics: session ID, turn index, model/provider, mode,
  scope revision, ordered tool fingerprint, registry fingerprint, and request ID.
- Add tests covering manual input, tool continuations, YOLO, PLAN, extras,
  model switching, and dynamic tool registration.
- Upstream the short-term behavior before the next NPM package refresh.

## Evidence limitations

Historical capture files contain request bodies and capture times but not Pi
session IDs, extension scope, `setActiveTools()` callers, or gateway headers.
The diagnosis is therefore established by exact event/capture correlation,
source ordering, and tool-order fingerprints; a live reproduction remains the
final acceptance check for the patch.
