import { describe, expect, it } from "vitest";
import { buildVerifierPrompt, parseVerifierVerdict } from "../src/verifier.js";

describe("fixed-point GoalVerifier protocol", () => {
  it("parses every structured outcome without treating non-pass as success", () => {
    expect(parseVerifierVerdict(JSON.stringify({
      outcome: "replan",
      reason: "A required check is missing.",
      evidence: ["focused check is absent"],
      repositoryFingerprint: "repo-1",
      evidenceFingerprint: "evidence-1",
      correction: "Add the missing check and run it.\n",
    }))).toMatchObject({
      outcome: "replan",
      reason: "A required check is missing.",
      correction: "Add the missing check and run it.\n",
      repositoryFingerprint: "repo-1",
      evidenceFingerprint: "evidence-1",
    });
    for (const outcome of ["pass", "blocked", "inconclusive"] as const) {
      expect(parseVerifierVerdict(JSON.stringify({
        outcome,
        reason: `result: ${outcome}`,
        repositoryFingerprint: "repo-2",
        evidenceFingerprint: "evidence-2",
      }))).toMatchObject({ outcome });
    }
    expect(parseVerifierVerdict('{"outcome":"unknown","reason":"bad"}')).toBeUndefined();
  });

  it("puts immutable original/correction snapshots and epoch identity in the V2 prompt", () => {
    const prompt = buildVerifierPrompt({
      objective: "ship the feature",
      criteria: ["focused tests pass"],
      judgeReason: "candidate appears complete",
      loopId: "loop-1",
      generation: 2,
      contextEpoch: 3,
      cycle: 2,
      strategy: "ORCHESTRATOR",
      originalPlan: { path: "/agent/goal-loops/loop-1/original-plan.md", hash: "a".repeat(64), content: "original plan" },
      correction: { path: "/agent/goal-loops/loop-1/cycle-2-plan.md", hash: "b".repeat(64), content: "corrective plan" },
      evidenceFingerprint: "evidence-3",
    });
    expect(prompt).toContain("loop-1 / generation 2 / context epoch 3 / correction cycle 2");
    expect(prompt).toContain("/agent/goal-loops/loop-1/original-plan.md");
    expect(prompt).toContain("original plan");
    expect(prompt).toContain("/agent/goal-loops/loop-1/cycle-2-plan.md");
    expect(prompt).toContain("corrective plan");
    expect(prompt).toContain("evidence-3");
    expect(prompt).toContain('"outcome":"pass"|"replan"|"blocked"|"inconclusive"');
  });
});
