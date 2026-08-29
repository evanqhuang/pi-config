import { describe, expect, it } from "vitest";
import { getAgentSafetyPolicy } from "../src/agent-safety-policy.js";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

const goalVerifierCard: AgentConfig = {
  name: "GoalVerifier",
  description: "goal verifier test card",
  extensions: true,
  skills: false,
  systemPrompt: "",
  promptMode: "replace",
  isolation: "off",
  worktreeDisposition: "commit",
  snapshotSource: false,
};

describe("GoalVerifier safety policy", () => {
  it("forces disposable snapshot isolation after card/callsite overrides", () => {
    const policy = getAgentSafetyPolicy("GoalVerifier");
    expect(policy).toEqual({
      isolation: "worktree",
      worktreeDisposition: "discard",
      snapshotSource: true,
    });
    expect(Object.isFrozen(policy)).toBe(true);

    const resolved = resolveAgentInvocationConfig(
      goalVerifierCard,
      { isolation: "off", worktree_disposition: "commit", snapshot_source: false },
      { agentType: "GoalVerifier" },
    );

    expect(resolved.isolation).toBe("worktree");
    expect(resolved.worktreeDisposition).toBe("discard");
    expect(resolved.snapshotSource).toBe(true);
    expect(resolved.policyError).toBeUndefined();
  });

  it("fails closed when required worktree isolation is disabled", () => {
    const resolved = resolveAgentInvocationConfig(
      goalVerifierCard,
      {},
      { agentType: "GoalVerifier", worktreeAllowed: false },
    );
    expect(resolved.policyError).toContain("GoalVerifier");
    expect(resolved.policyError).toContain("will not downgrade");
  });
});
