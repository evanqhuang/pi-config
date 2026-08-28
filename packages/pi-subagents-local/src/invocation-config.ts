import { Type } from "@sinclair/typebox";
import { getAgentSafetyPolicy, getUnavailableAgentSafetyPolicyError } from "./agent-safety-policy.js";
import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";
import type { WorktreeFinalization } from "./worktree.js";

/**
 * The model-facing `isolation` parameter, shared by the `Agent` tool and the
 * nested delegation tool so the two cannot drift.
 *
 * Shape matters more than wording here. As a single-value optional literal,
 * models that fill every optional parameter — the transcript on #231 shows one
 * emitting `resume: ""`, `schedule: ""` and `model: "default"` alongside it —
 * had only `"worktree"` available to fill it with, and kept spawning worktrees
 * across three turns while their own reasoning said to omit the field. Every
 * other optional parameter has an inert filler; this one did not. `"off"` is
 * listed first and described as the default so the harmless value is the
 * obvious one to reach for.
 *
 * The wording tracks Claude Code's own `isolation` parameter, whose phrasing
 * models have the most exposure to: one description on the union rather than
 * per-value ones, opening "Isolation mode.", then a sentence per value in
 * schema order, each with its caveats in a trailing parenthetical. Two clauses
 * are ours, because our shape is not theirs — `"off"` has no counterpart there
 * (their enum is `worktree | remote`, so both of their values do something),
 * and neither does the uncommitted-work warning, which is the specific trap
 * #231 fell into. Deliberately absent is any "only use a worktree when…"
 * restriction: Claude Code's `Agent` tool states the capability and stops, and
 * a second legal value is what lets a model decline one, not being told to.
 */
const invocationStrategyParamShape = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        'Isolation mode. Default "off". "off" runs the agent in the current checkout, the same as omitting the field. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo (a copy cannot see uncommitted or staged changes in the main checkout).',
    }),
  ),
  worktree_disposition: Type.Optional(
    Type.Union([Type.Literal("commit"), Type.Literal("discard")], {
      description:
        'How an isolated worktree is finalized. "commit" preserves changes on a branch; "discard" removes the worktree without creating a branch.',
    }),
  ),
  snapshot_source: Type.Optional(
    Type.Boolean({
      description:
        "Whether an isolated worktree receives the source checkout's tracked and untracked changes.",
    }),
  ),
};

/**
 * Build the worktree invocation parameters for a tool schema, or nothing when
 * the project disabled worktrees (`worktreeIsolation: false`).
 *
 * Dropping the field beats accepting it and quietly downgrading. The setting is
 * for a project whose model passes `"worktree"` on *every* call, so a
 * per-result "isolation was disabled" note would be noise on every result and
 * would keep raising the salience of a capability that isn't there. With no
 * field there is nothing to pass, nothing to drop, and nothing to explain — the
 * same trade `scheduleParam` makes for disabled scheduling, at zero LLM-context
 * cost. The resolver gate and the `agent-manager` check still cover the paths a
 * schema can't reach: agent files, the scheduler, and cross-extension RPC.
 *
 * Like `scheduleParam`, this is read once at tool registration — flipping the
 * setting needs a new pi session for the schema to change.
 */
export function isolationParam(enabled: boolean): Partial<typeof invocationStrategyParamShape> {
  return enabled ? invocationStrategyParamShape : {};
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  /**
   * Untyped on purpose. Both tool schemas now build this field conditionally
   * and spread it, which erases TypeBox's literal inference to `unknown` (the
   * `schedule` param has the same shape). The resolver below narrows by
   * comparison rather than trusting the declaration, which also makes it safe
   * for the cross-extension RPC path, where options arrive unvalidated.
   */
  isolation?: unknown;
  worktree_disposition?: unknown;
  snapshot_source?: unknown;
}

function parseWorktreeDisposition(value: unknown): WorktreeFinalization | undefined {
  return value === "commit" || value === "discard" ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function mergeDisallowedTools(
  cardTools: readonly string[] | undefined,
  policyTools: readonly string[] | undefined,
): string[] | undefined {
  if (!cardTools?.length && !policyTools?.length) return undefined;
  return [...new Set([...(cardTools ?? []), ...(policyTools ?? [])])];
}

interface ResolveOptions {
  /**
   * Whether worktree isolation is permitted at all. False when the project set
   * `worktreeIsolation: false`, which drops a requested worktree rather than
   * failing the call: the fail-loud precedent covers spawns that *cannot* work,
   * while this one is the user opting out, and throwing would break exactly the
   * calls the `"off"` value exists to tolerate. Defaults to allowed. A
   * policy-required worktree is never downgraded: the resolver returns its
   * required isolation plus `policyError` when this is false.
   */
  worktreeAllowed?: boolean;
  /**
   * What an unqualified spawn means — neither the call nor the agent file said.
   *
   * Top-level callers pass the `backgroundByDefault` setting (default `true`,
   * following Claude Code). Nested callers pass `false` unconditionally: a
   * detached child is killed by `abortOwnedChildren` when its parent settles
   * and has no notification path of its own, so backgrounding one loses its
   * work. Both call sites pass it explicitly; the `false` fallback only covers
   * a caller that supplies no options at all, which in-tree means tests.
   */
  defaultRunInBackground?: boolean;
  /** Canonical registry type used for immutable safety-policy lookup. */
  agentType?: string;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  opts?: ResolveOptions,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
  worktreeDisposition: WorktreeFinalization;
  snapshotSource: boolean;
  disallowedTools?: string[];
  /** Set when a verifier policy cannot be honored by the project settings. */
  policyError?: string;
} {
  // Precedence first, collapse second — an agent file's "off" still outranks a
  // caller's "worktree" while it is still a value. Model and thinking are the
  // deliberate exception: explicit tool-call values win over card defaults.
  const requested = agentConfig?.isolation ?? params.isolation;
  const isolation = requested === "worktree" && opts?.worktreeAllowed !== false ? "worktree" : undefined;

  const requestedDisposition = agentConfig?.worktreeDisposition ?? parseWorktreeDisposition(params.worktree_disposition);
  const worktreeDisposition: WorktreeFinalization = requestedDisposition ?? "commit";
  const requestedSnapshot = agentConfig?.snapshotSource ?? parseBoolean(params.snapshot_source);
  const snapshotSource = requestedSnapshot ?? worktreeDisposition === "discard";

  // Prefer the resolved card identity so a caller cannot relabel a known
  // verifier through the optional context; agentType is only a fallback for a
  // config-less canonical invocation.
  const canonicalAgentType = agentConfig?.name ?? opts?.agentType;
  const safetyPolicy = getAgentSafetyPolicy(canonicalAgentType);
  const policyError = getUnavailableAgentSafetyPolicyError(
    canonicalAgentType,
    safetyPolicy,
    opts?.worktreeAllowed,
  );

  // Safety policy is applied after ordinary card/callsite resolution. A policy
  // can require a worktree even when the project disabled ordinary worktrees;
  // retain that required value and return policyError instead of downgrading it.
  const effectiveIsolation = safetyPolicy?.isolation ?? isolation;
  const effectiveDisposition = safetyPolicy?.worktreeDisposition ?? worktreeDisposition;
  const effectiveSnapshotSource = safetyPolicy?.snapshotSource ?? snapshotSource;
  const disallowedTools = mergeDisallowedTools(
    agentConfig?.disallowedTools,
    safetyPolicy?.disallowedTools,
  );

  return {
    modelInput: params.model ?? agentConfig?.model,
    modelFromParams: params.model != null,
    thinking: (params.thinking ?? agentConfig?.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? opts?.defaultRunInBackground ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation: effectiveIsolation,
    worktreeDisposition: effectiveDisposition,
    snapshotSource: effectiveSnapshotSource,
    disallowedTools,
    policyError,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
