import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildJudgePrompt, parseGoalVerdict } from "./judge.js";
import { latestGoalState, nextGeneration, terminalState } from "./state.js";
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

const restoredInProcess = new Set<string>();
const WAKE_DEBOUNCE_MS = 250;

function parentReady(ctx: ExtensionContext): boolean {
  const runtime = ctx as ExtensionContext & { isIdle?: () => boolean; hasPendingMessages?: () => boolean };
  return (runtime.isIdle?.() ?? true) && !(runtime.hasPendingMessages?.() ?? false);
}

function contextPercent(ctx: ExtensionContext): number | undefined {
  const runtime = ctx as ExtensionContext & {
    getContextUsage?: () => { percent?: number; contextPercent?: number; tokens?: number; maxTokens?: number } | undefined;
  };
  const usage = runtime.getContextUsage?.();
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
  private evaluationInFlight = false;
  private evaluationQueued = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private evaluatorAbort: AbortController | undefined;

  constructor(private readonly pi: ExtensionAPI) {}

  get current(): GoalStateV1 | undefined { return this.state; }

  private branchState(ctx: ExtensionContext): GoalStateV1 | undefined {
    return latestGoalState(ctx.sessionManager.getBranch());
  }

  private syncBranch(ctx: ExtensionContext): void {
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

  restore(ctx: ExtensionContext): void {
    this.syncBranch(ctx);
    const goal = this.state;
    if (!goal || goal.status !== "active") return;
    const key = `${ctx.sessionManager.getSessionId()}+${goal.id}+${goal.generation}`;
    if (restoredInProcess.has(key)) return;
    restoredInProcess.add(key);
    setTimeout(() => {
      if (this.state?.id !== goal.id || this.state.generation !== goal.generation || this.state.status !== "active") return;
      if (!this.ctx || !parentReady(this.ctx) || hasActiveSubagents()) return;
      this.hidden(GOAL_CONTINUE_MESSAGE, `Resume autonomous pursuit of the active goal:\n\n${goal.objective}`);
    }, 0);
  }

  shutdown(): void {
    this.evaluatorAbort?.abort();
    this.evaluatorAbort = undefined;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    this.ctx = undefined;
    this.state = undefined;
    this.evaluationQueued = false;
  }

  start(ctx: ExtensionContext, objective: string, criteria: string[]): GoalStateV1 {
    this.syncBranch(ctx);
    if (this.state?.status === "active") {
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
    this.syncBranch(ctx);
    if (this.state?.status !== "active") return undefined;
    this.evaluatorAbort?.abort();
    return this.transition("paused", "Paused by user.");
  }

  resume(ctx: ExtensionContext): GoalStateV1 | undefined {
    this.syncBranch(ctx);
    if (!this.state || this.state.status !== "paused") return undefined;
    const next: GoalStateV1 = { ...this.state, status: "active", updatedAt: Date.now(), terminalReason: undefined };
    this.persist(next);
    this.hidden(GOAL_CONTINUE_MESSAGE, `Resume autonomous pursuit of the active goal:\n\n${next.objective}`);
    return next;
  }

  stop(ctx: ExtensionContext, reason = "Stopped by user."): GoalStateV1 | undefined {
    this.syncBranch(ctx);
    if (!this.state || this.state.status === "stopped") return undefined;
    this.evaluatorAbort?.abort();
    return this.transition("stopped", reason);
  }

  clear(ctx: ExtensionContext): GoalStateV1 | undefined {
    return this.stop(ctx, "Cleared by user. Historical goal entries remain append-only.");
  }

  scheduleSubagentWake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      const ctx = this.ctx;
      if (!ctx) return;
      this.syncBranch(ctx);
      if (this.state?.status !== "active" || hasActiveSubagents() || !parentReady(ctx)) return;
      this.hidden(GOAL_SUBAGENT_UPDATE_MESSAGE, "Background subagent work has settled. Reassess the active goal using the new results.");
    }, WAKE_DEBOUNCE_MS);
  }

  requestEvaluation(ctx: ExtensionContext): void {
    this.syncBranch(ctx);
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

  private async evaluatorFailure(current: GoalStateV1, reason: string): Promise<void> {
    if (!this.state || this.state.id !== current.id || this.state.generation !== current.generation) return;
    const failures = current.consecutiveJudgeFailures + 1;
    const next: GoalStateV1 = { ...current, consecutiveJudgeFailures: failures, lastReason: reason, updatedAt: Date.now() };
    this.persist(next);
    if (failures >= DEFAULT_GOAL_BUDGET.maxConsecutiveJudgeFailures) {
      const blocked = this.transition("blocked", `GoalJudge failed ${failures} consecutive times: ${reason}`);
      if (blocked) this.notify(blocked, `Goal blocked: ${blocked.terminalReason}`);
    }
  }

  private async evaluateOnce(ctx: ExtensionContext): Promise<void> {
    this.syncBranch(ctx);
    const current = this.state;
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
    const generation = current.generation;
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
      await this.evaluatorFailure(current, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      this.evaluatorAbort = undefined;
    }

    this.syncBranch(ctx);
    if (!this.state || this.state.id !== current.id || this.state.generation !== generation || this.state.status !== "active") return;
    const verdict = parseGoalVerdict(judgeOutput);
    if (!verdict) {
      await this.evaluatorFailure(current, "GoalJudge returned malformed output.");
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
        if (parsed.ok) {
          this.syncBranch(ctx);
          if (!this.state || this.state.id !== current.id || this.state.generation !== generation || this.state.status !== "active") return;
          const completed: GoalStateV1 = {
            ...this.state,
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

      this.syncBranch(ctx);
      if (!this.state || this.state.id !== current.id || this.state.generation !== generation || this.state.status !== "active") return;
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
      ...current,
      iteration: current.iteration + 1,
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
