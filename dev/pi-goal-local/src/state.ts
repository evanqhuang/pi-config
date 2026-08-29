import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { GOAL_STATE_TYPE, type GoalStateV1, type GoalStatus } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "completed"
    || value === "blocked" || value === "failed" || value === "stopped";
}

function stringArray(value: unknown, limit = 32): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== "string")) return undefined;
  return value.map(v => v.trim()).filter(Boolean);
}

export function parseGoalState(value: unknown): GoalStateV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (!Number.isInteger(value.generation) || (value.generation as number) < 1) return undefined;
  if (!isStatus(value.status)) return undefined;
  if (typeof value.objective !== "string" || !value.objective.trim()) return undefined;
  const criteria = stringArray(value.criteria);
  if (!criteria) return undefined;
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return undefined;
  }
  for (const key of ["iteration", "consecutiveJudgeFailures", "verificationFailures", "noProgressCycles"] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0) return undefined;
  }
  const evidence = value.evidence === undefined ? undefined : stringArray(value.evidence, 64);
  if (value.evidence !== undefined && !evidence) return undefined;
  return {
    schemaVersion: 1,
    id: value.id,
    generation: value.generation as number,
    status: value.status,
    objective: value.objective.trim(),
    criteria,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
    iteration: value.iteration as number,
    consecutiveJudgeFailures: value.consecutiveJudgeFailures as number,
    verificationFailures: value.verificationFailures as number,
    noProgressCycles: value.noProgressCycles as number,
    lastReason: typeof value.lastReason === "string" ? value.lastReason.slice(0, 4000) : undefined,
    terminalReason: typeof value.terminalReason === "string" ? value.terminalReason.slice(0, 4000) : undefined,
    evidence,
    lastEvidenceFingerprint: typeof value.lastEvidenceFingerprint === "string" ? value.lastEvidenceFingerprint.slice(0, 256) : undefined,
  };
}

export function latestGoalState(entries: readonly SessionEntry[]): GoalStateV1 | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE_TYPE) continue;
    const parsed = parseGoalState(entry.data);
    if (parsed) return parsed;
  }
  return undefined;
}

export function nextGeneration(previous: GoalStateV1 | undefined): number {
  return (previous?.generation ?? 0) + 1;
}

export function terminalState(state: GoalStateV1, status: Exclude<GoalStatus, "active">, reason: string): GoalStateV1 {
  return {
    ...state,
    status,
    updatedAt: Date.now(),
    terminalReason: reason,
    lastReason: reason,
  };
}
