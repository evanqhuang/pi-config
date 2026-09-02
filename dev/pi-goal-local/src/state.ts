import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  GOAL_STATE_TYPE,
  GOAL_STATE_V2_TYPE,
  type GoalEpochMarker,
  type GoalLoopPhase,
  type GoalLoopStrategy,
  type GoalPlanProvenance,
  type GoalPlanSourceKind,
  type GoalReasonMetadata,
  type GoalReanchorProof,
  type GoalStateMarker,
  type GoalStateV1,
  type GoalStateV2,
  type GoalStatus,
  type GoalVerifierOutcome,
  type GoalVerifierState,
} from "./types.js";

export const CLEARED_REASON = "__pi_goal_cleared__";

const MAX_ID_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
const MAX_REASON_LENGTH = 4000;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_CRITERIA = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "paused" || value === "completed"
    || value === "blocked" || value === "failed" || value === "stopped";
}

function isLoopPhase(value: unknown): value is GoalLoopPhase {
  return value === "implementing" || value === "verifying" || value === "replanning"
    || value === "paused" || value === "blocked" || value === "completed" || value === "stopped";
}

function isStrategy(value: unknown): value is GoalLoopStrategy {
  return value === "YOLO" || value === "ORCHESTRATOR" || value === "PREWALK";
}

function isPlanSourceKind(value: unknown): value is GoalPlanSourceKind {
  return value === "explicit" || value === "approved" || value === "objective";
}

function isVerifierOutcome(value: unknown): value is GoalVerifierOutcome {
  return value === "pass" || value === "replan" || value === "blocked" || value === "inconclusive";
}

function boundedString(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  if (!result || result.length > limit || /[\u0000\r\n]/u.test(result)) return undefined;
  return result;
}

function optionalString(record: Record<string, unknown>, key: string, limit: number): string | undefined {
  if (record[key] === undefined) return undefined;
  return boundedString(record[key], limit);
}

function stringArray(value: unknown, limit = MAX_CRITERIA): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit || value.some(v => typeof v !== "string")) return undefined;
  return value.map(v => v.trim()).filter(Boolean);
}

function strictStringArray(value: unknown, limit = MAX_CRITERIA): string[] | undefined {
  if (!Array.isArray(value) || value.length > limit) return undefined;
  const result: string[] = [];
  for (const item of value) {
    const parsed = boundedString(item, MAX_REASON_LENGTH);
    if (!parsed) return undefined;
    result.push(parsed);
  }
  return result;
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every(key => allowed.has(key));
}

function integerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sha256(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/iu.test(value)) return undefined;
  return value;
}

/** Validate and normalize a legacy v1 state marker. */
export function parseGoalStateV1(value: unknown): GoalStateV1 | undefined {
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

function parsePlanProvenance(value: unknown): GoalPlanProvenance | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["sourceKind", "sourcePath", "snapshotPath", "snapshotHash"])) return undefined;
  if (!isPlanSourceKind(value.sourceKind)) return undefined;

  const sourcePath = optionalString(value, "sourcePath", MAX_PATH_LENGTH);
  const snapshotPath = optionalString(value, "snapshotPath", MAX_PATH_LENGTH);
  const snapshotHash = value.snapshotHash === undefined ? undefined : sha256(value.snapshotHash);
  if ((value.sourcePath !== undefined && !sourcePath)
    || (value.snapshotPath !== undefined && !snapshotPath)
    || (value.snapshotHash !== undefined && !snapshotHash)) return undefined;

  if (value.sourceKind === "objective") {
    if (sourcePath !== undefined || snapshotPath !== undefined || snapshotHash !== undefined) return undefined;
    return { sourceKind: "objective" };
  }
  if (!sourcePath || !snapshotPath || !snapshotHash) return undefined;
  return { sourceKind: value.sourceKind, sourcePath, snapshotPath, snapshotHash };
}

function parseVerifierState(value: unknown): GoalVerifierState | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["outcome", "repositoryFingerprint", "evidenceFingerprint", "correctionPath", "correctionHash"])) return undefined;
  if (!isVerifierOutcome(value.outcome)) return undefined;

  const repositoryFingerprint = optionalString(value, "repositoryFingerprint", MAX_FINGERPRINT_LENGTH);
  const evidenceFingerprint = optionalString(value, "evidenceFingerprint", MAX_FINGERPRINT_LENGTH);
  const correctionPath = optionalString(value, "correctionPath", MAX_PATH_LENGTH);
  const correctionHash = value.correctionHash === undefined ? undefined : sha256(value.correctionHash);
  if ((value.repositoryFingerprint !== undefined && !repositoryFingerprint)
    || (value.evidenceFingerprint !== undefined && !evidenceFingerprint)
    || (value.correctionPath !== undefined && !correctionPath)
    || (value.correctionHash !== undefined && !correctionHash)) return undefined;
  if ((correctionPath === undefined) !== (correctionHash === undefined)) return undefined;
  if (value.outcome === "replan" && (correctionPath === undefined || correctionHash === undefined)) return undefined;

  const result: GoalVerifierState = { outcome: value.outcome };
  if (repositoryFingerprint !== undefined) result.repositoryFingerprint = repositoryFingerprint;
  if (evidenceFingerprint !== undefined) result.evidenceFingerprint = evidenceFingerprint;
  if (correctionPath !== undefined) result.correctionPath = correctionPath;
  if (correctionHash !== undefined) result.correctionHash = correctionHash;
  return result;
}

function parseEpochMarker(value: unknown): GoalEpochMarker | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "hash"])) return undefined;
  const id = boundedString(value.id, MAX_ID_LENGTH);
  const hash = sha256(value.hash);
  return id && hash ? { id, hash } : undefined;
}

function parseReasons(value: unknown): GoalReasonMetadata | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pause", "block", "stagnation"])) return undefined;
  const pause = optionalString(value, "pause", MAX_REASON_LENGTH);
  const block = optionalString(value, "block", MAX_REASON_LENGTH);
  const stagnation = optionalString(value, "stagnation", MAX_REASON_LENGTH);
  if ((value.pause !== undefined && !pause)
    || (value.block !== undefined && !block)
    || (value.stagnation !== undefined && !stagnation)) return undefined;
  if (pause === undefined && block === undefined && stagnation === undefined) return undefined;
  const result: GoalReasonMetadata = {};
  if (pause !== undefined) result.pause = pause;
  if (block !== undefined) result.block = block;
  if (stagnation !== undefined) result.stagnation = stagnation;
  return result;
}

function parseReanchorProof(value: unknown): GoalReanchorProof | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "kind", "sessionId", "targetLeafId", "loopId", "generation", "contextEpoch", "cycle", "planSnapshotHash",
  ])) return undefined;
  if (value.kind !== "tree-selection") return undefined;

  const sessionId = boundedString(value.sessionId, MAX_ID_LENGTH);
  const targetLeafId = boundedString(value.targetLeafId, MAX_ID_LENGTH);
  const loopId = boundedString(value.loopId, MAX_ID_LENGTH);
  const planSnapshotHash = sha256(value.planSnapshotHash);
  if (!sessionId || !targetLeafId || !loopId || !planSnapshotHash
    || !integerAtLeast(value.generation, 1)
    || !integerAtLeast(value.contextEpoch, 0)
    || !integerAtLeast(value.cycle, 0)) return undefined;

  return {
    kind: "tree-selection",
    sessionId,
    targetLeafId,
    loopId,
    generation: value.generation,
    contextEpoch: value.contextEpoch,
    cycle: value.cycle,
    planSnapshotHash,
  };
}

/** Strictly validate and normalize a version-2 loop state marker. */
export function parseGoalStateV2(value: unknown): GoalStateV2 | undefined {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
  if (!hasOnlyKeys(value, [
    "schemaVersion", "loopId", "generation", "contextEpoch", "phase", "cycle", "maxCycles",
    "objective", "criteria", "plan", "strategy", "verifier", "epochMarker", "reasons", "reanchor", "createdAt", "updatedAt", "pendingVerificationEntry",
  ])) return undefined;

  const loopId = boundedString(value.loopId, MAX_ID_LENGTH);
  const objective = boundedString(value.objective, MAX_REASON_LENGTH);
  const criteria = strictStringArray(value.criteria);
  const plan = parsePlanProvenance(value.plan);
  if (!loopId || !integerAtLeast(value.generation, 1) || !integerAtLeast(value.contextEpoch, 0)
    || !isLoopPhase(value.phase) || !integerAtLeast(value.cycle, 0) || !integerAtLeast(value.maxCycles, 1)
    || value.cycle > value.maxCycles || !objective || !criteria || !plan) return undefined;

  const strategy = value.strategy === undefined ? undefined : isStrategy(value.strategy) ? value.strategy : undefined;
  if (value.strategy !== undefined && strategy === undefined) return undefined;
  const verifier = value.verifier === undefined ? undefined : parseVerifierState(value.verifier);
  if (value.verifier !== undefined && !verifier) return undefined;
  const epochMarker = value.epochMarker === undefined ? undefined : parseEpochMarker(value.epochMarker);
  if (value.epochMarker !== undefined && !epochMarker) return undefined;
  const reasons = value.reasons === undefined ? undefined : parseReasons(value.reasons);
  if (value.reasons !== undefined && !reasons) return undefined;
  const reanchor = value.reanchor === undefined ? undefined : parseReanchorProof(value.reanchor);
  if (value.reanchor !== undefined && !reanchor) return undefined;
  if (reanchor && (value.phase !== "paused"
    || reanchor.loopId !== loopId
    || reanchor.generation !== value.generation
    || reanchor.contextEpoch !== value.contextEpoch
    || reanchor.cycle !== value.cycle
    || reanchor.planSnapshotHash !== plan.snapshotHash)) return undefined;
  const createdAt = value.createdAt === undefined ? undefined : value.createdAt;
  const updatedAt = value.updatedAt === undefined ? undefined : value.updatedAt;
  const hasPendingVerificationEntry = Object.prototype.hasOwnProperty.call(value, "pendingVerificationEntry");
  if ((createdAt !== undefined && !finiteNumber(createdAt)) || (updatedAt !== undefined && !finiteNumber(updatedAt))
    || (hasPendingVerificationEntry && value.pendingVerificationEntry !== true)) return undefined;

  const result: GoalStateV2 = {
    schemaVersion: 2,
    loopId,
    generation: value.generation,
    contextEpoch: value.contextEpoch,
    phase: value.phase,
    cycle: value.cycle,
    maxCycles: value.maxCycles,
    objective,
    criteria,
    plan,
  };
  if (hasPendingVerificationEntry) result.pendingVerificationEntry = true;
  if (strategy !== undefined) result.strategy = strategy;
  if (verifier !== undefined) result.verifier = verifier;
  if (epochMarker !== undefined) result.epochMarker = epochMarker;
  if (reasons !== undefined) result.reasons = reasons;
  if (reanchor !== undefined) result.reanchor = reanchor;
  if (createdAt !== undefined) result.createdAt = createdAt;
  if (updatedAt !== undefined) result.updatedAt = updatedAt;
  return result;
}

/** Parse either supported state version without weakening v1 validation. */
export function parseGoalState(value: unknown): GoalStateMarker | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion === 1) return parseGoalStateV1(value);
  if (value.schemaVersion === 2) return parseGoalStateV2(value);
  return undefined;
}

function isClearMarker(state: GoalStateMarker): boolean {
  if (state.schemaVersion === 1) return state.status === "stopped" && state.terminalReason === CLEARED_REASON;
  const reason = state.reasons?.block ?? state.reasons?.pause;
  return state.phase === "stopped" && reason === CLEARED_REASON;
}

/**
 * Restore the newest valid marker on the selected branch. Legacy malformed v1
 * records retain their historical skip behavior; malformed v2 records fail
 * closed because falling back to an older loop could re-enable automation.
 */
export function latestGoalStateMarker(entries: readonly SessionEntry[]): GoalStateMarker | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom") continue;
    const isV2Marker = entry.customType === GOAL_STATE_V2_TYPE
      || (entry.customType === GOAL_STATE_TYPE && isRecord(entry.data) && entry.data.schemaVersion === 2);
    if (isV2Marker) {
      const parsed = parseGoalStateV2(entry.data);
      if (!parsed) return undefined;
      return isClearMarker(parsed) ? undefined : parsed;
    }
    if (entry.customType !== GOAL_STATE_TYPE) continue;
    const parsed = parseGoalStateV1(entry.data);
    if (!parsed) continue;
    return isClearMarker(parsed) ? undefined : parsed;
  }
  return undefined;
}

/** Restore the latest loop marker, without exposing a legacy v1 state. */
export function latestGoalLoopState(entries: readonly SessionEntry[]): GoalStateV2 | undefined {
  const state = latestGoalStateMarker(entries);
  return state?.schemaVersion === 2 ? state : undefined;
}

/**
 * Preserve the original v1-facing restoration API. A v2 marker supersedes an
 * older v1 state, so legacy callers cannot accidentally continue the loop.
 */
export function latestGoalState(entries: readonly SessionEntry[]): GoalStateV1 | undefined {
  const state = latestGoalStateMarker(entries);
  return state?.schemaVersion === 1 ? state : undefined;
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
