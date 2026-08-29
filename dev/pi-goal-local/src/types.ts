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
export const GOAL_START_MESSAGE = "pi-goal-start-v1";
export const GOAL_CONTINUE_MESSAGE = "pi-goal-continue-v1";
export const GOAL_SUBAGENT_UPDATE_MESSAGE = "pi-goal-subagent-update-v1";
export const GOAL_STATUS_MESSAGE = "pi-goal-status-v1";
