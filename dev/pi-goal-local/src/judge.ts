import type { GoalVerdict } from "./types.js";

function objectFromOutput(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function parseGoalVerdict(raw: string): GoalVerdict | undefined {
  const value = objectFromOutput(raw);
  if (!value || typeof value.ok !== "boolean" || typeof value.reason !== "string" || !value.reason.trim()) return undefined;
  const evidence = Array.isArray(value.evidence)
    ? value.evidence.filter((v): v is string => typeof v === "string").slice(0, 24)
    : undefined;
  return {
    ok: value.ok,
    reason: value.reason.trim().slice(0, 4000),
    impossible: value.impossible === true,
    blocked: value.blocked === true,
    evidence,
    nextAction: typeof value.nextAction === "string" ? value.nextAction.trim().slice(0, 2000) : undefined,
  };
}

export function buildJudgePrompt(input: {
  objective: string;
  criteria: string[];
  evidence: string;
  previousReason?: string;
  iteration: number;
  capabilities: string;
}): string {
  return [
    "Evaluate whether the active goal is actually complete from the bounded evidence below.",
    `Objective: ${input.objective}`,
    `Acceptance criteria: ${input.criteria.length ? input.criteria.join(" | ") : "No explicit criteria; use the objective literally."}`,
    `Iteration: ${input.iteration}`,
    `Current execution capabilities: ${input.capabilities}`,
    input.previousReason ? `Previous judge reason: ${input.previousReason}` : "",
    "Evidence:",
    input.evidence,
    "Return exactly the required compact JSON verdict.",
  ].filter(Boolean).join("\n\n");
}
