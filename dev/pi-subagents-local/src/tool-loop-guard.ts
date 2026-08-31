import { createHash } from "node:crypto";

/** The non-terminal explanation returned when a repeated action is blocked. */
export const TOOL_LOOP_GUARD_REASON =
  "This tool action has produced the same result twice. Change approach or summarize your findings.";

export interface ToolLoopAction {
  /** The exact, canonical full tool name supplied by the agent runtime. */
  toolName: string;
  /** Arguments after the runtime has validated them against the tool schema. */
  args: unknown;
}

export interface ToolLoopCompletion {
  /** The complete result before any later runtime processing. */
  result: unknown;
  /** Explicitly distinguishes successful and error completions. */
  isError: boolean;
}

export interface ToolLoopBlock {
  block: true;
  reason: string;
}

export interface ToolLoopGuard {
  /** Check an action against completed calls. No state is reserved by this check. */
  beforeToolCall(action: ToolLoopAction): ToolLoopBlock | undefined;
  /** Record a completed action and its complete result/error signature. */
  afterToolCall(action: ToolLoopAction, completion: ToolLoopCompletion): void;
  /** Number of action signatures currently retained by this session's guard. */
  readonly size: number;
}

/**
 * Canonicalize a JSON-shaped value recursively.
 *
 * Object keys are sorted, while arrays retain their input order. Primitive type
 * tags make values unambiguous even for values outside the JSON subset (which is
 * useful at this boundary for malformed/custom tool implementations). The
 * serializer never truncates its input.
 */
export function canonicalize(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "boolean":
      return value ? "boolean:true" : "boolean:false";
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:Infinity";
      if (value === -Infinity) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${JSON.stringify(value)}`;
    case "bigint":
      return `bigint:${value.toString()}`;
    case "symbol":
      return `symbol:${String(value)}`;
    case "function":
      return `function:${String(value)}`;
    case "object":
      break;
  }

  // Cycles are not JSON values, but custom tool details can still contain one.
  // Keep guard bookkeeping non-throwing rather than changing tool-hook failure
  // behavior when such a value is returned.
  if (seen.has(value)) return "cycle";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `array:[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
    }

    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue).sort();
    return `object:{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(objectValue[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** SHA-256 of the complete canonical input. */
export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** Hash the exact full tool name together with its validated arguments. */
export function hashToolAction(toolName: string, args: unknown): string {
  return hashCanonical({ args, toolName });
}

/** Hash the complete tool result together with its explicit error status. */
export function hashToolCompletion(result: unknown, isError: boolean): string {
  return hashCanonical({ isError, result });
}

interface ActionState {
  /** Counts are retained only until one signature reaches the blocking threshold. */
  completionCounts: Map<string, 1>;
  blocked: boolean;
}

/** Keep a resumed session's loop bookkeeping bounded while retaining recent actions. */
const MAX_RETAINED_ACTIONS = 128;
/** Before the threshold, retain only the minimum recent signatures needed for repeats. */
const MAX_RETAINED_COMPLETION_SIGNATURES = 2;

/**
 * Create the per-session LocalExplore loop guard.
 *
 * Preflight deliberately only reads completed state. Calls that have already
 * passed preflight may execute in parallel; their later completions update this
 * shared guard in completion order.
 */
export function createToolLoopGuard(): ToolLoopGuard {
  const actions = new Map<string, ActionState>();

  const retain = (actionHash: string, state: ActionState): void => {
    // Map insertion order provides deterministic oldest-first eviction. Delete
    // first so a completed action becomes recent when its state is refreshed.
    actions.delete(actionHash);
    actions.set(actionHash, state);
    if (actions.size > MAX_RETAINED_ACTIONS) {
      const oldest = actions.keys().next();
      if (!oldest.done) actions.delete(oldest.value);
    }
  };

  return {
    beforeToolCall(action): ToolLoopBlock | undefined {
      const actionHash = hashToolAction(action.toolName, action.args);
      const state = actions.get(actionHash);
      if (state?.blocked) {
        return { block: true, reason: TOOL_LOOP_GUARD_REASON };
      }
      return undefined;
    },

    afterToolCall(action, completion): void {
      const actionHash = hashToolAction(action.toolName, action.args);
      const completionHash = hashToolCompletion(completion.result, completion.isError);
      const prior = actions.get(actionHash);
      if (prior?.blocked) {
        // A later completion must not overwrite a signature that already hit
        // the threshold, even when parallel calls finish out of order.
        retain(actionHash, prior);
        return;
      }

      const completionCounts = new Map(prior?.completionCounts);
      if (completionCounts.has(completionHash)) {
        retain(actionHash, { completionCounts: new Map(), blocked: true });
        return;
      }

      completionCounts.set(completionHash, 1);
      while (completionCounts.size > MAX_RETAINED_COMPLETION_SIGNATURES) {
        const oldest = completionCounts.keys().next();
        if (!oldest.done) completionCounts.delete(oldest.value);
      }
      retain(actionHash, { completionCounts, blocked: false });
    },

    get size(): number {
      return actions.size;
    },
  };
}
