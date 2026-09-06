import { describe, expect, it } from "vitest";
import {
  buildVerifierPrompt,
  buildVerifierRetryPrompt,
  diagnoseVerifierOutput,
  parseVerifierVerdict,
  type GoalVerifierOutputDiagnostic,
} from "../src/verifier.js";

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
    expect(prompt).toContain("at most 4000 characters");
    expect(prompt).toContain("at most 32 non-empty trimmed single-line strings");
    expect(prompt).toContain("at most 2000 characters");
    expect(prompt).toContain("at most 256 characters");
    expect(prompt).toContain("at most 131072 characters");
    expect(prompt).toContain("permitted iff outcome is replan");
    expect(prompt).toContain("never emit null");
  });

  it("rejects corrections for pass while retaining valid replan corrections", () => {
    const base = {
      reason: "verification needs another cycle",
      repositoryFingerprint: "repo",
      evidenceFingerprint: "evidence",
      correction: "Inspect the failing check.\nRun the focused test.\n",
    };
    expect(parseVerifierVerdict(JSON.stringify({ ...base, outcome: "pass" }))).toBeUndefined();
    expect(parseVerifierVerdict(JSON.stringify({ ...base, outcome: "replan" }))).toMatchObject({
      outcome: "replan",
      correction: base.correction,
    });
    expect(parseVerifierVerdict(JSON.stringify({
      ...base,
      outcome: "replan",
      correction: undefined,
    }))).toMatchObject({ outcome: "replan" });
  });

  it("enforces the parser's single-line and exact size bounds", () => {
    const valid = (overrides: Record<string, unknown> = {}) => JSON.stringify({
      outcome: "pass",
      reason: "verified",
      repositoryFingerprint: "repo",
      evidenceFingerprint: "evidence",
      ...overrides,
    });

    expect(parseVerifierVerdict(valid({ reason: `x\ny` }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ reason: "r".repeat(4001) }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ reason: "r".repeat(4000) }))).toMatchObject({ reason: "r".repeat(4000) });

    expect(parseVerifierVerdict(valid({ evidence: ["x\ny"] }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ evidence: ["e".repeat(2001)] }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ evidence: Array.from({ length: 33 }, () => "e") }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ evidence: ["e".repeat(2000)] }))).toMatchObject({ evidence: ["e".repeat(2000)] });

    expect(parseVerifierVerdict(valid({ repositoryFingerprint: "f".repeat(257) }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ evidenceFingerprint: "f\ng" }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ repositoryFingerprint: "f".repeat(256), evidenceFingerprint: "e".repeat(256) }))).toMatchObject({
      repositoryFingerprint: "f".repeat(256),
      evidenceFingerprint: "e".repeat(256),
    });

    expect(parseVerifierVerdict(valid({ outcome: "replan", correction: "c".repeat(131073) }))).toBeUndefined();
    expect(parseVerifierVerdict(valid({ outcome: "replan", correction: "contains\u0000nul" }))).toBeUndefined();
  });

  it("reports bounded structural errors and keeps retry feedback private", () => {
    const sentinel = "DO_NOT_LEAK_VERIFIER_SENTINEL";
    const diagnostic = diagnoseVerifierOutput(JSON.stringify({
      outcome: "pass",
      reason: "line\nbreak",
      evidence: ["evidence\nline"],
      repositoryFingerprint: "f".repeat(257),
      evidenceFingerprint: "evidence\nfingerprint",
      correction: "a permitted-looking correction",
      strategy: sentinel,
      prewalk: { required: false },
      snapshot: { unknown: sentinel },
      [sentinel]: "raw content",
    }));

    expect(diagnostic.validationErrors).toEqual(expect.arrayContaining([
      "invalid-reason",
      "invalid-evidence",
      "invalid-fingerprint",
      "correction-not-allowed",
      "invalid-strategy",
      "invalid-prewalk",
      "invalid-snapshot",
      "unknown-fields",
    ]));
    expect(diagnostic.summary.length).toBeLessThanOrEqual(500);
    expect(diagnostic.summary.indexOf("validationErrors=")).toBeLessThan(diagnostic.summary.indexOf("keys="));
    expect(diagnostic.summary).toContain("invalid-reason");
    expect(diagnostic.summary).not.toContain(sentinel);

    const forged = {
      category: sentinel,
      charLength: 10,
      byteLength: 10,
      sha256: sentinel,
      fingerprint: sentinel,
      bracesFound: true,
      jsonObjectFound: true,
      topLevelKeys: [sentinel, "reason"],
      validationErrors: [sentinel, "invalid-evidence"],
      summary: sentinel,
    } as unknown as GoalVerifierOutputDiagnostic;
    const basePrompt = "base V2 prompt";
    const retry = buildVerifierRetryPrompt(basePrompt, forged, "controller-fingerprint");
    expect(retry).not.toContain(sentinel);
    expect(retry).toContain("validationErrors=invalid-evidence");
    expect(retry).toContain("at most 4000 characters");
    expect(retry).toContain("permitted iff outcome is replan");
    expect(retry).toContain("Echo the exact controller evidence fingerprint already present in the base prompt: controller-fingerprint.");
    expect(retry.length).toBeLessThan(basePrompt.length + 5_000);
  });
});
