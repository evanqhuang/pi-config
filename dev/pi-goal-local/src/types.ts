export type GoalStatus = "active" | "paused" | "completed" | "blocked" | "failed" | "stopped";

export interface GoalStateV1 {
  schemaVersion: 1;
  id: string;
  generation: number;
  status: GoalStatus;
  objective: string;
  criteria: string[];
  createdAt: number;
  updatedAt: number;
  iteration: number;
  consecutiveJudgeFailures: number;
  verificationFailures: number;
  noProgressCycles: number;
  lastReason?: string;
  terminalReason?: string;
  evidence?: string[];
  lastEvidenceFingerprint?: string;
}

/** Lifecycle phases persisted by an opt-in fixed-point goal loop. */
export type GoalLoopPhase =
  | "implementing"
  | "verifying"
  | "replanning"
  | "paused"
  | "blocked"
  | "completed"
  | "stopped";

/** The durable source used to establish an immutable loop plan snapshot. */
export type GoalPlanSourceKind = "explicit" | "approved" | "objective";

/** Execution strategy selected by the plan-mode integration, when available. */
export type GoalLoopStrategy = "YOLO" | "ORCHESTRATOR" | "PREWALK";

export type GoalVerifierOutcome = "pass" | "replan" | "blocked" | "inconclusive";

export interface GoalPlanProvenance {
  sourceKind: GoalPlanSourceKind;
  sourcePath?: string;
  snapshotPath?: string;
  snapshotHash?: string;
}

export interface GoalVerifierState {
  outcome?: GoalVerifierOutcome;
  repositoryFingerprint?: string;
  evidenceFingerprint?: string;
  correctionPath?: string;
  correctionHash?: string;
}

export interface GoalEpochMarker {
  id: string;
  hash: string;
}

export interface GoalReasonMetadata {
  pause?: string;
  block?: string;
  stagnation?: string;
}

/**
 * Version-2 loop state. Unlike GoalStateV1 this records the loop identity and
 * context epochs needed by later lifecycle/context integration. The nested
 * provenance records are deliberately immutable descriptions, not live plan
 * contents.
 */
export interface GoalStateV2 {
  schemaVersion: 2;
  loopId: string;
  generation: number;
  contextEpoch: number;
  phase: GoalLoopPhase;
  cycle: number;
  maxCycles: number;
  objective: string;
  criteria: string[];
  plan: GoalPlanProvenance;
  strategy?: GoalLoopStrategy;
  verifier?: GoalVerifierState;
  epochMarker?: GoalEpochMarker;
  reasons?: GoalReasonMetadata;
  createdAt?: number;
  updatedAt?: number;
}

export type GoalLoopStateV2 = GoalStateV2;
export type GoalStateMarker = GoalStateV1 | GoalStateV2;

export interface GoalVerdict {
  ok: boolean;
  reason: string;
  impossible?: boolean;
  blocked?: boolean;
  evidence?: string[];
  nextAction?: string;
}

export interface GoalVerifierVerdict {
  ok: boolean;
  reason: string;
  evidence?: string[];
}

export interface GoalBudget {
  maxIterations: number;
  maxConsecutiveJudgeFailures: number;
  maxVerificationFailures: number;
  maxNoProgressCycles: number;
  contextPausePercent: number;
}

export const DEFAULT_GOAL_BUDGET: Readonly<GoalBudget> = Object.freeze({
  maxIterations: 30,
  maxConsecutiveJudgeFailures: 3,
  maxVerificationFailures: 2,
  maxNoProgressCycles: 3,
  contextPausePercent: 0.90,
});

export const GOAL_STATE_TYPE = "pi-goal-state-v1";
export const GOAL_STATE_V2_TYPE = "pi-goal-state-v2";
export const GOAL_LOOP_STATE_TYPE = GOAL_STATE_V2_TYPE;
export const GOAL_START_MESSAGE = "pi-goal-start-v1";
export const GOAL_CONTINUE_MESSAGE = "pi-goal-continue-v1";
export const GOAL_SUBAGENT_UPDATE_MESSAGE = "pi-goal-subagent-update-v1";
export const GOAL_STATUS_MESSAGE = "pi-goal-status-v1";
/** Hidden, versioned custom message used as the durable context-epoch cutoff. */
export const GOAL_CONTEXT_EPOCH_TYPE = "pi-goal-context-epoch-v1";
export const GOAL_CONTEXT_EPOCH_MESSAGE = GOAL_CONTEXT_EPOCH_TYPE;
