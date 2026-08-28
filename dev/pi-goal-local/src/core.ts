import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const GOAL_STATE_TYPE = "pi-goal-state";
export const MAX_GOAL_CONDITION_LENGTH = 4_000;
export const MAX_GOAL_ITERATIONS = 8;
export const MAX_GOAL_ELAPSED_MS = 60 * 60 * 1_000;
export const GOAL_JUDGE_TIMEOUT_MS = 2 * 60 * 1_000;

export type GoalStatus = "active" | "paused" | "completed" | "failed" | "cleared";

export interface GoalState {
  id: string;
  generation: number;
  condition: string;
  status: GoalStatus;
  iterations: number;
  startedAt: number;
  updatedAt: number;
  lastReason?: string;
}

export interface GoalVerdict {
  ok: boolean;
  reason: string;
  impossible?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active"
    || value === "paused"
    || value === "completed"
    || value === "failed"
    || value === "cleared";
}

export function parseGoalVerdict(raw: string | undefined): GoalVerdict | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;

  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!isRecord(value) || typeof value.ok !== "boolean" || typeof value.reason !== "string") {
      return undefined;
    }
    const reason = value.reason.trim().slice(0, 1_000);
    if (!reason) return undefined;
    return {
      ok: value.ok,
      reason,
      impossible: value.impossible === true,
    };
  } catch {
    return undefined;
  }
}

export function parseGoalState(value: unknown): GoalState | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.id !== "string"
    || !value.id
    || typeof value.condition !== "string"
    || !value.condition
    || value.condition.length > MAX_GOAL_CONDITION_LENGTH
    || typeof value.generation !== "number"
    || !Number.isInteger(value.generation)
    || value.generation < 1
    || typeof value.iterations !== "number"
    || !Number.isInteger(value.iterations)
    || value.iterations < 0
    || typeof value.startedAt !== "number"
    || !Number.isFinite(value.startedAt)
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
    || !isGoalStatus(value.status)
  ) {
    return undefined;
  }

  return {
    id: value.id,
    generation: value.generation,
    condition: value.condition,
    status: value.status,
    iterations: value.iterations,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    lastReason: typeof value.lastReason === "string" ? value.lastReason.slice(0, 1_000) : undefined,
  };
}

export function latestGoalState(entries: readonly SessionEntry[]): GoalState | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE_TYPE) continue;
    const state = parseGoalState(entry.data);
    if (state) return state;
  }
  return undefined;
}

export function goalBudgetExhausted(state: GoalState, now = Date.now()): boolean {
  return state.iterations >= MAX_GOAL_ITERATIONS
    || now - state.startedAt >= MAX_GOAL_ELAPSED_MS;
}

function entryEvidence(entry: SessionEntry): unknown {
  switch (entry.type) {
    case "message":
      return { type: entry.type, message: entry.message };
    case "custom_message":
      return { type: entry.type, customType: entry.customType, content: entry.content };
    case "compaction":
      return { type: entry.type, summary: entry.summary };
    case "branch_summary":
      return { type: entry.type, summary: entry.summary };
    default:
      return undefined;
  }
}

export function buildGoalEvidence(entries: readonly SessionEntry[]): string {
  return entries
    .map(entryEvidence)
    .filter(value => value !== undefined)
    .map(value => {
      try {
        return JSON.stringify(value).slice(0, 12_000);
      } catch {
        return "";
      }
    })
    .filter(Boolean)
    .join("\n")
    .slice(-80_000);
}
