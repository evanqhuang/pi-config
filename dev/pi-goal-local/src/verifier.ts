import type { GoalVerifierVerdict } from "./types.js";

export function parseVerifierVerdict(raw: string): GoalVerifierVerdict | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (!value || typeof value.ok !== "boolean" || typeof value.reason !== "string" || !value.reason.trim()) return undefined;
    return {
      ok: value.ok,
      reason: value.reason.trim().slice(0, 4000),
      evidence: Array.isArray(value.evidence)
        ? value.evidence.filter((v): v is string => typeof v === "string").slice(0, 32)
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function buildVerifierPrompt(input: {
  objective: string;
  criteria: string[];
  judgeReason: string;
  judgeEvidence?: string[];
}): string {
  return [
    "Independently verify whether the resulting repository state satisfies this goal. This is acceptance verification, not code review.",
    `Objective: ${input.objective}`,
    `Acceptance criteria: ${input.criteria.length ? input.criteria.join(" | ") : "No explicit criteria; verify the objective literally."}`,
    `Judge candidate-completion reason: ${input.judgeReason}`,
    input.judgeEvidence?.length ? `Judge evidence hints (do not trust without checking): ${input.judgeEvidence.join(" | ")}` : "",
    "Inspect the actual repository state and run focused checks where useful. Do not edit source, delegate, start Pi, or invoke code_review.",
    "Return exactly JSON: {\"ok\":boolean,\"reason\":string,\"evidence\"?:string[]}.",
  ].filter(Boolean).join("\n\n");
}
