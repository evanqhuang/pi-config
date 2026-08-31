import { describe, expect, it } from "vitest";
import {
  createPlanBridge,
  PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL,
  PLAN_MODE_BRIDGE_VERSION,
  type ApprovedPlanBridgeResult,
} from "../src/plan-bridge.js";

type Handler = (data: unknown) => void;

function fakeBus() {
  const listeners = new Map<string, Set<Handler>>();
  let emittedQueries = 0;
  return {
    get emittedQueries() { return emittedQueries; },
    on(channel: string, handler: Handler) {
      const channelListeners = listeners.get(channel) ?? new Set<Handler>();
      channelListeners.add(handler);
      listeners.set(channel, channelListeners);
      return () => channelListeners.delete(handler);
    },
    emit(channel: string, data: unknown) {
      if (channel === PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL) emittedQueries += 1;
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    listenerCount(channel: string) { return listeners.get(channel)?.size ?? 0; },
  };
}

const yoloPlan: ApprovedPlanBridgeResult = {
  sourceKind: "approved",
  sourcePath: "/agent/plans/approved/plan.md",
  planPath: "/agent/plans/approved/plan.md",
  action: "yolo-direct",
  strategy: "YOLO",
};

const prewalkPlan: ApprovedPlanBridgeResult = {
  sourceKind: "approved",
  sourcePath: "/agent/plans/prewalk/plan.md",
  planPath: "/agent/plans/prewalk/plan.md",
  action: "prewalk",
  strategy: "PREWALK",
  prewalk: { required: true },
};

describe("goal-local pi-plan-mode bridge", () => {
  it("queries a typed approved result, rejects malformed replies, and honors explicit precedence", async () => {
    const bus = fakeBus();
    const bridge = createPlanBridge(bus, 10);
    bus.on(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL, request => {
      const requestId = (request as { requestId: string }).requestId;
      bus.emit(`${PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL}:reply:${requestId}`, {
        version: PLAN_MODE_BRIDGE_VERSION,
        requestId,
        result: yoloPlan,
      });
    });

    await expect(bridge.queryApprovedPlan()).resolves.toEqual(yoloPlan);
    const explicit = await bridge.resolvePlan({ explicitPlanPath: "plans/explicit.md" });
    expect(explicit).toEqual({ sourceKind: "explicit", sourcePath: "plans/explicit.md", planPath: "plans/explicit.md" });
    expect(bus.emittedQueries).toBe(1);
    bridge.dispose();
  });

  it("preserves PREWALK requirements in explicit approved-plan queries", async () => {
    const bus = fakeBus();
    const bridge = createPlanBridge(bus, 10);
    bus.on(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL, request => {
      const requestId = (request as { requestId: string }).requestId;
      bus.emit(`${PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL}:reply:${requestId}`, {
        version: PLAN_MODE_BRIDGE_VERSION,
        requestId,
        result: prewalkPlan,
      });
    });

    await expect(bridge.queryApprovedPlan()).resolves.toEqual(prewalkPlan);
    bridge.dispose();
  });

  it("fails closed on malformed or absent replies and settles a query on disposal", async () => {
    const malformedBus = fakeBus();
    const malformedBridge = createPlanBridge(malformedBus, 1);
    malformedBus.on(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL, request => {
      const requestId = (request as { requestId: string }).requestId;
      malformedBus.emit(`${PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL}:reply:${requestId}`, {
        version: PLAN_MODE_BRIDGE_VERSION,
        requestId,
        result: { ...yoloPlan, strategy: "PREWALK" },
      });
    });
    await expect(malformedBridge.queryApprovedPlan()).resolves.toBeUndefined();
    malformedBridge.dispose();

    const disposedBus = fakeBus();
    const disposedBridge = createPlanBridge(disposedBus, 1000);
    const pending = disposedBridge.queryApprovedPlan();
    disposedBridge.dispose();
    await expect(pending).resolves.toBeUndefined();
    await expect(disposedBridge.queryApprovedPlan()).resolves.toBeUndefined();
  });
});
