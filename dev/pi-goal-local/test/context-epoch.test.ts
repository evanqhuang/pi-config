import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import {
  buildContextEpochBootstrap,
  createContextEpochMarker,
  filterContextWithDisposition,
  hashContextEpochBootstrap,
  parseContextEpochBootstrap,
  parseContextEpochMarker,
  serializeContextEpochBootstrap,
  validateContextEpochBootstrap,
  type ContextEpochBootstrap,
  type GoalContextMessage,
} from "../src/context-epoch.js";
import { GOAL_CONTEXT_EPOCH_TYPE, type GoalStateV2 } from "../src/types.js";

type Message = ContextEvent["messages"][number];

const PLAN = "# Immutable plan\nImplement the bounded epoch core.\n";
const PLAN_HASH = createHash("sha256").update(PLAN).digest("hex");
const PLAN_PATH = "/agent/goal-loops/loop-1/original-plan.md";

function state(overrides: Partial<GoalStateV2> = {}): GoalStateV2 {
  return {
    schemaVersion: 2,
    loopId: "loop-1",
    generation: 1,
    contextEpoch: 0,
    phase: "implementing",
    cycle: 0,
    maxCycles: 5,
    objective: "Implement the bounded epoch core.",
    criteria: ["old context is removed", "tool pairs remain complete"],
    plan: {
      sourceKind: "explicit",
      sourcePath: "/workspace/plan.md",
      snapshotPath: PLAN_PATH,
      snapshotHash: PLAN_HASH,
    },
    ...overrides,
  };
}

function bootstrap(current: GoalStateV2, correction = false): ContextEpochBootstrap {
  return buildContextEpochBootstrap(current, {
    originalPlan: { path: PLAN_PATH, hash: PLAN_HASH, content: PLAN },
    ...(correction ? {
      correction: {
        path: "/agent/goal-loops/loop-1/cycle-1-plan.md",
        content: "Fix the context filter and run its focused tests.\n",
        hash: createHash("sha256").update("Fix the context filter and run its focused tests.\n").digest("hex"),
      },
    } : {}),
    verifier: {
      discrepancies: correction ? ["The first implementation retained old tool traffic."] : [],
      requiredValidation: ["npm run check --prefix dev/pi-goal-local"],
    },
    capabilityGuidance: ["Use the available repository tools; do not trust prior-cycle claims."],
    continuationInstruction: "Continue implementation until candidate completion, then stop for independent verification.",
  }, { maxBootstrapBytes: 64 * 1024 });
}

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 10 } as Message;
}

function assistant(text: string, toolCallId?: string): Message {
  return {
    role: "assistant",
    content: [
      { type: "text", text },
      ...(toolCallId ? [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "npm test" } }] : []),
    ],
    api: "responses",
    provider: "test-provider",
    model: "test-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: toolCallId ? "toolUse" : "stop",
    timestamp: 11,
  } as Message;
}

function toolResult(toolCallId: string, text: string): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 12,
  } as Message;
}

function compaction(summary: string): Message {
  return { role: "compactionSummary", summary, tokensBefore: 100, timestamp: 9 } as Message;
}

function markerFor(current: GoalStateV2, correction = false): { state: GoalStateV2; bootstrap: ContextEpochBootstrap; marker: Message } {
  const built = bootstrap(current, correction);
  const marker = createContextEpochMarker(built, { timestamp: 20, maxBootstrapBytes: 64 * 1024 });
  return { state: current, bootstrap: built, marker };
}

describe("durable goal context epochs", () => {
  it("retains the latest marker and current complete tool traffic while excluding old secrets and compaction", () => {
    const current = state({ verifier: {
      outcome: "replan",
      correctionPath: "/agent/goal-loops/loop-1/cycle-1-plan.md",
      correctionHash: createHash("sha256").update("Fix the context filter and run its focused tests.\n").digest("hex"),
    } });
    const { bootstrap: currentBootstrap, marker } = markerFor(current, true);
    const input = [
      user("old secret-free sentinel: previous cycle"),
      assistant("old assistant tool traffic", "old-call"),
      toolResult("old-call", "old tool result"),
      compaction("summary containing old secret-free sentinel"),
      marker,
      assistant("current correction implementation", "current-call"),
      toolResult("current-call", "current tool result"),
    ] as GoalContextMessage[];
    const result = filterContextWithDisposition(input, current, { bootstrap: currentBootstrap });

    expect(result.disposition).toBe("matched");
    expect(result.messages).not.toBe(input);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0]).toMatchObject({ role: "custom", customType: GOAL_CONTEXT_EPOCH_TYPE });
    expect(JSON.stringify(result.messages)).not.toContain("old secret-free sentinel");
    expect(JSON.stringify(result.messages)).not.toContain("old-call");
    expect(JSON.stringify(result.messages)).not.toContain("old tool result");
    expect(JSON.stringify(result.messages)).not.toContain("compaction containing");
    expect(JSON.stringify(result.messages)).toContain("current-call");
    expect(JSON.stringify(result.messages)).toContain("current tool result");
    expect(parseContextEpochMarker(result.messages[0], current).bootstrap).toEqual(currentBootstrap);
  });

  it("keeps only the newest of two rotations", () => {
    const first = state();
    const firstEpoch = markerFor(first);
    const correctionText = "Fix the context filter and run its focused tests.\n";
    const second = state({
      contextEpoch: 1,
      verifier: {
        outcome: "replan",
        correctionPath: "/agent/goal-loops/loop-1/cycle-1-plan.md",
        correctionHash: createHash("sha256").update(correctionText).digest("hex"),
      },
    });
    const secondEpoch = markerFor(second, true);
    const input = [
      firstEpoch.marker,
      user("old epoch sentinel"),
      assistant("old epoch work", "old-epoch-call"),
      toolResult("old-epoch-call", "old epoch result"),
      secondEpoch.marker,
      user("new epoch turn"),
      assistant("new epoch work", "new-epoch-call"),
      toolResult("new-epoch-call", "new epoch result"),
    ] as GoalContextMessage[];

    const result = filterContextWithDisposition(input, second, { bootstrap: secondEpoch.bootstrap });
    expect(result.disposition).toBe("matched");
    expect(result.messages.filter(message => (message as { role?: string }).role === "custom")).toHaveLength(1);
    expect(JSON.stringify(result.messages)).not.toContain("old epoch sentinel");
    expect(JSON.stringify(result.messages)).not.toContain("old-epoch-call");
    expect(JSON.stringify(result.messages)).toContain("new-epoch-call");
  });

  it("rejects stale markers and fails closed to a bootstrap without old traffic", () => {
    const current = state({ contextEpoch: 1 });
    const currentBootstrap = bootstrap(current);
    const stale = markerFor(state()).marker;
    const input = [stale, user("stale epoch sentinel"), assistant("stale work", "stale-call"), toolResult("stale-call", "stale result")];
    const before = structuredClone(input);
    const result = filterContextWithDisposition(input, current, { bootstrap: currentBootstrap });

    expect(result.disposition).toBe("rejected");
    expect(result.safeSuffixIncluded).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ role: "custom", customType: GOAL_CONTEXT_EPOCH_TYPE });
    expect(JSON.stringify(result.messages)).not.toContain("stale epoch sentinel");
    expect(input).toEqual(before);
    expect(parseContextEpochMarker(result.messages[0], current).bootstrap).toEqual(currentBootstrap);
  });

  it("fails closed for malformed and conflicting authoritative markers", () => {
    const current = state();
    const first = markerFor(current);
    const conflictingBootstrap = buildContextEpochBootstrap(current, {
      originalPlan: { path: PLAN_PATH, hash: PLAN_HASH, content: PLAN },
      verifier: { discrepancies: [], requiredValidation: ["different validation"] },
      capabilityGuidance: ["Conflicting guidance must not win."],
      continuationInstruction: "continue with the conflicting bootstrap",
    }, { maxBootstrapBytes: 64 * 1024 });
    const conflicting = createContextEpochMarker(conflictingBootstrap, { maxBootstrapBytes: 64 * 1024 });
    const malformed = {
      ...first.marker,
      content: "{\"schemaVersion\":1}",
    } as Message;
    const result = filterContextWithDisposition([
      user("old sentinel"),
      malformed,
      first.marker,
      conflicting,
      assistant("must not survive", "unsafe-call"),
      toolResult("unsafe-call", "unsafe result"),
    ], current, { bootstrap: first.bootstrap });

    expect(result.disposition).toBe("rejected");
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result.messages)).not.toContain("old sentinel");
    expect(JSON.stringify(result.messages)).not.toContain("unsafe-call");
  });

  it("uses only a safe latest user-led suffix when the marker is missing", () => {
    const current = state();
    const currentBootstrap = bootstrap(current);
    const input = [
      user("old transcript sentinel"),
      assistant("old work", "old-call"),
      toolResult("old-call", "old result"),
      user("latest user request"),
      assistant("latest work", "latest-call"),
      toolResult("latest-call", "latest result"),
    ] as GoalContextMessage[];
    const result = filterContextWithDisposition(input, current, { bootstrap: currentBootstrap });

    expect(result.disposition).toBe("fallback-safe");
    expect(result.safeSuffixIncluded).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain("old transcript sentinel");
    expect(JSON.stringify(result.messages)).not.toContain("old-call");
    expect(JSON.stringify(result.messages)).toContain("latest user request");
    expect(JSON.stringify(result.messages)).toContain("latest-call");
  });

  it("retains complete autonomous tool traffic after a compaction boundary when the marker is missing", () => {
    const current = state();
    const currentBootstrap = bootstrap(current);
    const result = filterContextWithDisposition([
      compaction("old compacted context"),
      assistant("continue autonomously", "current-call"),
      toolResult("current-call", "current result"),
    ], current, { bootstrap: currentBootstrap });

    expect(result.disposition).toBe("fallback-safe");
    expect(result.safeSuffixIncluded).toBe(true);
    expect(JSON.stringify(result.messages)).not.toContain("old compacted context");
    expect(JSON.stringify(result.messages)).toContain("current-call");
    expect(JSON.stringify(result.messages)).toContain("current result");
  });

  it("returns bootstrap only when no safe complete user-led suffix exists", () => {
    const current = state();
    const currentBootstrap = bootstrap(current);
    const result = filterContextWithDisposition([
      assistant("orphaned old assistant", "missing-result"),
      compaction("old summary"),
    ], current, { bootstrap: currentBootstrap });

    expect(result.disposition).toBe("fallback-unsafe");
    expect(result.safeSuffixIncluded).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(JSON.stringify(result.messages)).not.toContain("orphaned old assistant");
  });

  it("binds pending verification metadata into bootstrap hashes and roundtrips it", () => {
    const legacy = state();
    const pending = state({ pendingVerificationEntry: true });
    const legacyBootstrap = bootstrap(legacy);
    const pendingBootstrap = bootstrap(pending);

    expect(legacyBootstrap).not.toHaveProperty("pendingVerificationEntry");
    expect(pendingBootstrap.pendingVerificationEntry).toBe(true);
    expect(hashContextEpochBootstrap(legacyBootstrap)).not.toBe(hashContextEpochBootstrap(pendingBootstrap));

    const serialized = serializeContextEpochBootstrap(pendingBootstrap);
    expect(serialized).toContain('"pendingVerificationEntry":true');
    expect(parseContextEpochBootstrap(serialized)).toEqual(pendingBootstrap);
  });

  it("rejects pending verification bootstrap mismatches in both directions while accepting legacy omission", () => {
    const legacy = state();
    const pending = state({ pendingVerificationEntry: true });
    const legacyBootstrap = bootstrap(legacy);
    const pendingBootstrap = bootstrap(pending);
    const missingPendingBootstrap = { ...pendingBootstrap };
    delete missingPendingBootstrap.pendingVerificationEntry;

    expect(() => validateContextEpochBootstrap(
      { ...legacyBootstrap, pendingVerificationEntry: true },
      legacy,
    )).toThrow(/identity|pendingVerificationEntry/i);
    expect(() => validateContextEpochBootstrap(missingPendingBootstrap, pending)).toThrow(/identity|pendingVerificationEntry/i);
    expect(validateContextEpochBootstrap(legacyBootstrap, legacy)).toEqual(legacyBootstrap);
  });

  it("rejects plan and marker hash mismatches", () => {
    const current = state();
    expect(() => buildContextEpochBootstrap(current, {
      originalPlan: { path: PLAN_PATH, hash: "0".repeat(64), content: PLAN },
      capabilityGuidance: ["guidance"],
      continuationInstruction: "continue",
    })).toThrow(/hash/i);
    const epoch = markerFor(current);
    expect(() => parseContextEpochMarker({
      ...epoch.marker,
      details: { ...(epoch.marker as { details: object }).details, hash: "0".repeat(64) },
    }, current)).toThrow(/hash/i);
  });
});
