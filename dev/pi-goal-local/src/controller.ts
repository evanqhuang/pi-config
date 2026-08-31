import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildJudgePrompt, parseGoalVerdict } from "./judge.js";
import { CLEARED_REASON, latestGoalState, nextGeneration, terminalState } from "./state.js";
import { hasActiveSubagents, runEvaluator } from "./subagents.js";
import { buildGoalEvidence, fingerprintEvidence } from "./transcript.js";
import {
  DEFAULT_GOAL_BUDGET,
  GOAL_CONTINUE_MESSAGE,
  GOAL_START_MESSAGE,
  GOAL_STATE_TYPE,
  GOAL_STATUS_MESSAGE,
  GOAL_SUBAGENT_UPDATE_MESSAGE,
  type GoalStateV1,
  type GoalStatus,
} from "./types.js";
import { buildVerifierPrompt, parseVerifierVerdict } from "./verifier.js";

const WAKE_DEBOUNCE_MS = 250;
const WAKE_MAX_RETRY_MS = 2_000;
const WAKE_MAX_RETRIES = 8;

type PendingWake = {
  ctx: ExtensionContext;
  branchIdentity: string;
  epoch: number;
  goalId: string;
  generation: number;
};

function parentReady(ctx: ExtensionContext): boolean {
  const runtime = ctx as ExtensionContext & { isIdle?: () => boolean; hasPendingMessages?: () => boolean };
  return (runtime.isIdle?.() ?? true) && !(runtime.hasPendingMessages?.() ?? false);
}

function contextPercent(ctx: ExtensionContext): number | undefined {
  const runtime = ctx as ExtensionContext & {
    getContextUsage?: () => { percent?: number; contextPercent?: number; tokens?: number; maxTokens?: number } | undefined;
  };
  // SAFETY: pi versions expose equivalent context-usage fields under slightly different structural types.
  const usage = runtime.getContextUsage?.() as unknown as { percent?: number; contextPercent?: number; tokens?: number; maxTokens?: number } | undefined;
  if (!usage) return undefined;
  if (typeof usage.percent === "number") return usage.percent > 1 ? usage.percent / 100 : usage.percent;
  if (typeof usage.contextPercent === "number") return usage.contextPercent > 1 ? usage.contextPercent / 100 : usage.contextPercent;
  if (typeof usage.tokens === "number" && typeof usage.maxTokens === "number" && usage.maxTokens > 0) {
    return usage.tokens / usage.maxTokens;
  }
  return undefined;
}

function entriesSinceGoal(entries: readonly SessionEntry[], goal: GoalStateV1): readonly SessionEntry[] {
  let start = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type !== "custom" || entry.customType !== GOAL_STATE_TYPE) continue;
    const data = entry.data as Partial<GoalStateV1> | undefined;
    if (data?.id === goal.id && data.generation === goal.generation) start = i + 1;
  }
  return entries.slice(start);
}

export class GoalController {
  private ctx: ExtensionContext | undefined;
  private state: GoalStateV1 | undefined;
  private sessionEpoch = 0;
  private evaluationInFlight = false;
  private evaluationQueued = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeRetryDelay = 0;
  private wakeAttempts = 0;
  private pendingWake: PendingWake | undefined;
  private readonly branchEntryTokens = new WeakMap<object, number>();
  private nextBranchEntryToken = 1;
  private evaluatorAbort: AbortController | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  get current(): GoalStateV1 | undefined { return this.state; }

  private branchState(ctx: ExtensionContext): GoalStateV1 | undefined {
    return latestGoalState(ctx.sessionManager.getBranch());
  }

  private branchIdentity(ctx: ExtensionContext): string {
    const entries = ctx.sessionManager.getBranch();
    const latestGoalEntry = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === GOAL_STATE_TYPE);
    if (latestGoalEntry) {
      // Session entries are stable across getBranch() calls. The fallback token keeps
      // lifecycle tests and older adapters branch-aware when ids are unavailable.
      const entry = latestGoalEntry as unknown as object;
      let token = this.branchEntryTokens.get(entry);
      if (!token) {
        token = this.nextBranchEntryToken++;
        this.branchEntryTokens.set(entry, token);
      }
      return `goal-entry:${typeof latestGoalEntry.id === "string" ? latestGoalEntry.id : token}`;
    }

    return `branch:${entries.map(entry => {
      if (typeof entry.id === "string") return entry.id;
      const object = entry as unknown as object;
      let token = this.branchEntryTokens.get(object);
      if (!token) {
        token = this.nextBranchEntryToken++;
        this.branchEntryTokens.set(object, token);
      }
      return token;
    }).join("/")}`;
  }

  private syncBranch(ctx: ExtensionContext): void {
    const identity = this.branchIdentity(ctx);
    if (this.pendingWake && (this.pendingWake.ctx !== ctx || this.pendingWake.branchIdentity !== identity)) {
      this.invalidatePendingWake();
    }
    this.ctx = ctx;
    this.state = this.branchState(ctx);
  }

  private persist(next: GoalStateV1): void {
    this.state = next;
    this.pi.appendEntry(GOAL_STATE_TYPE, next);
  }

  private transition(status: Exclude<GoalStatus, "active">, reason: string): GoalStateV1 | undefined {
    if (!this.state) return undefined;
    const next = terminalState(this.state, status, reason);
    this.persist(next);
    return next;
  }

  private notify(next: GoalStateV1, content: string): void {
    this.pi.sendMessage({
      customType: GOAL_STATUS_MESSAGE,
      content,
      display: true,
      details: { goalId: next.id, generation: next.generation, status: next.status },
    });
  }

  private hidden(customType: string, content: string): void {
    this.pi.sendMessage({
      customType,
      content,
      display: false,
      details: this.state ? { goalId: this.state.id, generation: this.state.generation } : undefined,
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  private capabilities(): string {
    return "Use the main session's currently selected PLAN / ORCHESTRATOR / YOLO mode and available tools. Do not assume unavailable capabilities. Goal evaluation itself cannot mutate through GoalJudge; GoalVerifier is read-only acceptance verification.";
  }

  private invalidatePendingWake(): void {
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.wakeRetryDelay = 0;
    this.wakeAttempts = 0;
    this.pendingWake = undefined;
  }

  private invalidatePendingEvaluation(): void {
    this.sessionEpoch += 1;
    this.evaluatorAbort?.abort();
    this.invalidatePendingWake();
    this.evaluationQueued = false;
  }

  private refreshEvaluationState(ctx: ExtensionContext, epoch: number, current: GoalStateV1): boolean {
    if (epoch !== this.sessionEpoch || this.ctx !== ctx) return false;
    this.state = this.branchState(ctx);
    return this.state?.id === current.id
      && this.state.generation === current.generation
      && this.state.status === "active";
  }

  private armWakeTimer(delay: number): void {
    if (!this.pendingWake || this.wakeTimer !== undefined) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (!this.pendingWake) return;
      this.wakeAttempts += 1;
      this.attemptPendingWake();
      if (!this.pendingWake || this.wakeAttempts >= WAKE_MAX_RETRIES) return;
      this.wakeRetryDelay = Math.min(
        this.wakeRetryDelay > 0 ? this.wakeRetryDelay * 2 : WAKE_DEBOUNCE_MS,
        WAKE_MAX_RETRY_MS,
      );
      this.armWakeTimer(this.wakeRetryDelay);
    }, delay);
  }

  private attemptPendingWake(): boolean {
    const pending = this.pendingWake;
    if (!pending) return false;
    if (pending.epoch !== this.sessionEpoch || this.ctx !== pending.ctx) {
      this.invalidatePendingWake();
      return false;
    }

    const ctx = pending.ctx;
    if (this.branchIdentity(ctx) !== pending.branchIdentity) {
      this.invalidatePendingWake();
      return false;
    }

    // Re-read the selected branch for every attempt. Never use a state captured
    // before navigation or a pause/stop/replacement transition.
    const current = this.branchState(ctx);
    this.state = current;
    if (!current || current.id !== pending.goalId || current.generation !== pending.generation || current.status !== "active") {
      this.invalidatePendingWake();
      return false;
    }
    if (!parentReady(ctx) || hasActiveSubagents()) return false;

    // Clear before sendMessage: triggerTurn can synchronously cause another
    // lifecycle event, and that event must not enqueue a duplicate continuation.
    this.invalidatePendingWake();
    this.hidden(GOAL_CONTINUE_MESSAGE, `Resume autonomous pursuit of the active goal:\n\n${current.objective}`);
    return true;
  }

  private scheduleResume(ctx: ExtensionContext, goal: GoalStateV1, epoch: number): void {
    if (epoch !== this.sessionEpoch || this.ctx !== ctx) return;
    const request: PendingWake = {
      ctx,
      branchIdentity: this.branchIdentity(ctx),
      epoch,
      goalId: goal.id,
      generation: goal.generation,
    };
    if (this.pendingWake
      && this.pendingWake.ctx === request.ctx
      && this.pendingWake.branchIdentity === request.branchIdentity
      && this.pendingWake.epoch === request.epoch
      && this.pendingWake.goalId === request.goalId
      && this.pendingWake.generation === request.generation) return;

    this.invalidatePendingWake();
    this.pendingWake = request;
    this.armWakeTimer(0);
  }

  /**
   * Reattempt a pending tree-selection wake from an agent lifecycle event.
   *
   * A pending wake remains handled even when the current runtime is not ready;
   * callers must not fall through to ordinary goal evaluation in that case.
   */
  retryPendingWake(ctx?: ExtensionContext): boolean {
    if (!this.pendingWake) return false;
    if (ctx && ctx !== this.pendingWake.ctx) {
      this.invalidatePendingWake();
      return false;
    }
    const delivered = this.attemptPendingWake();
    if (this.pendingWake && this.wakeTimer === undefined && this.wakeAttempts < WAKE_MAX_RETRIES) {
      this.armWakeTimer(WAKE_DEBOUNCE_MS);
    }
    return delivered || this.pendingWake !== undefined;
  }

  restore(ctx: ExtensionContext): void {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status !== "active") return;
    this.transition("paused", "Paused when the session was reopened.");
  }

  restoreSelectedBranch(ctx: ExtensionContext): void {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    const goal = this.state;
    if (!goal || goal.status !== "active") return;
    this.scheduleResume(ctx, goal, this.sessionEpoch);
  }

  refresh(ctx: ExtensionContext): GoalStateV1 | undefined {
    this.syncBranch(ctx);
    return this.state;
  }

  prepareForNavigation(): void {
    this.invalidatePendingEvaluation();
  }

  shutdown(): void {
    this.invalidatePendingEvaluation();
    this.evaluatorAbort = undefined;
    this.ctx = undefined;
    this.state = undefined;
  }

  start(ctx: ExtensionContext, objective: string, criteria: string[]): GoalStateV1 {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status === "active") {
      this.evaluatorAbort?.abort();
      this.persist(terminalState(this.state, "stopped", "Replaced by a newer /goal generation."));
    }
    const previous = this.state;
    const now = Date.now();
    const next: GoalStateV1 = {
      schemaVersion: 1,
      id: randomUUID(),
      generation: nextGeneration(previous),
      status: "active",
      objective,
      criteria,
      createdAt: now,
      updatedAt: now,
      iteration: 0,
      consecutiveJudgeFailures: 0,
      verificationFailures: 0,
      noProgressCycles: 0,
    };
    this.persist(next);
    this.hidden(GOAL_START_MESSAGE, [
      "Actively pursue this goal autonomously rather than merely discussing it.",
      `Objective: ${objective}`,
      criteria.length ? `Acceptance criteria: ${criteria.join("; ")}` : "",
      "Continue until the goal controller independently judges and verifies completion, or it pauses/blocks/stops.",
    ].filter(Boolean).join("\n\n"));
    return next;
  }

  pause(ctx: ExtensionContext): GoalStateV1 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status !== "active") return undefined;
    this.evaluatorAbort?.abort();
    return this.transition("paused", "Paused by user.");
  }

  resume(ctx: ExtensionContext): GoalStateV1 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (!this.state || this.state.status !== "paused") return undefined;
    const next: GoalStateV1 = { ...this.state, status: "active", updatedAt: Date.now(), terminalReason: undefined };
    this.persist(next);
    this.hidden(GOAL_CONTINUE_MESSAGE, `Resume autonomous pursuit of the active goal:\n\n${next.objective}`);
    return next;
  }

  stop(ctx: ExtensionContext, reason = "Stopped by user."): GoalStateV1 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (!this.state || this.state.status === "stopped") return undefined;
    this.evaluatorAbort?.abort();
    return this.transition("stopped", reason);
  }

  clear(ctx: ExtensionContext): GoalStateV1 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (!this.state) return undefined;
    this.evaluatorAbort?.abort();
    const cleared = terminalState(this.state, "stopped", CLEARED_REASON);
    this.persist(cleared);
    this.state = undefined;
    return cleared;
  }

  scheduleSubagentWake(): void {
    if (this.pendingWake) {
      this.retryPendingWake();
      return;
    }
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const ctx = this.ctx;
    const epoch = this.sessionEpoch;
    if (!ctx) return;
    const scheduled = this.branchState(ctx);
    if (!scheduled || scheduled.status !== "active") return;
    const branchIdentity = this.branchIdentity(ctx);
    const goalId = scheduled.id;
    const generation = scheduled.generation;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (epoch !== this.sessionEpoch || this.ctx !== ctx) return;
      if (this.branchIdentity(ctx) !== branchIdentity) return;
      const current = this.branchState(ctx);
      this.state = current;
      if (current?.id !== goalId
        || current?.generation !== generation
        || current?.status !== "active"
        || hasActiveSubagents()
        || !parentReady(ctx)) return;
      this.hidden(GOAL_SUBAGENT_UPDATE_MESSAGE, "Background subagent work has settled. Reassess the active goal using the new results.");
    }, WAKE_DEBOUNCE_MS);
  }

  requestEvaluation(ctx: ExtensionContext): void {
    this.syncBranch(ctx);
    if (this.retryPendingWake(ctx)) return;
    if (this.evaluationInFlight) {
      this.evaluationQueued = true;
      return;
    }
    void this.evaluateLoop(ctx);
  }

  private async evaluateLoop(initialCtx: ExtensionContext): Promise<void> {
    this.evaluationInFlight = true;
    try {
      let ctx = initialCtx;
      do {
        this.evaluationQueued = false;
        await this.evaluateOnce(ctx);
        ctx = this.ctx ?? ctx;
      } while (this.evaluationQueued);
    } finally {
      this.evaluationInFlight = false;
    }
  }

  private async evaluatorFailure(ctx: ExtensionContext, epoch: number, current: GoalStateV1, reason: string): Promise<void> {
    if (!this.refreshEvaluationState(ctx, epoch, current) || !this.state) return;
    const failures = this.state.consecutiveJudgeFailures + 1;
    const next: GoalStateV1 = {
      ...this.state,
      consecutiveJudgeFailures: failures,
      lastReason: reason,
      updatedAt: Date.now(),
    };
    this.persist(next);
    if (failures >= DEFAULT_GOAL_BUDGET.maxConsecutiveJudgeFailures) {
      const blocked = this.transition("blocked", `GoalJudge failed ${failures} consecutive times: ${reason}`);
      if (blocked) this.notify(blocked, `Goal blocked: ${blocked.terminalReason}`);
      return;
    }
    this.hidden(
      GOAL_CONTINUE_MESSAGE,
      `Goal evaluation failed transiently (${failures}/${DEFAULT_GOAL_BUDGET.maxConsecutiveJudgeFailures}). Continue pursuing the active goal; evaluation will retry after settlement. Reason: ${reason}`,
    );
  }

  private async evaluateOnce(ctx: ExtensionContext): Promise<void> {
    this.syncBranch(ctx);
    const current = this.state;
    const epoch = this.sessionEpoch;
    if (!current || current.status !== "active") return;
    if (!parentReady(ctx) || hasActiveSubagents()) return;

    if (current.iteration >= DEFAULT_GOAL_BUDGET.maxIterations) {
      const blocked = this.transition("blocked", `Goal iteration budget exhausted (${DEFAULT_GOAL_BUDGET.maxIterations}).`);
      if (blocked) this.notify(blocked, `Goal blocked: ${blocked.terminalReason}`);
      return;
    }

    const used = contextPercent(ctx);
    if (used !== undefined && used >= DEFAULT_GOAL_BUDGET.contextPausePercent) {
      const paused = this.transition("paused", `Context budget reached ${Math.round(used * 100)}%; existing compaction remains authoritative.`);
      if (paused) this.notify(paused, `Goal paused: ${paused.terminalReason}`);
      return;
    }

    const entries = ctx.sessionManager.buildContextEntries();
    const evidenceText = buildGoalEvidence(entriesSinceGoal(entries, current));
    const evidenceFingerprint = fingerprintEvidence(evidenceText);
    this.evaluatorAbort = new AbortController();

    let judgeOutput: string;
    try {
      const judge = await runEvaluator(this.pi, ctx, "GoalJudge", buildJudgePrompt({
        objective: current.objective,
        criteria: current.criteria,
        evidence: evidenceText,
        previousReason: current.lastReason,
        iteration: current.iteration,
        capabilities: this.capabilities(),
      }), this.evaluatorAbort.signal);
      if (judge.failure || judge.aborted) throw new Error(judge.failure ?? "GoalJudge aborted");
      judgeOutput = judge.output;
    } catch (error) {
      await this.evaluatorFailure(ctx, epoch, current, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      this.evaluatorAbort = undefined;
    }

    if (!this.refreshEvaluationState(ctx, epoch, current)) return;
    const verdict = parseGoalVerdict(judgeOutput);
    if (!verdict) {
      await this.evaluatorFailure(ctx, epoch, current, "GoalJudge returned malformed output.");
      return;
    }

    if (verdict.blocked) {
      const blocked = this.transition("blocked", verdict.reason);
      if (blocked) this.notify(blocked, `Goal blocked: ${verdict.reason}`);
      return;
    }
    if (verdict.impossible) {
      const failed = this.transition("failed", verdict.reason);
      if (failed) this.notify(failed, `Goal failed: ${verdict.reason}`);
      return;
    }

    if (verdict.ok) {
      let verifierReason = "";
      let verifierEvidence: string[] | undefined;
      try {
        this.evaluatorAbort = new AbortController();
        const verifier = await runEvaluator(this.pi, ctx, "GoalVerifier", buildVerifierPrompt({
          objective: current.objective,
          criteria: current.criteria,
          judgeReason: verdict.reason,
          judgeEvidence: verdict.evidence,
        }), this.evaluatorAbort.signal);
        if (verifier.failure || verifier.aborted) throw new Error(verifier.failure ?? "GoalVerifier aborted");
        const parsed = parseVerifierVerdict(verifier.output);
        if (!parsed) throw new Error("GoalVerifier returned malformed output.");
        if (!this.refreshEvaluationState(ctx, epoch, current)) return;
        if (parsed.ok) {
          const completed: GoalStateV1 = {
            ...this.state!,
            status: "completed",
            updatedAt: Date.now(),
            lastReason: parsed.reason,
            terminalReason: parsed.reason,
            evidence: parsed.evidence ?? verdict.evidence,
          };
          this.persist(completed);
          this.notify(completed, `Goal completed: ${parsed.reason}`);
          return;
        }
        verifierReason = parsed.reason;
        verifierEvidence = parsed.evidence;
      } catch (error) {
        verifierReason = error instanceof Error ? error.message : String(error);
      } finally {
        this.evaluatorAbort = undefined;
      }

      if (!this.refreshEvaluationState(ctx, epoch, current) || !this.state) return;
      const failures = this.state.verificationFailures + 1;
      const next: GoalStateV1 = {
        ...this.state,
        verificationFailures: failures,
        consecutiveJudgeFailures: 0,
        iteration: this.state.iteration + 1,
        lastReason: `GoalVerifier FAIL: ${verifierReason}`,
        evidence: verifierEvidence,
        updatedAt: Date.now(),
      };
      this.persist(next);
      if (failures >= DEFAULT_GOAL_BUDGET.maxVerificationFailures) {
        const blocked = this.transition("blocked", `Repeated GoalVerifier failure: ${verifierReason}`);
        if (blocked) this.notify(blocked, `Goal blocked: ${blocked.terminalReason}`);
        return;
      }
      this.hidden(GOAL_CONTINUE_MESSAGE, `Independent verification failed. Continue working on the goal.\n\nVerifier evidence: ${verifierReason}`);
      return;
    }

    const noProgress = current.lastEvidenceFingerprint === evidenceFingerprint
      ? current.noProgressCycles + 1
      : 0;
    const next: GoalStateV1 = {
      ...this.state!,
      iteration: this.state!.iteration + 1,
      consecutiveJudgeFailures: 0,
      noProgressCycles: noProgress,
      lastReason: verdict.reason,
      evidence: verdict.evidence,
      lastEvidenceFingerprint: evidenceFingerprint,
      updatedAt: Date.now(),
    };
    this.persist(next);
    if (noProgress >= DEFAULT_GOAL_BUDGET.maxNoProgressCycles) {
      const blocked = this.transition("blocked", `No meaningful progress for ${noProgress} evaluation cycles. Latest judge reason: ${verdict.reason}`);
      if (blocked) this.notify(blocked, `Goal blocked: ${blocked.terminalReason}`);
      return;
    }

    this.hidden(GOAL_CONTINUE_MESSAGE, [
      "The active goal is not yet satisfied. Continue working autonomously.",
      `GoalJudge reason: ${verdict.reason}`,
      verdict.nextAction ? `Suggested next action: ${verdict.nextAction}` : "",
    ].filter(Boolean).join("\n\n"));
  }
}
