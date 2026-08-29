/**
 * Immutable verifier safety constraints.
 *
 * This is deliberately separate from card loading and invocation precedence:
 * cards and callers describe defaults, while these constraints are applied
 * after those defaults have been resolved. The key is the canonical registry
 * type, not a case-folded or filename-derived spelling.
 */

import type { IsolationMode } from "./types.js";
import type { WorktreeFinalization } from "./worktree.js";

export interface AgentSafetyPolicy {
  readonly disallowedTools?: readonly string[];
  readonly isolation?: IsolationMode;
  readonly worktreeDisposition?: WorktreeFinalization;
  readonly snapshotSource?: boolean;
}

const LUNA_COMPLIANCE_POLICY: AgentSafetyPolicy = Object.freeze({
  disallowedTools: Object.freeze(["bash"]),
});

const LUNA_TEST_VERIFIER_POLICY: AgentSafetyPolicy = Object.freeze({
  isolation: "worktree",
  worktreeDisposition: "discard",
  snapshotSource: true,
});

const GOAL_VERIFIER_POLICY: AgentSafetyPolicy = Object.freeze({
  isolation: "worktree",
  worktreeDisposition: "discard",
  snapshotSource: true,
});

/** The only policy entries. Keep this table private so callers cannot mutate it. */
const AGENT_SAFETY_POLICIES: Readonly<Record<string, AgentSafetyPolicy>> = Object.freeze({
  LunaCompliance: LUNA_COMPLIANCE_POLICY,
  LunaTestVerifier: LUNA_TEST_VERIFIER_POLICY,
  GoalVerifier: GOAL_VERIFIER_POLICY,
});

/**
 * Return the immutable policy for a canonical agent type.
 *
 * No case folding is done here. Agent type resolution must happen first so a
 * policy cannot accidentally attach to a similarly named user-defined type.
 */
export function getAgentSafetyPolicy(canonicalAgentType: string | undefined): AgentSafetyPolicy | undefined {
  return canonicalAgentType !== undefined && Object.hasOwn(AGENT_SAFETY_POLICIES, canonicalAgentType)
    ? AGENT_SAFETY_POLICIES[canonicalAgentType]
    : undefined;
}

/**
 * Explain why a policy-required worktree cannot be honored.
 *
 * The ordinary worktree setting is allowed to downgrade a caller request. A
 * verifier policy is different: it must fail before spawning rather than run
 * in the shared checkout.
 */
export function getUnavailableAgentSafetyPolicyError(
  canonicalAgentType: string | undefined,
  policy: AgentSafetyPolicy | undefined,
  worktreeAllowed: boolean | undefined,
): string | undefined {
  if (worktreeAllowed !== false || policy?.isolation !== "worktree") return undefined;
  return `Agent "${canonicalAgentType}" requires worktree isolation, but worktree isolation is disabled. `
    + "Enable worktree isolation to run this verifier; it will not downgrade to a shared checkout.";
}
