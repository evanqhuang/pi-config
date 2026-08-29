import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiSubagentsServiceV3, type EphemeralAgentResult, type PiSubagentsServiceV3 } from "../../pi-subagents-local/src/service.js";

let service: PiSubagentsServiceV3 | undefined;

export function subagents(): PiSubagentsServiceV3 {
  service ??= getPiSubagentsServiceV3();
  return service;
}

export function hasActiveSubagents(): boolean {
  return subagents().hasActiveAgents();
}

export function runEvaluator(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  type: "GoalJudge" | "GoalVerifier",
  prompt: string,
  signal?: AbortSignal,
): Promise<EphemeralAgentResult> {
  return subagents().runEphemeralAgent({
    pi,
    ctx,
    type,
    prompt,
    description: type === "GoalJudge" ? "Evaluate active goal" : "Verify active goal",
    signal,
  });
}
