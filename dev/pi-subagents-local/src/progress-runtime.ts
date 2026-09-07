import {
  defineTool,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import {
  hashToolAction,
  hashToolCompletion,
} from "./tool-loop-guard.js";
import type {
  ProgressCheckpointAttentionEffect,
  ProgressCheckpointController,
  ProgressCheckpointEffect,
  ProgressCheckpointReport,
  ProgressCheckpointRequestReason,
  ProgressCheckpointSnapshot,
} from "./progress-checkpoint.js";

/** The stable marker included in every checkpoint steering message. */
export const PROGRESS_CHECKPOINT_STEERING_MARKER = "[progress-checkpoint]";
/** The worker-only tool name used in checkpoint steering. */
export const PROGRESS_REPORT_TOOL_NAME = "report_progress";

const MAX_TOOL_ACTIONS = 256;
const MAX_SEEN_RESPONSE_IDS = 512;
const MAX_REPORT_FIELD_LENGTH = 1_024;
const MAX_CHECKPOINT_ID_LENGTH = 128;

/** Parameters exposed to the worker's structured progress-report tool. */
export const PROGRESS_REPORT_PARAMETERS = Type.Object({
  checkpointId: Type.String({ minLength: 1, maxLength: MAX_CHECKPOINT_ID_LENGTH }),
  progress: Type.String({ minLength: 1, maxLength: MAX_REPORT_FIELD_LENGTH }),
  evidence: Type.String({ minLength: 1, maxLength: MAX_REPORT_FIELD_LENGTH }),
  blocker: Type.String({ maxLength: MAX_REPORT_FIELD_LENGTH }),
  nextAction: Type.String({ minLength: 1, maxLength: MAX_REPORT_FIELD_LENGTH }),
  scopeExpansion: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_FIELD_LENGTH })),
}, { additionalProperties: false });

export type ProgressReportToolParameters = Static<typeof PROGRESS_REPORT_PARAMETERS>;

export interface ProgressReportToolDetails {
  readonly accepted: boolean;
  readonly checkpointId: string;
}

// SDK customTools arrays use the broad ToolDefinition alias. Keep the
// standalone definition assignable to those arrays; the exported schema and
// ProgressReportToolParameters retain the precise worker-facing shape.
export type ProgressReportToolDefinition = ToolDefinition<any, any>;

export type ProgressRuntimeSteer = (message: string) => void | Promise<void>;
export type ProgressRuntimeAttention = (
  effect: ProgressCheckpointAttentionEffect,
) => void | Promise<void>;

export interface ProgressRuntimeOptions {
  readonly controller: ProgressCheckpointController;
  /** Queues a message with the session; this adapter never calls a model. */
  readonly steer: ProgressRuntimeSteer;
  /** Receives a bounded, incomplete handoff request. It must not abort the worker. */
  readonly onAttention: ProgressRuntimeAttention;
}

export type ProgressRuntimeEvent = AgentSessionEvent;

export interface ProgressRuntime {
  readonly controller: ProgressCheckpointController;
  readonly reportTool: ProgressReportToolDefinition;
  /** Alias useful to callers that assemble a customTools array. */
  readonly tool: ProgressReportToolDefinition;
  /** Observe one installed-SDK session event. Effects are only delivered at turn_end. */
  observe(event: ProgressRuntimeEvent): readonly ProgressCheckpointEffect[];
  /** Alias for event-bus integrations. */
  onEvent(event: ProgressRuntimeEvent): readonly ProgressCheckpointEffect[];
  /** Explicit parent reentry; this does not automatically steer or resume the session. */
  continueFromParent(): readonly ProgressCheckpointEffect[];
  /** Queue a manual checkpoint without steering an in-flight or completed turn. */
  requestCheckpoint(reason?: ProgressCheckpointRequestReason): readonly ProgressCheckpointEffect[];
  snapshot(): ProgressCheckpointSnapshot;
  cancel(): void;
  settle(): void;
}

interface PendingToolAction {
  readonly toolName: string;
  readonly actionFingerprint: string;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isAssistantMessage(message: unknown): message is {
  readonly role: "assistant";
  readonly stopReason?: string;
  readonly usage?: {
    readonly input?: number;
    readonly output?: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  readonly responseId?: string;
} {
  return typeof message === "object" && message !== null
    && (message as { role?: unknown }).role === "assistant";
}

function checkpointSteering(checkpointId: string): string {
  return [
    PROGRESS_CHECKPOINT_STEERING_MARKER,
    `Checkpoint ID: ${JSON.stringify(checkpointId)}`,
    `Continue the assigned work. Before continuing past this checkpoint, call the exact worker-only tool "${PROGRESS_REPORT_TOOL_NAME}" with checkpointId set to ${JSON.stringify(checkpointId)}.`,
    "Give concrete new evidence from work actually completed; put an empty string in blocker when there is no blocker.",
    "This is an incomplete handoff request, not an abort. Do not stop or ask the parent to resume you until the structured report is submitted.",
  ].join("\n");
}

/**
 * Adapt installed pi-coding-agent lifecycle events to the pure checkpoint
 * controller. The adapter deliberately has no AgentSession dependency: the
 * caller supplies the steering operation so manager/runner wiring can happen
 * independently.
 */
export function createProgressRuntime(
  options: ProgressRuntimeOptions,
): ProgressRuntime;
export function createProgressRuntime(
  controller: ProgressCheckpointController,
  steer: ProgressRuntimeSteer,
  onAttention: ProgressRuntimeAttention,
): ProgressRuntime;
export function createProgressRuntime(
  first: ProgressRuntimeOptions | ProgressCheckpointController,
  second?: ProgressRuntimeSteer,
  third?: ProgressRuntimeAttention,
): ProgressRuntime {
  const options: ProgressRuntimeOptions = "controller" in first
    ? first
    : {
        controller: first,
        steer: second ?? (() => {}),
        onAttention: third ?? (() => {}),
      };
  const { controller, steer, onAttention } = options;
  const initialSnapshot = controller.snapshot();
  let displayTokens = initialSnapshot.displayTokens;
  // Seed elapsed time from a restored controller snapshot so a resumed adapter
  // does not restart its lifetime clock at zero.
  const startedAt = Date.now() - initialSnapshot.elapsedMs;
  const inFlightTools = new Set<string>();
  const pendingActions = new Map<string, PendingToolAction>();
  const seenMessages = new WeakSet<object>();
  const seenResponseIds = new Set<string>();
  const steeredCheckpoints = new Set<string>();

  const metrics = () => ({
    displayTokens,
    elapsedMs: elapsedSince(startedAt),
  });

  const safelyNotifyAttention = (effect: ProgressCheckpointAttentionEffect): void => {
    try {
      void Promise.resolve(onAttention(effect)).catch(() => {});
    } catch {
      // Attention notification is best effort and must never abort a worker turn.
    }
  };

  const safelySteer = (checkpointId: string): void => {
    if (controller.lifecycle !== "alive" || steeredCheckpoints.has(checkpointId)) return;
    steeredCheckpoints.add(checkpointId);
    if (steeredCheckpoints.size > MAX_SEEN_RESPONSE_IDS) {
      const oldest = steeredCheckpoints.values().next();
      if (!oldest.done) steeredCheckpoints.delete(oldest.value);
    }
    try {
      void Promise.resolve(steer(checkpointSteering(checkpointId))).catch(() => {});
    } catch {
      // The runtime has no safe recovery action if a host rejects steering.
    }
  };

  const deliver = (
    effects: readonly ProgressCheckpointEffect[],
    allowSteering: boolean,
  ): readonly ProgressCheckpointEffect[] => {
    for (const effect of effects) {
      if (effect.type === "parent-attention-request") {
        safelyNotifyAttention(effect);
      } else if (allowSteering && effect.type === "checkpoint-request") {
        safelySteer(effect.checkpointId);
      }
    }
    return effects;
  };

  const observeController = (observation: Parameters<ProgressCheckpointController["observe"]>[0]) =>
    controller.observe(observation);

  const observeAssistantUsage = (message: object): readonly ProgressCheckpointEffect[] => {
    if (seenMessages.has(message)) return Object.freeze([]);
    seenMessages.add(message);
    const assistant = message as {
      readonly usage?: {
        readonly input?: number;
        readonly output?: number;
        readonly cacheWrite?: number;
        readonly cacheRead?: number;
      };
      readonly responseId?: string;
    };
    if (assistant.responseId) {
      if (seenResponseIds.has(assistant.responseId)) return Object.freeze([]);
      seenResponseIds.add(assistant.responseId);
      if (seenResponseIds.size > MAX_SEEN_RESPONSE_IDS) {
        const oldest = seenResponseIds.values().next();
        if (!oldest.done) seenResponseIds.delete(oldest.value);
      }
    }
    // cacheRead is intentionally not part of display progress. Keep the
    // cumulative total here; compaction and resumed turns never replay it.
    const usage = assistant.usage;
    displayTokens += finiteNonNegative(usage?.input)
      + finiteNonNegative(usage?.output)
      + finiteNonNegative(usage?.cacheWrite);
    // The controller has no separate metrics-only method. Mark usage as
    // bookkeeping so lifetime counters advance without resetting the last
    // completed tool fingerprint between assistant turns.
    return observeController({ ...metrics(), compaction: true, safeBoundary: false });
  };

  const reportTool: ProgressReportToolDefinition = defineTool({
    name: PROGRESS_REPORT_TOOL_NAME,
    label: "Report progress",
    description:
      "Worker-only structured progress checkpoint report. Submit the exact checkpoint ID, concrete new evidence, an empty blocker when unblocked, and the next action.",
    promptSnippet: "Submit a bounded structured progress report at a checkpoint.",
    parameters: PROGRESS_REPORT_PARAMETERS,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const before = controller.snapshot();
      const accepted = before.pendingCheckpoint?.checkpointId === params.checkpointId;
      const effects = controller.report(params as ProgressCheckpointReport, { safeBoundary: false });
      deliver(effects, false);
      return {
        content: [{
          type: "text" as const,
          text: accepted
            ? `Progress report accepted for checkpoint ${params.checkpointId}.`
            : `No pending checkpoint matched ${params.checkpointId}; no report was applied.`,
        }],
        details: { accepted, checkpointId: params.checkpointId },
      };
    },
  });

  const observe = (event: ProgressRuntimeEvent): readonly ProgressCheckpointEffect[] => {
    switch (event.type) {
      case "agent_start":
        return controller.lifecycle === "queued"
          ? deliver(observeController({ ...metrics(), lifecycle: "alive", safeBoundary: false }), false)
          : Object.freeze([]);
      case "turn_start":
        return Object.freeze([]);
      case "message_end":
        return isAssistantMessage(event.message)
          ? deliver(observeAssistantUsage(event.message), false)
          : Object.freeze([]);
      case "tool_execution_start": {
        inFlightTools.add(event.toolCallId);
        const actionFingerprint = hashToolAction(event.toolName, event.args);
        pendingActions.set(event.toolCallId, { toolName: event.toolName, actionFingerprint });
        while (pendingActions.size > MAX_TOOL_ACTIONS) {
          const oldest = pendingActions.keys().next();
          if (!oldest.done) pendingActions.delete(oldest.value);
        }
        // The action and completion hashes describe one completed tool. Keep
        // the start boundary fingerprint-free; otherwise each start would
        // separate identical completion fingerprints and defeat the controller
        // repetition threshold. The preceding turn/usage event already made
        // the controller unsafe for steering.
        return Object.freeze([]);
      }
      case "tool_execution_end": {
        inFlightTools.delete(event.toolCallId);
        const action = pendingActions.get(event.toolCallId);
        pendingActions.delete(event.toolCallId);
        return deliver(observeController({
          ...metrics(),
          ...(action ? {
            actionFingerprint: action.actionFingerprint,
          } : {}),
          resultFingerprint: hashToolCompletion(event.result, event.isError),
          safeBoundary: false,
        }), false);
      }
      case "compaction_start":
        return Object.freeze([]);
      case "compaction_end":
        return deliver(observeController({ ...metrics(), compaction: true, safeBoundary: false }), false);
      case "turn_end": {
        // A malformed host event must not turn a still-running tool into a
        // steerable boundary. The normal SDK sequence emits all tool ends first.
        const safe = inFlightTools.size === 0;
        // onSafeBoundary drains without presenting an empty fingerprint
        // observation, which would otherwise reset repeated-tool bookkeeping.
        const effects = safe ? controller.onSafeBoundary() : Object.freeze([]);
        return deliver(effects, safe && isAssistantMessage(event.message) && event.message.stopReason === "toolUse");
      }
      case "agent_end":
      case "agent_settled":
        // Completion is never a prompt/resume point. In particular, do not call
        // settle here: a parent may explicitly continue a still-live controller.
        return Object.freeze([]);
      default:
        return Object.freeze([]);
    }
  };

  const continueFromParent = (): readonly ProgressCheckpointEffect[] => {
    const effects = controller.continueFromParent();
    return deliver(effects, false);
  };

  const requestCheckpoint = (
    reason: ProgressCheckpointRequestReason = "manual",
  ): readonly ProgressCheckpointEffect[] => {
    const effects = controller.requestCheckpoint(reason);
    return deliver(effects, false);
  };

  return {
    controller,
    reportTool,
    tool: reportTool,
    observe,
    onEvent: observe,
    continueFromParent,
    requestCheckpoint,
    snapshot: () => controller.snapshot(),
    cancel: () => {
      inFlightTools.clear();
      pendingActions.clear();
      controller.cancel();
    },
    settle: () => {
      inFlightTools.clear();
      pendingActions.clear();
      controller.settle();
    },
  };
}

/** Naming aliases for callers that refer to this as an adapter/factory. */
export const createProgressRuntimeAdapter = createProgressRuntime;
export const createProgressCheckpointRuntime = createProgressRuntime;
