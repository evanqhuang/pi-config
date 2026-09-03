import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadGoalJudgeSettings, type GoalJudgeThinking } from "./settings.js";

const PI_SUBAGENTS_SERVICE_V3 = Symbol.for("pi-subagents:service:v3");

interface EphemeralAgentResult {
  output: string;
  failure?: string;
  aborted: boolean;
  steered: boolean;
}

export interface EvaluatorProgressCallbacks {
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
}

interface PiSubagentsServiceV3 {
  runEphemeralAgent(options: {
    pi: ExtensionAPI;
    ctx: ExtensionContext;
    type: string;
    prompt: string;
    description?: string;
    signal?: AbortSignal;
    model?: string;
    thinkingLevel?: GoalJudgeThinking;
    onTurnEnd?: (turnCount: number) => void;
    onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  }): Promise<EphemeralAgentResult>;
  hasActiveAgents(): boolean;
}

function maybeSubagents(): PiSubagentsServiceV3 | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[PI_SUBAGENTS_SERVICE_V3] as PiSubagentsServiceV3 | undefined;
}

function subagents(): PiSubagentsServiceV3 {
  const service = maybeSubagents();
  if (!service) throw new Error("pi-subagents-local service v3 is unavailable in this session.");
  return service;
}

export function hasActiveSubagents(): boolean {
  // Do not throw from the controller's pre-evaluation readiness check. If the
  // service is missing, let runEvaluator() produce the explicit failure so the
  // goal controller can apply its normal retry/block budget and fail closed.
  return maybeSubagents()?.hasActiveAgents() ?? false;
}

export function runEvaluator(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: "GoalJudge" | "GoalVerifier",
  prompt: string,
  signal?: AbortSignal,
  progress: EvaluatorProgressCallbacks = {},
): Promise<EphemeralAgentResult> {
  const judge = type === "GoalJudge" ? loadGoalJudgeSettings(ctx.cwd) : undefined;
  return subagents().runEphemeralAgent({
    pi,
    ctx,
    type,
    prompt,
    description: type === "GoalJudge" ? "Evaluate active goal" : "Verify active goal",
    signal,
    model: judge?.model,
    thinkingLevel: judge?.thinking,
    onTurnEnd: progress.onTurnEnd,
    onAssistantUsage: progress.onAssistantUsage,
  });
}
