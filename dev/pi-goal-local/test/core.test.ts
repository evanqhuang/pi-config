import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "../src/commands.js";
import { agentRunWasAborted } from "../src/index.js";
import { parseGoalVerdict } from "../src/judge.js";
import { CLEARED_REASON, latestGoalState, parseGoalState } from "../src/state.js";
import { fingerprintEvidence } from "../src/transcript.js";
import { parseVerifierVerdict } from "../src/verifier.js";
import { GOAL_STATE_TYPE, type GoalStateV1 } from "../src/types.js";

function goal(overrides: Partial<GoalStateV1> = {}): GoalStateV1 {
  return {
    schemaVersion: 1,
    id: "g1",
    generation: 1,
    status: "active",
    objective: "ship feature",
    criteria: ["tests pass"],
    createdAt: 1,
    updatedAt: 1,
    iteration: 0,
    consecutiveJudgeFailures: 0,
    verificationFailures: 0,
    noProgressCycles: 0,
    ...overrides,
  };
}

describe("goal command parser", () => {
  it("parses management commands and criteria", () => {
    expect(parseGoalCommand("status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("build it -- tests pass; docs updated")).toEqual({
      kind: "start",
      objective: "build it",
      criteria: ["tests pass", "docs updated"],
    });
  });
});

describe("goal state", () => {
  it("rejects legacy/malformed state and restores latest native branch state", () => {
    expect(parseGoalState({ schemaVersion: 0 })).toBeUndefined();
    const entries = [
      { type: "custom", customType: "goal-state", data: { status: "active" } },
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal({ status: "paused" }) },
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal({ status: "active", generation: 2 }) },
    ] as any;
    expect(latestGoalState(entries)?.generation).toBe(2);
    expect(latestGoalState(entries)?.status).toBe("active");
  });

  it("treats the newest native clear marker as no effective branch goal", () => {
    const entries = [
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal() },
      {
        type: "custom",
        customType: GOAL_STATE_TYPE,
        data: goal({ status: "stopped", terminalReason: CLEARED_REASON, lastReason: CLEARED_REASON }),
      },
    ] as any;
    expect(latestGoalState(entries)).toBeUndefined();
  });
});

describe("agent settlement", () => {
  it("detects an aborted assistant run so the controller can pause instead of continuing", () => {
    expect(agentRunWasAborted([{ role: "assistant", stopReason: "aborted" }])).toBe(true);
    expect(agentRunWasAborted([{ role: "assistant", stopReason: "stop" }])).toBe(false);
  });
});

describe("evaluator parsing", () => {
  it("parses bounded judge/verifier JSON and fails closed", () => {
    expect(parseGoalVerdict('{"ok":false,"reason":"more work","nextAction":"test"}')).toMatchObject({ ok: false, reason: "more work" });
    expect(parseGoalVerdict("not json")).toBeUndefined();
    expect(parseVerifierVerdict('{"ok":true,"reason":"verified","evidence":["test passed"]}')).toEqual({
      ok: true,
      reason: "verified",
      evidence: ["test passed"],
    });
  });

  it("fingerprints evidence deterministically", () => {
    expect(fingerprintEvidence("a")).toBe(fingerprintEvidence("a"));
    expect(fingerprintEvidence("a")).not.toBe(fingerprintEvidence("b"));
  });
});
