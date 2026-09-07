import { describe, expect, it } from "vitest";
import {
  DEFAULT_DISPLAY_TOKEN_INTERVAL,
  createProgressCheckpointController,
  type ProgressCheckpointConfig,
  type ProgressCheckpointReport,
} from "../src/progress-checkpoint.js";

const activation = { explicit: true, orchestratorOwned: true } as const;

function config(overrides: Partial<ProgressCheckpointConfig> = {}): ProgressCheckpointConfig {
  return {
    activation,
    displayTokenInterval: 10,
    ...overrides,
  };
}

function report(checkpointId: string, evidence: string, extra: Partial<ProgressCheckpointReport> = {}): ProgressCheckpointReport {
  return {
    checkpointId,
    progress: "work continues",
    evidence,
    blocker: "",
    nextAction: "continue",
    ...extra,
  };
}

function request(controller: ReturnType<typeof createProgressCheckpointController>, tokens: number) {
  const effects = controller.observe({ displayTokens: tokens, safeBoundary: true });
  expect(effects).toHaveLength(1);
  expect(effects[0]?.type).toBe("checkpoint-request");
  return effects[0] as Extract<(typeof effects)[number], { type: "checkpoint-request" }>;
}

describe("pure progress checkpoint policy", () => {
  it("uses Luna's bounded token default and allows productive unlimited intervals", () => {
    const controller = createProgressCheckpointController({ activation });
    expect(controller.config.displayTokenInterval).toBe(DEFAULT_DISPLAY_TOKEN_INTERVAL);

    const first = createProgressCheckpointController(config());
    const firstRequest = request(first, 10);
    expect(first.report(report(firstRequest.checkpointId, "inspected files"), { safeBoundary: true })).toEqual([]);
    const secondRequest = request(first, 20);
    expect(secondRequest.checkpointId).not.toBe(firstRequest.checkpointId);
    expect(first.report(report(secondRequest.checkpointId, "changed tests"), { safeBoundary: true })).toEqual([]);
    const thirdRequest = request(first, 30);
    expect(thirdRequest.checkpointId).not.toBe(secondRequest.checkpointId);
  });

  it("requests one parent assessment for repeated unchanged work, never a kill", () => {
    const controller = createProgressCheckpointController(config({ repeatedReportThreshold: 2 }));
    const first = request(controller, 10);
    expect(controller.report(report(first.checkpointId, "same evidence"), { safeBoundary: true })).toEqual([]);
    const second = request(controller, 20);
    expect(controller.report(report(second.checkpointId, "same evidence"), { safeBoundary: true })).toMatchObject([
      { type: "parent-attention-request", request: "handoff", reason: "repeated-no-progress" },
    ]);
    const third = request(controller, 30);
    expect(controller.report(report(third.checkpointId, "same evidence"), { safeBoundary: true })).toEqual([]);
  });

  it("treats changed fingerprints as legitimate reruns", () => {
    const controller = createProgressCheckpointController({
      ...config({ displayTokenInterval: 1_000, repeatedFingerprintThreshold: 2 }),
    });
    expect(controller.observe({ actionFingerprint: "read:a", resultFingerprint: "r:a" })).toEqual([]);
    const first = controller.observe({
      actionFingerprint: "read:a",
      resultFingerprint: "r:a",
      safeBoundary: true,
    });
    expect(first).toMatchObject([{ type: "checkpoint-request", reason: "repeated-fingerprint" }]);
    const firstId = (first[0] as { checkpointId: string }).checkpointId;
    expect(controller.report(report(firstId, "a"), { safeBoundary: true })).toEqual([]);

    expect(controller.observe({ actionFingerprint: "read:b", resultFingerprint: "r:b" })).toEqual([]);
    expect(controller.observe({
      actionFingerprint: "read:b",
      resultFingerprint: "r:b",
      safeBoundary: true,
    })).toMatchObject([{ type: "checkpoint-request", reason: "repeated-fingerprint" }]);
  });

  it("allows no-edit reports when their evidence is new", () => {
    const controller = createProgressCheckpointController(config());
    const first = request(controller, 10);
    expect(controller.report(report(first.checkpointId, "no edits: searched three files"), { safeBoundary: true })).toEqual([]);
    const second = request(controller, 20);
    expect(controller.report(report(second.checkpointId, "no edits: tests still pass"), { safeBoundary: true })).toEqual([]);
    expect(controller.onSafeBoundary()).toEqual([]);
  });

  it("preserves lifetime baselines and attention across compaction", () => {
    const controller = createProgressCheckpointController(config({ displayTokenInterval: 100 }));
    expect(controller.observe({ displayTokens: 90 })).toEqual([]);
    const first = controller.observe({ displayTokens: 100, compaction: true, safeBoundary: true });
    expect(first).toMatchObject([{ type: "checkpoint-request", reason: "display-token-interval" }]);
    const firstId = (first[0] as { checkpointId: string }).checkpointId;
    expect(controller.report(report(firstId, "same evidence", { blocker: "first wording" }), { safeBoundary: true }))
      .toMatchObject([{ type: "parent-attention-request", reason: "blocker" }]);

    // Compaction does not reset the lifetime baseline or the one-attention latch.
    expect(controller.observe({ displayTokens: 100, compaction: true, safeBoundary: true })).toEqual([]);
    const second = controller.observe({ displayTokens: 200, compaction: true, safeBoundary: true });
    expect(second).toMatchObject([{ type: "checkpoint-request", reason: "display-token-interval" }]);
    const secondId = (second[0] as { checkpointId: string }).checkpointId;
    expect(controller.report(report(secondId, "same evidence", { blocker: "different wording" }), { safeBoundary: true }))
      .toEqual([]);
  });

  it("only delivers at safe boundaries and suppresses canceled or settled effects", () => {
    const canceled = createProgressCheckpointController(config());
    expect(canceled.observe({ displayTokens: 10 })).toEqual([]);
    canceled.cancel();
    expect(canceled.onSafeBoundary()).toEqual([]);
    expect(canceled.lifecycle).toBe("canceled");

    const settled = createProgressCheckpointController(config());
    expect(settled.observe({ displayTokens: 10 })).toEqual([]);
    settled.settle();
    expect(settled.onSafeBoundary()).toEqual([]);
    expect(settled.lifecycle).toBe("settled");

    const boundary = createProgressCheckpointController(config());
    expect(boundary.observe({ displayTokens: 10, safeBoundary: false })).toEqual([]);
    expect(boundary.onSafeBoundary()).toMatchObject([{ type: "checkpoint-request" }]);
  });

  it("keeps activation queued until an alive lifecycle observation", () => {
    const controller = createProgressCheckpointController({ ...config(), initialLifecycle: "queued" });
    expect(controller.observe({ displayTokens: 10, safeBoundary: true })).toEqual([]);
    expect(controller.lifecycle).toBe("queued");
    expect(controller.observe({ lifecycle: "alive", displayTokens: 10, safeBoundary: true })).toEqual([]);
    expect(controller.lifecycle).toBe("alive");
    expect(controller.observe({ displayTokens: 20, safeBoundary: true })).toMatchObject([
      { type: "checkpoint-request" },
    ]);
  });

  it("does not treat nextAction as evidence and latches differently worded blockers", () => {
    const controller = createProgressCheckpointController(config());
    const first = request(controller, 10);
    expect(controller.report(report(first.checkpointId, "one observed fact", { nextAction: "read a" }), { safeBoundary: true }))
      .toEqual([]);
    const second = request(controller, 20);
    expect(controller.report(report(second.checkpointId, "one observed fact", { nextAction: "read b" }), { safeBoundary: true }))
      .toMatchObject([{ type: "parent-attention-request", reason: "repeated-no-progress" }]);
    const third = request(controller, 30);
    expect(controller.report(report(third.checkpointId, "one observed fact", { blocker: "wording changed" }), { safeBoundary: true }))
      .toEqual([]);
  });

  it("requires explicit parent continuation to clear attention while retaining metric baselines", () => {
    const controller = createProgressCheckpointController(config());
    const first = request(controller, 10);
    expect(controller.report(report(first.checkpointId, "blocked", { blocker: "input needed" }), { safeBoundary: true }))
      .toMatchObject([{ type: "parent-attention-request" }]);
    expect(controller.continueFromParent()).toEqual([]);
    const second = request(controller, 20);
    expect(controller.report(report(second.checkpointId, "new evidence", { blocker: "input still needed" }), { safeBoundary: true }))
      .toMatchObject([{ type: "parent-attention-request", reason: "blocker" }]);
  });

  it("makes reports idempotent by checkpoint ID", () => {
    const controller = createProgressCheckpointController(config());
    const checkpoint = request(controller, 10);
    const blocker = report(checkpoint.checkpointId, "blocked", { blocker: "needs parent input" });
    expect(controller.report(blocker, { safeBoundary: true })).toMatchObject([
      { type: "parent-attention-request", reason: "blocker" },
    ]);
    expect(controller.report(blocker, { safeBoundary: true })).toEqual([]);
  });

  it("restores baselines and handled IDs without storing raw observations", () => {
    const original = createProgressCheckpointController(config());
    const checkpoint = request(original, 10);
    const saved = original.snapshot();
    expect(saved.lastFingerprint).toBeUndefined();

    const restored = createProgressCheckpointController(config(), saved);
    expect(restored.report(report(checkpoint.checkpointId, "done"), { safeBoundary: true })).toEqual([]);
    expect(restored.report(report(checkpoint.checkpointId, "done"), { safeBoundary: true })).toEqual([]);
    expect(restored.observe({ displayTokens: 20, safeBoundary: true })).toMatchObject([
      { type: "checkpoint-request" },
    ]);
  });

  it("does not activate by default for native goals and resolves provider overrides", () => {
    const nativeGoal = createProgressCheckpointController({
      enabled: true,
      displayTokenInterval: 1,
      activation: { explicit: true, orchestratorOwned: true, nativeGoal: true },
    });
    expect(nativeGoal.isEnabled).toBe(false);
    expect(nativeGoal.observe({ displayTokens: 100, safeBoundary: true })).toEqual([]);

    const overridden = createProgressCheckpointController({
      activation,
      provider: "local",
      model: "luna",
      overrideResolver: ({ provider, model }) => (
        provider === "local" && model === "luna" ? { displayTokenInterval: 7 } : undefined
      ),
    });
    expect(overridden.config.displayTokenInterval).toBe(7);
  });
});
