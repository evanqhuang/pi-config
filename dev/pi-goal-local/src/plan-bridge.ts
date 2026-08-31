import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { GoalLoopStrategy } from "./types.js";

/** Versioned cross-extension contract shared with pi-plan-mode. */
export const PLAN_MODE_BRIDGE_VERSION = 1 as const;
export const PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL = "pi-plan-mode:approved-plan-query-v1" as const;

export type PlanModeApprovalAction =
  | "yolo-direct"
  | "yolo-compact"
  | "orchestrator-direct"
  | "orchestrator-compact"
  | "prewalk";

/** The only plan data crossing the bridge. Plan contents stay on disk. */
export interface ApprovedPlanBridgeResult {
  sourceKind: "approved";
  sourcePath: string;
  planPath: string;
  action: PlanModeApprovalAction;
  strategy: GoalLoopStrategy;
  /** A correction must preserve this requirement rather than silently using another mode. */
  prewalk?: { required: true };
}

/** Explicit sources intentionally take precedence over an approved bridge plan. */
export interface ExplicitPlanBridgeResult {
  sourceKind: "explicit";
  sourcePath: string;
  planPath: string;
}

export type GoalPlanBridgeResult = ApprovedPlanBridgeResult | ExplicitPlanBridgeResult;

export interface PlanBridge {
  /** Query the latest explicit approval, if plan-mode has one on its active branch. */
  queryApprovedPlan(): Promise<ApprovedPlanBridgeResult | undefined>;
  /** Resolve plan source precedence without inspecting plan-mode private state. */
  resolvePlan(options?: { explicitPlanPath?: string }): Promise<GoalPlanBridgeResult | undefined>;
  /** Settle pending queries as no result and release their reply listeners. */
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isApprovalAction(value: unknown): value is PlanModeApprovalAction {
  return value === "yolo-direct"
    || value === "yolo-compact"
    || value === "orchestrator-direct"
    || value === "orchestrator-compact"
    || value === "prewalk";
}

function strategyForAction(action: PlanModeApprovalAction): GoalLoopStrategy {
  if (action === "prewalk") return "PREWALK";
  return action.startsWith("orchestrator") ? "ORCHESTRATOR" : "YOLO";
}

function isSafeCanonicalPlanPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\u0000")
    && isAbsolute(value);
}

function parsePlan(value: unknown): ApprovedPlanBridgeResult | undefined {
  if (!isRecord(value)
    || !isSafeCanonicalPlanPath(value.planPath)
    || !isApprovalAction(value.action)) return undefined;
  const strategy = strategyForAction(value.action);
  if (value.strategy !== strategy) return undefined;
  if (value.version !== undefined && value.version !== PLAN_MODE_BRIDGE_VERSION) return undefined;
  const keys = Object.keys(value);
  const allowed = new Set(["version", "sourceKind", "sourcePath", "planPath", "action", "strategy", "prewalk"]);
  if (keys.some(key => !allowed.has(key))) return undefined;
  if (value.sourceKind !== undefined && value.sourceKind !== "approved") return undefined;
  if (value.sourcePath !== undefined && value.sourcePath !== value.planPath) return undefined;
  if (value.prewalk !== undefined
    && (!isRecord(value.prewalk) || value.prewalk.required !== true || Object.keys(value.prewalk).some(key => key !== "required"))) return undefined;
  if (value.action === "prewalk" && (!isRecord(value.prewalk) || value.prewalk.required !== true)) return undefined;
  if (value.action !== "prewalk" && value.prewalk !== undefined) return undefined;
  return {
    sourceKind: "approved",
    sourcePath: value.planPath,
    planPath: value.planPath,
    action: value.action,
    strategy,
    ...(value.prewalk === undefined ? {} : { prewalk: { required: true } }),
  };
}

function parseReply(raw: unknown, requestId: string): ApprovedPlanBridgeResult | undefined | null {
  if (!isRecord(raw) || raw.version !== PLAN_MODE_BRIDGE_VERSION || raw.requestId !== requestId) return undefined;
  if (!("result" in raw)) return undefined;
  if (raw.result === null) return null;
  return parsePlan(raw.result);
}

/**
 * Cross-extension plan-mode adapter. It is deliberately filesystem-free: the
 * plan-mode extension is the authority for canonical validation and approval,
 * while goal-local only consumes this versioned result.
 */
export function createPlanBridge(events: EventBus, timeoutMs = 100): PlanBridge {
  let disposed = false;
  const subscriptions = new Set<() => void>();
  const pendingQueries = new Set<() => void>();

  const queryApprovedPlan = (): Promise<ApprovedPlanBridgeResult | undefined> => {
    if (disposed) return Promise.resolve(undefined);
    const requestId = randomUUID();
    const replyChannel = `${PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL}:reply:${requestId}`;
    return new Promise(resolve => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const finish = (result: ApprovedPlanBridgeResult | undefined) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (unsubscribe) {
          try { unsubscribe(); } catch {}
          subscriptions.delete(unsubscribe);
        }
        pendingQueries.delete(cancel);
        resolve(result);
      };
      const cancel = () => finish(undefined);
      pendingQueries.add(cancel);
      try {
        unsubscribe = events.on(replyChannel, raw => {
          const parsed = parseReply(raw, requestId);
          // undefined means an unrelated or malformed reply; null is the
          // explicit no-result response.
          if (parsed === undefined) return;
          finish(parsed ?? undefined);
        });
        if (typeof unsubscribe === "function") subscriptions.add(unsubscribe);
        events.emit(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL, { version: PLAN_MODE_BRIDGE_VERSION, requestId });
      } catch {
        finish(undefined);
      }
      timer = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
    });
  };

  return {
    queryApprovedPlan,
    async resolvePlan(options = {}) {
      const explicit = options.explicitPlanPath?.trim();
      if (explicit) return { sourceKind: "explicit", sourcePath: explicit, planPath: explicit };
      return queryApprovedPlan();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...pendingQueries]) cancel();
      for (const unsubscribe of [...subscriptions]) {
        try { unsubscribe(); } catch {}
      }
      subscriptions.clear();
    },
  };
}
