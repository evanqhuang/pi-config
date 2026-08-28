import { describe, expect, it } from "vitest";
import {
  buildGoalEvidence,
  goalBudgetExhausted,
  GOAL_STATE_TYPE,
  latestGoalState,
  MAX_GOAL_ITERATIONS,
  parseGoalState,
  parseGoalVerdict,
} from "../src/core.js";

describe("goal core", () => {
  it("accepts strict JSON verdicts and rejects malformed output", () => {
    expect(parseGoalVerdict('{"ok":false,"reason":"more work"}')).toEqual({
      ok: false,
      reason: "more work",
      impossible: false,
    });
    expect(parseGoalVerdict("not json")).toBeUndefined();
    expect(parseGoalVerdict('{"ok":true,"reason":""}')).toBeUndefined();
  });

  it("restores only the latest valid state on the active branch", () => {
    const older = {
      id: "old",
      generation: 1,
      condition: "old",
      status: "active",
      iterations: 0,
      startedAt: 1,
      updatedAt: 1,
    };
    const latest = { ...older, id: "new", generation: 2, status: "paused" };
    const entries = [
      { type: "custom", customType: GOAL_STATE_TYPE, data: older },
      { type: "custom", customType: GOAL_STATE_TYPE, data: latest },
    ] as any[];

    expect(latestGoalState(entries)).toEqual(latest);
    expect(parseGoalState({ ...latest, generation: 0 })).toBeUndefined();
  });

  it("enforces iteration and elapsed-time budgets", () => {
    const state = {
      id: "goal",
      generation: 1,
      condition: "finish",
      status: "active" as const,
      iterations: MAX_GOAL_ITERATIONS,
      startedAt: 1,
      updatedAt: 1,
    };
    expect(goalBudgetExhausted(state, 2)).toBe(true);
  });

  it("bounds transcript evidence and excludes plain extension state", () => {
    const evidence = buildGoalEvidence([
      { type: "custom", customType: "private", data: { secret: true } },
      { type: "message", message: { role: "assistant", content: "done" } },
    ] as any[]);
    expect(evidence).toContain("done");
    expect(evidence).not.toContain("secret");
    expect(evidence.length).toBeLessThanOrEqual(80_000);
  });
});
