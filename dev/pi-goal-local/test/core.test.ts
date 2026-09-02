import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "../src/commands.js";
import { agentRunWasAborted } from "../src/index.js";
import { parseGoalVerdict } from "../src/judge.js";
import {
  CLEARED_REASON,
  latestGoalLoopState,
  latestGoalState,
  latestGoalStateMarker,
  parseGoalState,
  parseGoalStateV2,
} from "../src/state.js";
import { fingerprintEvidence } from "../src/transcript.js";
import {
  buildVerifierRetryPrompt,
  diagnoseVerifierOutput,
  parseVerifierVerdict,
} from "../src/verifier.js";
import {
  DEFAULT_GOAL_LOOP_SETTINGS,
  GOAL_LOOP_SETTING_BOUNDS,
} from "../src/settings.js";
import {
  GOAL_CONTINUE_MESSAGE,
  GOAL_STATE_TYPE,
  GOAL_STATE_V2_TYPE,
  type GoalStateV1,
  type GoalStateV2,
} from "../src/types.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

function progressEvidence(timestamp: number, toolCallId: string, output = "PASS"): string {
  return [
    JSON.stringify({
      type: "message",
      message: {
        role: "custom",
        customType: GOAL_CONTINUE_MESSAGE,
        content: "Continue working on the goal.",
        display: false,
        timestamp,
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `private-${timestamp}` },
          { type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "npm test" } },
        ],
        api: "responses",
        provider: "test-provider",
        model: "test-model",
        usage: { output: timestamp },
        stopReason: "toolUse",
        timestamp,
      },
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: output }],
        isError: false,
        timestamp,
      },
    }),
  ].join("\n");
}

describe("goal command parser", () => {
  it("parses management commands, criteria, and the legacy start objective", () => {
    expect(parseGoalCommand("status")).toEqual({ kind: "status" });
    expect(parseGoalCommand("pause")).toEqual({ kind: "pause" });
    expect(parseGoalCommand("fresh")).toEqual({ kind: "fresh" });
    expect(parseGoalCommand("start")).toEqual({ kind: "start", objective: "start", criteria: [] });
    expect(parseGoalCommand("build it -- tests pass; docs updated")).toEqual({
      kind: "start",
      objective: "build it",
      criteria: ["tests pass", "docs updated"],
    });
  });

  it("parses implement and verify loop entries with plan defaults", () => {
    expect(parseGoalCommand("--verify --plan path/to/plan.md")).toEqual({
      kind: "start",
      objective: "Verify the referenced plan.",
      criteria: [],
      loop: true,
      planPath: "path/to/plan.md",
      entry: "verify",
    });
    expect(parseGoalCommand("--implement --plan path/to/plan.md")).toEqual({
      kind: "start",
      objective: "Implement the referenced plan.",
      criteria: [],
      loop: true,
      planPath: "path/to/plan.md",
      entry: "implement",
    });
    expect(parseGoalCommand("Audit repo --verify --plan path/to/plan.md")).toEqual({
      kind: "start",
      objective: "Audit repo",
      criteria: [],
      loop: true,
      planPath: "path/to/plan.md",
      entry: "verify",
    });
  });

  it("parses fresh loop entries without changing bare fresh", () => {
    expect(parseGoalCommand("fresh")).toEqual({ kind: "fresh" });
    expect(parseGoalCommand("fresh --verify")).toEqual({ kind: "fresh", entry: "verify" });
    expect(parseGoalCommand("fresh --implement")).toEqual({ kind: "fresh", entry: "implement" });
  });

  it("parses loop flags in any position and supports quoted plan paths", () => {
    expect(parseGoalCommand('Implement the plan --loop --max-cycles 5 --plan "plans/my plan.md" -- tests pass; docs updated')).toEqual({
      kind: "start",
      objective: "Implement the plan",
      criteria: ["tests pass", "docs updated"],
      loop: true,
      planPath: "plans/my plan.md",
      maxCycles: 5,
    });
    expect(parseGoalCommand('--loop --plan "plans/my plan.md"')).toEqual({
      kind: "start",
      objective: "Implement the referenced plan.",
      criteria: [],
      loop: true,
      planPath: "plans/my plan.md",
    });
    expect(parseGoalCommand("Implement -- tests pass --loop --max-cycles=2")).toEqual({
      kind: "start",
      objective: "Implement",
      criteria: ["tests pass"],
      loop: true,
      maxCycles: 2,
    });
  });

  it("rejects malformed loop flags and objective omission without a plan", () => {
    expect(() => parseGoalCommand("--loop --loop implement")).toThrow(/only once/);
    expect(() => parseGoalCommand("--loop --plan one.md --plan two.md")).toThrow(/--plan may be provided only once/);
    expect(() => parseGoalCommand("--loop --plan")).toThrow(/requires a value/);
    expect(() => parseGoalCommand("--loop --max-cycles 0 implement")).toThrow(/positive integer/);
    expect(() => parseGoalCommand("--loop --max-cycles 1.5 implement")).toThrow(/positive integer/);
    expect(() => parseGoalCommand("--loop --unknown implement")).toThrow(/Unknown goal option/);
    expect(() => parseGoalCommand("--loop -- tests pass")).toThrow(/objective cannot be empty/);
  });

  it("rejects duplicate, valued, and mutually exclusive entry switches", () => {
    expect(() => parseGoalCommand("--verify --verify --plan path.md")).toThrow(/only once/);
    expect(() => parseGoalCommand("--implement --implement --plan path.md")).toThrow(/only once/);
    expect(() => parseGoalCommand("--verify=true --plan path.md")).toThrow(/does not take a value/);
    expect(() => parseGoalCommand("--implement=false --plan path.md")).toThrow(/does not take a value/);
    expect(() => parseGoalCommand("--verify --implement --plan path.md")).toThrow(/mutually exclusive/);
    expect(() => parseGoalCommand("fresh --verify --verify")).toThrow(/only once/);
    expect(() => parseGoalCommand("fresh --verify --implement")).toThrow(/mutually exclusive/);
  });
});

describe("goal state", () => {
  const hash = "a".repeat(64);

  function loopState(overrides: Partial<GoalStateV2> = {}): GoalStateV2 {
    return {
      schemaVersion: 2,
      loopId: "loop-1",
      generation: 1,
      contextEpoch: 0,
      phase: "implementing",
      cycle: 0,
      maxCycles: 5,
      objective: "ship feature",
      criteria: ["tests pass"],
      plan: { sourceKind: "explicit", sourcePath: "/repo/plan.md", snapshotPath: "/agent/plan.md", snapshotHash: hash },
      ...overrides,
    };
  }

  it("rejects legacy/malformed state and restores latest native branch state", () => {
    expect(parseGoalState({ schemaVersion: 0 })).toBeUndefined();
    const entries = [
      { type: "custom", customType: "goal-state", data: { status: "active" } },
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal({ status: "paused" }) },
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal({ status: "active", generation: 2 }) },
    ] as unknown as SessionEntry[];
    expect(latestGoalState(entries)?.generation).toBe(2);
    expect(latestGoalState(entries)?.status).toBe("active");
  });

  it("strictly restores v2 loops and fails closed on malformed loop markers", () => {
    const valid = loopState({
      verifier: {
        outcome: "replan",
        repositoryFingerprint: "repo-fingerprint",
        evidenceFingerprint: "evidence-fingerprint",
        correctionPath: "/agent/cycle-1-plan.md",
        correctionHash: hash,
      },
      epochMarker: { id: "epoch-1", hash },
      reasons: { stagnation: "No change yet." },
      createdAt: 1,
      updatedAt: 2,
    });
    expect(parseGoalStateV2(valid)).toEqual(valid);
    expect(parseGoalState(valid)).toEqual(valid);
    const entries = [
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal() },
      { type: "custom", customType: GOAL_STATE_V2_TYPE, data: valid },
    ] as unknown as SessionEntry[];
    expect(latestGoalStateMarker(entries)).toEqual(valid);
    expect(latestGoalLoopState(entries)).toEqual(valid);

    const malformed = { ...valid, maxCycles: 0 };
    expect(parseGoalStateV2(malformed)).toBeUndefined();
    expect(latestGoalStateMarker([
      ...entries,
      { type: "custom", customType: GOAL_STATE_V2_TYPE, data: malformed } as unknown as SessionEntry,
    ])).toBeUndefined();
  });

  it("strictly parses pending verification metadata and preserves old v2 markers", () => {
    const legacy = loopState();
    expect(parseGoalStateV2(legacy)).toEqual(legacy);
    expect(latestGoalStateMarker([
      { type: "custom", customType: GOAL_STATE_V2_TYPE, data: legacy },
    ] as unknown as SessionEntry[])).toEqual(legacy);
    expect(latestGoalStateMarker([
      { type: "custom", customType: GOAL_STATE_TYPE, data: legacy },
    ] as unknown as SessionEntry[])).toEqual(legacy);

    const pending = loopState({ pendingVerificationEntry: true });
    expect(parseGoalStateV2(pending)).toEqual(pending);
    expect(pending.pendingVerificationEntry).toBe(true);
    expect(pending.phase).toBe("implementing");

    for (const invalid of [false, "true", 1, null, undefined]) {
      expect(parseGoalStateV2({ ...legacy, pendingVerificationEntry: invalid })).toBeUndefined();
    }
    expect(parseGoalStateV2({ ...legacy, unexpected: true })).toBeUndefined();
  });

  it("strictly validates durable tree reanchor proofs", () => {
    const proof = {
      kind: "tree-selection" as const,
      sessionId: "session-1",
      targetLeafId: "selected-leaf",
      loopId: "loop-1",
      generation: 1,
      contextEpoch: 0,
      cycle: 0,
      planSnapshotHash: hash,
    };
    const valid = loopState({ phase: "paused", reanchor: proof });
    expect(parseGoalStateV2(valid)).toEqual(valid);
    expect(parseGoalStateV2(loopState())).toEqual(loopState());

    for (const reanchor of [
      { ...proof, extra: true },
      { ...proof, kind: "manual-pause" },
      { ...proof, targetLeafId: "" },
      { ...proof, planSnapshotHash: "not-a-hash" },
      { ...proof, loopId: "other-loop" },
      { ...proof, generation: 2 },
      { ...proof, contextEpoch: 1 },
      { ...proof, cycle: 1 },
    ]) {
      expect(parseGoalStateV2(loopState({ phase: "paused", reanchor } as Partial<GoalStateV2>))).toBeUndefined();
    }
    expect(parseGoalStateV2(loopState({ reanchor: proof }))).toBeUndefined();
  });

  it("keeps conservative loop settings bounded", () => {
    expect(DEFAULT_GOAL_LOOP_SETTINGS.maxCycles).toBeGreaterThan(0);
    expect(DEFAULT_GOAL_LOOP_SETTINGS.maxCycles).toBeLessThanOrEqual(GOAL_LOOP_SETTING_BOUNDS.maxCycles.max);
    expect(DEFAULT_GOAL_LOOP_SETTINGS.maxPlanBytes).toBeLessThanOrEqual(GOAL_LOOP_SETTING_BOUNDS.maxPlanBytes.max);
    expect(DEFAULT_GOAL_LOOP_SETTINGS.maxCorrectionBytes).toBeLessThanOrEqual(GOAL_LOOP_SETTING_BOUNDS.maxCorrectionBytes.max);
    expect(DEFAULT_GOAL_LOOP_SETTINGS.maxBootstrapBytes).toBeLessThanOrEqual(GOAL_LOOP_SETTING_BOUNDS.maxBootstrapBytes.max);
  });

  it("treats the newest native clear marker as no effective branch goal", () => {
    const entries = [
      { type: "custom", customType: GOAL_STATE_TYPE, data: goal() },
      {
        type: "custom",
        customType: GOAL_STATE_TYPE,
        data: goal({ status: "stopped", terminalReason: CLEARED_REASON, lastReason: CLEARED_REASON }),
      },
    ] as unknown as SessionEntry[];
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
    expect(parseVerifierVerdict('{"ok":false,"reason":"acceptance check failed","evidence":["npm test: 1 failed","src/x.ts mismatch"]}')).toEqual({
      ok: false,
      reason: "acceptance check failed\nEvidence: npm test: 1 failed | src/x.ts mismatch",
      evidence: ["npm test: 1 failed", "src/x.ts mismatch"],
    });
  });

  it("diagnoses malformed verifier output with bounded safe metadata", () => {
    const raw = JSON.stringify({
      outcome: "pass",
      reason: "DO_NOT_PERSIST_THIS_REASON_VALUE",
      evidence: ["DO_NOT_PERSIST_THIS_EVIDENCE_VALUE"],
      "unsafe-key": "DO_NOT_PERSIST_THIS_KEY_VALUE",
      safeKey: "value",
      "$safe": "value",
    });
    const diagnostic = diagnoseVerifierOutput(raw);
    const expectedHash = createHash("sha256").update(raw, "utf8").digest("hex");

    expect(diagnostic.category).toBe("invalid-v2-schema");
    expect(diagnostic.charLength).toBe(raw.length);
    expect(diagnostic.byteLength).toBe(Buffer.byteLength(raw, "utf8"));
    expect(diagnostic.sha256).toBe(expectedHash);
    expect(diagnostic.fingerprint).toBe(expectedHash);
    expect(diagnostic.bracesFound).toBe(true);
    expect(diagnostic.jsonObjectFound).toBe(true);
    expect(diagnostic.topLevelKeys).toEqual(["$safe", "evidence", "outcome", "reason", "safeKey"]);
    expect(diagnostic.summary.length).toBeLessThanOrEqual(500);
    expect(diagnostic.summary).not.toContain("DO_NOT_PERSIST_THIS_REASON_VALUE");
    expect(diagnostic.summary).not.toContain("DO_NOT_PERSIST_THIS_EVIDENCE_VALUE");
    expect(diagnostic.summary).not.toContain("DO_NOT_PERSIST_THIS_KEY_VALUE");
    expect(diagnoseVerifierOutput(raw).sha256).toBe(diagnostic.sha256);

    expect(diagnoseVerifierOutput("no JSON response")).toMatchObject({
      category: "no-object",
      bracesFound: false,
      jsonObjectFound: false,
      topLevelKeys: [],
    });
    expect(diagnoseVerifierOutput("{not valid JSON}").category).toBe("invalid-json");
    expect(diagnoseVerifierOutput('{"ok":true,"reason":"legacy secret"}')).toMatchObject({
      category: "legacy-v1-shape",
      jsonObjectFound: true,
      topLevelKeys: ["ok", "reason"],
    });
  });

  it("builds a retry prompt from diagnostics without prior output", () => {
    const raw = '{"reason":"RAW_PRIOR_SECRET","evidence":["RAW_EVIDENCE_SECRET"]}';
    const diagnostic = diagnoseVerifierOutput(raw);
    const prompt = buildVerifierRetryPrompt("base V2 prompt with evidence-3", diagnostic, "evidence-3");

    expect(prompt).toContain("base V2 prompt with evidence-3");
    expect(prompt).toContain("Schema correction (one retry only)");
    expect(prompt).toContain(diagnostic.summary);
    expect(prompt).toContain("exactly one JSON object using the existing V2 schema");
    expect(prompt).toContain("evidence-3");
    expect(prompt).not.toContain("RAW_PRIOR_SECRET");
    expect(prompt).not.toContain("RAW_EVIDENCE_SECRET");
  });

  it("fingerprints evidence deterministically", () => {
    expect(fingerprintEvidence("a")).toBe(fingerprintEvidence("a"));
    expect(fingerprintEvidence("a")).not.toBe(fingerprintEvidence("b"));
  });

  it("fingerprints only substantive work from the latest goal iteration", () => {
    const first = progressEvidence(100, "call-1");
    const sameWorkWithNewRuntimeMetadata = progressEvidence(200, "call-2");
    const changedResult = progressEvidence(300, "call-3", "FAIL: regression");

    expect(fingerprintEvidence(first)).toBe(fingerprintEvidence(sameWorkWithNewRuntimeMetadata));
    expect(fingerprintEvidence(`${first}\n${sameWorkWithNewRuntimeMetadata}`)).toBe(
      fingerprintEvidence(sameWorkWithNewRuntimeMetadata),
    );
    expect(fingerprintEvidence(sameWorkWithNewRuntimeMetadata)).not.toBe(fingerprintEvidence(changedResult));
  });
});
