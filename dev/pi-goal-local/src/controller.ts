import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildJudgePrompt, parseGoalVerdict } from "./judge.js";
import {
  createContextEpochBootstrap,
  createContextEpochMarker,
  hashContextEpochBootstrap,
} from "./context-epoch.js";
import {
  loadVerifiedCorrectionPlan,
  loadVerifiedOriginalPlan,
  persistCorrectionPlan,
  snapshotOriginalPlan,
} from "./plan-artifacts.js";
import { loadGoalLoopSettings } from "./settings.js";
import {
  CLEARED_REASON,
  latestGoalLoopState,
  latestGoalState,
  nextGeneration,
  terminalState,
} from "./state.js";
import { hasActiveSubagents, runEvaluator } from "./subagents.js";
import { buildGoalEvidence, fingerprintEvidence } from "./transcript.js";
import {
  DEFAULT_GOAL_BUDGET,
  GOAL_CONTEXT_EPOCH_TYPE,
  GOAL_CONTINUE_MESSAGE,
  GOAL_START_MESSAGE,
  GOAL_STATE_TYPE,
  GOAL_STATE_V2_TYPE,
  GOAL_STATUS_MESSAGE,
  GOAL_SUBAGENT_UPDATE_MESSAGE,
  type GoalLoopPhase,
  type GoalLoopStrategy,
  type GoalStateV1,
  type GoalStateV2,
  type GoalStatus,
} from "./types.js";
import {
  buildVerifierPrompt,
  parseVerifierVerdict,
  type GoalLoopVerifierVerdict,
} from "./verifier.js";

const WAKE_DEBOUNCE_MS = 250;
const WAKE_MAX_RETRY_MS = 2_000;
const WAKE_MAX_RETRIES = 8;

type GoalMarker = GoalStateV1 | GoalStateV2;

type PendingWake = {
  selectionIdentity: string;
  epoch: number;
  goalId: string;
  generation: number;
};

type LoopContinuationToken = {
  selectionIdentity: string;
  epoch: number;
  loopId: string;
  generation: number;
  cycle: number;
  contextEpoch: number;
};

type TreeGoalCarry = {
  sessionId: string;
  goal: GoalMarker;
};

export interface GoalLoopStartOptions {
  loop?: boolean;
  planPath?: string;
  sourcePath?: string;
  sourceKind?: "explicit" | "approved";
  strategy?: GoalLoopStrategy;
  maxCycles?: number;
  /** Required for a PREWALK loop; unsafe PREWALK starts are blocked. */
  prewalkReady?: boolean;
  /** Test/deployment override; production artifact storage uses the agent dir. */
  agentDir?: string;
}

const LOOP_PHASE_ACTIVE: readonly GoalLoopPhase[] = ["implementing", "verifying", "replanning"];

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
  /** Legacy V1 state. A V2 marker intentionally makes this undefined. */
  private state: GoalStateV1 | undefined;
  private loopState: GoalStateV2 | undefined;
  private sessionEpoch = 0;
  private evaluationInFlight = false;
  private evaluationQueued = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private wakeRetryDelay = 0;
  private wakeAttempts = 0;
  private pendingWake: PendingWake | undefined;
  private loopContinuationToken: LoopContinuationToken | undefined;
  private loopContinuationInFlight = false;
  private treeGoalCarry: TreeGoalCarry | undefined;
  private navigationPending = false;
  private navigationGeneration = 0;
  private evaluatorAbort: AbortController | undefined;
  private readonly fingerprintCounts = new Map<string, number>();
  private readonly judgeNoProgress = new Map<string, { fingerprint: string; count: number }>();
  private readonly prewalkReadyLoops = new Set<string>();
  private readonly loopAgentDirs = new Map<string, string | undefined>();

  constructor(private readonly pi: ExtensionAPI) {}

  get current(): GoalStateV1 | undefined { return this.state; }
  /** Current V2 fixed-point state, if the selected branch has one. */
  get currentLoop(): GoalStateV2 | undefined { return this.loopState; }

  private branchState(ctx: ExtensionContext): GoalStateV1 | undefined {
    return latestGoalState(ctx.sessionManager.getBranch());
  }

  private branchLoopState(ctx: ExtensionContext): GoalStateV2 | undefined {
    return latestGoalLoopState(ctx.sessionManager.getBranch());
  }

  private branchIdentity(ctx: ExtensionContext): string {
    const path = ctx.sessionManager.getBranch().map(entry =>
      typeof entry.id === "string" ? `id:${entry.id}` : `entry:${JSON.stringify(entry)}`
    ).join("/");
    return createHash("sha256").update(path).digest("hex");
  }

  private selectionIdentity(ctx: ExtensionContext): string {
    const leafId = ctx.sessionManager.getLeafId();
    return `${ctx.sessionManager.getSessionId()}:${leafId ?? this.branchIdentity(ctx)}`;
  }

  private syncBranch(ctx: ExtensionContext): void {
    const identity = this.selectionIdentity(ctx);
    if ((this.pendingWake && this.pendingWake.selectionIdentity !== identity)
      || (this.loopContinuationToken && this.loopContinuationToken.selectionIdentity !== identity)) {
      this.invalidatePendingWake();
    }
    this.ctx = ctx;
    this.state = this.branchState(ctx);
    this.loopState = this.branchLoopState(ctx);
  }

  private persist(next: GoalStateV1): void {
    this.state = next;
    this.loopState = undefined;
    this.pi.appendEntry(GOAL_STATE_TYPE, next);
  }

  private persistLoop(next: GoalStateV2): void {
    this.loopState = next;
    this.state = undefined;
    this.pi.appendEntry(GOAL_STATE_V2_TYPE, next);
  }

  private transition(status: Exclude<GoalStatus, "active">, reason: string): GoalStateV1 | undefined {
    if (!this.state) return undefined;
    const next = terminalState(this.state, status, reason);
    this.persist(next);
    return next;
  }

  private loopTerminal(
    state: GoalStateV2,
    phase: Exclude<GoalLoopPhase, "active" | "implementing" | "verifying" | "replanning">,
    reason: string,
  ): GoalStateV2 {
    const reasons = { ...state.reasons };
    if (phase === "paused") reasons.pause = reason;
    else if (phase === "blocked") reasons.block = reason;
    else if (phase === "stopped") reasons.block = reason;
    return { ...state, phase, updatedAt: Date.now(), reasons };
  }

  private blockLoop(state: GoalStateV2, reason: string, verifier?: GoalStateV2["verifier"]): GoalStateV2 {
    const next: GoalStateV2 = {
      ...state,
      phase: "blocked",
      verifier: verifier ? { ...state.verifier, ...verifier } : state.verifier,
      updatedAt: Date.now(),
      reasons: { ...state.reasons, block: reason },
    };
    this.persistLoop(next);
    this.notifyLoop(next, `Goal loop blocked: ${reason}`);
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

  private notifyLoop(next: GoalStateV2, content: string): void {
    this.pi.sendMessage({
      customType: GOAL_STATUS_MESSAGE,
      content,
      display: true,
      details: {
        loopId: next.loopId,
        generation: next.generation,
        cycle: next.cycle,
        contextEpoch: next.contextEpoch,
        phase: next.phase,
      },
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
    // An in-flight artifact read cannot always be cancelled, but removing its
    // token makes every post-await lifecycle check reject its publication.
    this.loopContinuationToken = undefined;
  }

  private invalidatePendingEvaluation(): void {
    this.sessionEpoch += 1;
    this.evaluatorAbort?.abort();
    this.invalidatePendingWake();
    this.evaluationQueued = false;
  }

  private clearNavigationPending(): void {
    this.navigationGeneration += 1;
    this.navigationPending = false;
  }

  private deferNavigationFallback(): void {
    const generation = ++this.navigationGeneration;
    // The host has no completion callback for a canceled or failed navigation.
    // Keep the guard through this lifecycle callback, then release it so an
    // operation that never reaches restore cannot leave the controller wedged.
    queueMicrotask(() => {
      // A successful navigation or shutdown owns the lifecycle transition and
      // may have already changed this state. Never let this fallback undo it.
      if (generation === this.navigationGeneration) this.navigationPending = false;
    });
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
    const ctx = this.ctx;
    if (!pending || !ctx) return false;
    if (pending.epoch !== this.sessionEpoch || this.selectionIdentity(ctx) !== pending.selectionIdentity) {
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
      selectionIdentity: this.selectionIdentity(ctx),
      epoch,
      goalId: goal.id,
      generation: goal.generation,
    };
    if (this.pendingWake
      && this.pendingWake.selectionIdentity === request.selectionIdentity
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
    if (this.loopContinuationToken) {
      const activeCtx = ctx ?? this.ctx;
      if (!activeCtx || this.selectionIdentity(activeCtx) !== this.loopContinuationToken.selectionIdentity) {
        this.invalidatePendingWake();
        return false;
      }
      this.ctx = activeCtx;
      void this.attemptLoopBootstrap(activeCtx, this.loopContinuationToken);
      return true;
    }
    if (!this.pendingWake) return false;
    if (ctx) {
      if (this.selectionIdentity(ctx) !== this.pendingWake.selectionIdentity) {
        this.invalidatePendingWake();
        return false;
      }
      this.ctx = ctx;
    }
    const delivered = this.attemptPendingWake();
    if (this.pendingWake && this.wakeTimer === undefined && this.wakeAttempts < WAKE_MAX_RETRIES) {
      this.armWakeTimer(WAKE_DEBOUNCE_MS);
    }
    return delivered || this.pendingWake !== undefined;
  }

  restore(ctx: ExtensionContext): void {
    this.invalidatePendingEvaluation();
    this.treeGoalCarry = undefined;
    this.clearNavigationPending();
    this.syncBranch(ctx);
    if (this.state?.status === "active") {
      this.transition("paused", "Paused when the session was reopened.");
      return;
    }
    if (this.loopState && LOOP_PHASE_ACTIVE.includes(this.loopState.phase)) {
      this.persistLoop({
        ...this.loopState,
        phase: "paused",
        updatedAt: Date.now(),
        reasons: { ...this.loopState.reasons, pause: "Paused when the session was reopened." },
      });
    }
  }

  restoreSelectedBranch(ctx: ExtensionContext): void {
    this.invalidatePendingEvaluation();
    const carry = this.treeGoalCarry;
    this.treeGoalCarry = undefined;
    this.clearNavigationPending();
    this.syncBranch(ctx);

    const branchHasGoalMarker = ctx.sessionManager.getBranch().some(
      entry => entry.type === "custom"
        && (entry.customType === GOAL_STATE_TYPE || entry.customType === GOAL_STATE_V2_TYPE),
    );
    if (!branchHasGoalMarker && carry?.sessionId === ctx.sessionManager.getSessionId()) {
      const reason = "Paused after rewinding the conversation.";
      if (carry.goal.schemaVersion === 2) {
        this.persistLoop({
          ...carry.goal,
          phase: "paused",
          updatedAt: Date.now(),
          reasons: { ...carry.goal.reasons, pause: reason },
        });
      } else {
        this.persist({
          ...carry.goal,
          status: "paused",
          updatedAt: Date.now(),
          lastReason: reason,
          terminalReason: reason,
        });
      }
      return;
    }

    const goal = this.state;
    if (goal?.status === "active") {
      this.scheduleResume(ctx, goal, this.sessionEpoch);
      return;
    }
    const loop = this.loopState;
    if (loop && LOOP_PHASE_ACTIVE.includes(loop.phase)) {
      this.scheduleLoopBootstrap(ctx, loop, this.sessionEpoch);
    }
  }

  refresh(ctx: ExtensionContext): GoalStateV1 | undefined {
    this.syncBranch(ctx);
    return this.state;
  }

  refreshLoop(ctx: ExtensionContext): GoalStateV2 | undefined {
    this.syncBranch(ctx);
    return this.loopState;
  }

  get currentMarker(): GoalMarker | undefined {
    return this.state ?? this.loopState;
  }

  refreshMarker(ctx: ExtensionContext): GoalMarker | undefined {
    this.syncBranch(ctx);
    return this.currentMarker;
  }

  prepareForNavigation(): void {
    this.invalidatePendingEvaluation();
    this.treeGoalCarry = undefined;
    this.navigationPending = true;
    this.deferNavigationFallback();
  }

  prepareForTreeNavigation(ctx: ExtensionContext): void {
    this.invalidatePendingEvaluation();
    this.navigationPending = true;
    this.deferNavigationFallback();
    const goal = this.branchState(ctx);
    const loop = this.branchLoopState(ctx);
    this.treeGoalCarry = goal?.status === "active"
      ? { sessionId: ctx.sessionManager.getSessionId(), goal: { ...goal } }
      : loop && LOOP_PHASE_ACTIVE.includes(loop.phase)
        ? { sessionId: ctx.sessionManager.getSessionId(), goal: { ...loop } }
        : undefined;
  }

  shutdown(): void {
    this.invalidatePendingEvaluation();
    this.treeGoalCarry = undefined;
    this.navigationGeneration += 1;
    this.navigationPending = true;
    this.evaluatorAbort = undefined;
    this.ctx = undefined;
    this.state = undefined;
    this.loopState = undefined;
    this.fingerprintCounts.clear();
    this.judgeNoProgress.clear();
    this.prewalkReadyLoops.clear();
    this.loopAgentDirs.clear();
  }

  start(ctx: ExtensionContext, objective: string, criteria: string[]): GoalStateV1;
  start(ctx: ExtensionContext, objective: string, criteria: string[], options: GoalLoopStartOptions & { loop?: false }): GoalStateV1;
  start(ctx: ExtensionContext, objective: string, criteria: string[], options: GoalLoopStartOptions & { loop: true }): Promise<GoalStateV2>;
  start(ctx: ExtensionContext, objective: string, criteria: string[], options?: GoalLoopStartOptions): GoalStateV1 | Promise<GoalStateV2> {
    if (options?.loop) return this.startLoop(ctx, objective, criteria, options);
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status === "active") {
      this.evaluatorAbort?.abort();
      this.persist(terminalState(this.state, "stopped", "Replaced by a newer /goal generation."));
    }
    if (this.loopState && LOOP_PHASE_ACTIVE.includes(this.loopState.phase)) {
      this.evaluatorAbort?.abort();
      this.persistLoop(this.loopTerminal(this.loopState, "stopped", "Replaced by a newer /goal generation."));
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

  /**
   * Start an opt-in V2 fixed-point loop. V1 `/goal` callers continue to use
   * start(); this path is deliberately asynchronous because the original plan
   * must be copied into the private artifact store before it becomes state.
   */
  async startLoop(
    ctx: ExtensionContext,
    objective: string,
    criteria: string[],
    options: GoalLoopStartOptions = {},
  ): Promise<GoalStateV2> {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status === "active") {
      this.persist(terminalState(this.state, "stopped", "Replaced by a newer /goal loop."));
    }
    if (this.loopState && LOOP_PHASE_ACTIVE.includes(this.loopState.phase)) {
      this.persistLoop(this.loopTerminal(this.loopState, "stopped", "Replaced by a newer /goal loop."));
    }

    const settings = loadGoalLoopSettings(ctx.cwd);
    const startEpoch = this.sessionEpoch;
    const maxCycles = options.maxCycles ?? settings.maxCycles;
    if (!Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > 100) {
      throw new Error("Goal loop maxCycles is outside the safe bound (1-100).");
    }
    const sourcePath = options.sourcePath ?? options.planPath;
    if (!sourcePath?.trim()) throw new Error("A V2 goal loop requires an explicit or approved plan path.");
    const sourceKind = options.sourceKind ?? "explicit";
    if (sourceKind !== "explicit" && sourceKind !== "approved") {
      throw new Error("A V2 goal loop plan source must be explicit or approved.");
    }
    const strategy = options.strategy;
    if (strategy !== undefined && strategy !== "YOLO" && strategy !== "ORCHESTRATOR" && strategy !== "PREWALK") {
      throw new Error("Unknown goal loop execution strategy.");
    }

    const loopId = randomUUID();
    this.loopAgentDirs.set(loopId, options.agentDir);
    const snapshot = await snapshotOriginalPlan({
      cwd: ctx.cwd,
      loopId,
      sourceKind,
      sourcePath,
      agentDir: options.agentDir,
      maxBytes: settings.maxPlanBytes,
    });
    if (startEpoch !== this.sessionEpoch || this.ctx !== ctx) {
      throw new Error("Goal loop start was superseded before its immutable plan snapshot was installed.");
    }
    const now = Date.now();
    const candidate: GoalStateV2 = {
      schemaVersion: 2,
      loopId,
      generation: (this.loopState?.generation ?? this.state?.generation ?? 0) + 1,
      contextEpoch: 0,
      phase: strategy === "PREWALK" && options.prewalkReady !== true ? "blocked" : "implementing",
      cycle: 0,
      maxCycles,
      objective: objective.trim() || "Implement the referenced plan.",
      criteria: [...criteria],
      plan: snapshot.provenance,
      ...(strategy === undefined ? {} : { strategy }),
      createdAt: now,
      updatedAt: now,
      ...(strategy === "PREWALK" && options.prewalkReady !== true
        ? { reasons: { block: "PREWALK approval/execution is not safely established." } }
        : {}),
    };
    if (candidate.phase === "blocked") {
      this.persistLoop(candidate);
      this.notifyLoop(candidate, `Goal loop blocked: ${candidate.reasons?.block}`);
      return candidate;
    }

    const marked = await this.markLoopEpoch(ctx, candidate, settings.maxBootstrapBytes, options.agentDir);
    if (startEpoch !== this.sessionEpoch || this.ctx !== ctx) {
      throw new Error("Goal loop start was superseded before its context epoch was installed.");
    }
    this.persistLoop(marked.state);
    if (strategy === "PREWALK") this.prewalkReadyLoops.add(loopId);
    this.scheduleLoopBootstrap(ctx, marked.state, this.sessionEpoch, options.agentDir);
    return marked.state;
  }

  /** Compatibility aliases for integrations that name the V2 path explicitly. */
  startFixedPointLoop = this.startLoop.bind(this);
  startV2Loop = this.startLoop.bind(this);
  startGoalLoop = this.startLoop.bind(this);

  private loopStorageAgentDir(state: GoalStateV2): string | undefined {
    // A caller-provided test/deployment root is remembered only for this
    // controller instance. On restore, the artifact module's production agent
    // directory remains authoritative; never derive storage trust from the
    // persisted source or snapshot path.
    return this.loopAgentDirs.get(state.loopId);
  }

  private async loopBootstrap(
    ctx: ExtensionContext,
    state: GoalStateV2,
    maxBootstrapBytes: number,
    agentDir?: string,
  ): Promise<ReturnType<typeof createContextEpochBootstrap>> {
    const settings = loadGoalLoopSettings(ctx.cwd);
    const storageAgentDir = agentDir ?? this.loopAgentDirs.get(state.loopId);
    const original = await loadVerifiedOriginalPlan({
      loopId: state.loopId,
      provenance: state.plan,
      agentDir: storageAgentDir,
      maxBytes: settings.maxPlanBytes,
    });
    let correction;
    if (state.verifier?.correctionPath && state.verifier.correctionHash) {
      const artifact = await loadVerifiedCorrectionPlan({
        loopId: state.loopId,
        cycle: state.cycle,
        path: state.verifier.correctionPath,
        correctionHash: state.verifier.correctionHash,
        maxCycles: state.maxCycles,
        agentDir: storageAgentDir,
        maxBytes: settings.maxCorrectionBytes,
      });
      correction = { path: artifact.path, hash: artifact.hash, content: artifact.content };
    }
    return createContextEpochBootstrap({
      state,
      originalPlan: { path: original.path, hash: original.hash, content: original.content },
      correction,
      verifier: {
        discrepancies: state.verifier?.outcome === "replan"
          ? [`Apply the corrective plan for cycle ${state.cycle} and re-check the acceptance criteria.`]
          : [],
        requiredValidation: ["Re-run the focused checks required by the acceptance criteria."],
      },
      capabilityGuidance: [this.capabilities()],
      continuationInstruction: state.strategy === "PREWALK"
        ? "PREWALK strategy is authoritative; continue only with the approved PREWALK execution path."
        : "Continue implementing the current immutable plan, then stop for GoalJudge and independent GoalVerifier evaluation.",
      maxBootstrapBytes,
    });
  }

  private async markLoopEpoch(
    ctx: ExtensionContext,
    candidate: GoalStateV2,
    maxBootstrapBytes: number,
    agentDir?: string,
  ): Promise<{ state: GoalStateV2; marker: ReturnType<typeof createContextEpochMarker> }> {
    const bootstrap = await this.loopBootstrap(ctx, candidate, maxBootstrapBytes, agentDir);
    const hash = hashContextEpochBootstrap(bootstrap, maxBootstrapBytes);
    const marker = createContextEpochMarker(bootstrap, { maxBootstrapBytes, timestamp: Date.now() });
    const state: GoalStateV2 = {
      ...candidate,
      epochMarker: { id: marker.details.id, hash },
    };
    // Rebuild against the marker-bearing state so the context module validates
    // the exact durable identity that will be restored after compaction.
    const finalBootstrap = await this.loopBootstrap(ctx, state, maxBootstrapBytes, agentDir);
    const finalMarker = createContextEpochMarker(finalBootstrap, { maxBootstrapBytes, timestamp: Date.now(), id: marker.details.id });
    if (hashContextEpochBootstrap(finalBootstrap, maxBootstrapBytes) !== hash) {
      throw new Error("Loop context epoch changed while creating its authoritative marker.");
    }
    return { state, marker: finalMarker };
  }

  private loopTokenMatches(ctx: ExtensionContext, token: LoopContinuationToken, state: GoalStateV2 | undefined): boolean {
    return token.epoch === this.sessionEpoch
      && this.ctx === ctx
      && this.selectionIdentity(ctx) === token.selectionIdentity
      && state?.loopId === token.loopId
      && state.generation === token.generation
      && state.cycle === token.cycle
      && state.contextEpoch === token.contextEpoch
      && LOOP_PHASE_ACTIVE.includes(state.phase);
  }

  private async attemptLoopBootstrap(ctx: ExtensionContext, token: LoopContinuationToken, agentDir?: string): Promise<void> {
    if (this.loopContinuationInFlight) return;
    this.loopContinuationInFlight = true;
    try {
      const current = this.branchLoopState(ctx);
      this.loopState = current;
      if (token.epoch !== this.sessionEpoch
        || this.ctx !== ctx
        || this.selectionIdentity(ctx) !== token.selectionIdentity) {
        this.loopContinuationToken = undefined;
        return;
      }
      if (!current
        || current.loopId !== token.loopId
        || current.generation !== token.generation
        || current.cycle !== token.cycle
        || current.contextEpoch !== token.contextEpoch
        || !LOOP_PHASE_ACTIVE.includes(current.phase)) {
        this.loopContinuationToken = undefined;
        return;
      }
      if (!parentReady(ctx) || hasActiveSubagents()) return;
      if (current!.strategy === "PREWALK" && !this.prewalkReadyLoops.has(current!.loopId)) {
        this.loopContinuationToken = undefined;
        this.blockLoop(current!, "PREWALK continuation is unsafe without a fresh approved PREWALK execution.");
        return;
      }
      const settings = loadGoalLoopSettings(ctx.cwd);
      const built = await this.loopBootstrap(ctx, current!, settings.maxBootstrapBytes, agentDir);
      const marker = createContextEpochMarker(built, {
        maxBootstrapBytes: settings.maxBootstrapBytes,
        timestamp: Date.now(),
        id: current!.epochMarker?.id,
      });
      const latest = this.branchLoopState(ctx);
      this.loopState = latest;
      if (!this.loopTokenMatches(ctx, token, latest) || !parentReady(ctx) || hasActiveSubagents()) return;
      this.loopContinuationToken = undefined;
      // Clear before both sends: either send can synchronously cause an agent
      // lifecycle event, and that event must not enqueue a duplicate epoch.
      this.pi.sendMessage({
        customType: GOAL_CONTEXT_EPOCH_TYPE,
        content: marker.content,
        display: false,
        details: marker.details,
      }, { deliverAs: "followUp", triggerTurn: false });
      const afterMarker = this.branchLoopState(ctx);
      this.loopState = afterMarker;
      // The marker itself is a persisted custom message and therefore advances
      // the selected leaf. Check the loop identity but intentionally do not
      // compare the pre-marker selection identity here.
      if (token.epoch !== this.sessionEpoch
        || this.ctx !== ctx
        || afterMarker?.loopId !== token.loopId
        || afterMarker.generation !== token.generation
        || afterMarker.cycle !== token.cycle
        || afterMarker.contextEpoch !== token.contextEpoch
        || !LOOP_PHASE_ACTIVE.includes(afterMarker.phase)) return;
      this.pi.sendMessage({
        customType: GOAL_CONTINUE_MESSAGE,
        content: [
          "Continue autonomous pursuit of the active fixed-point goal.",
          `Objective: ${current!.objective}`,
          `Immutable plan snapshot: ${current!.plan.snapshotPath}`,
          current!.verifier?.correctionPath ? `Current corrective snapshot: ${current!.verifier.correctionPath}` : "",
          current!.reasons?.stagnation ? `Latest execution guidance: ${current!.reasons.stagnation}` : "",
        ].filter(Boolean).join("\n\n"),
        display: false,
        details: {
          loopId: current!.loopId,
          generation: current!.generation,
          cycle: current!.cycle,
          contextEpoch: current!.contextEpoch,
        },
      }, { deliverAs: "followUp", triggerTurn: true });
    } catch (error) {
      const current = this.branchLoopState(ctx);
      this.loopState = current;
      if (current && this.loopTokenMatches(ctx, token, current)) {
        this.loopContinuationToken = undefined;
        this.blockLoop(current, `Unable to establish the immutable context bootstrap: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      this.loopContinuationInFlight = false;
      // A pause/resume, navigation, or replacement may have installed a new
      // token while this artifact read was settling. Do not leave that newer
      // continuation stranded behind the stale in-flight attempt.
      const pending = this.loopContinuationToken;
      if (pending && pending !== token && this.ctx) {
        void this.attemptLoopBootstrap(this.ctx, pending);
      }
    }
  }

  private scheduleLoopBootstrap(
    ctx: ExtensionContext,
    state: GoalStateV2,
    epoch: number,
    agentDir?: string,
  ): void {
    if (epoch !== this.sessionEpoch || this.ctx !== ctx || !LOOP_PHASE_ACTIVE.includes(state.phase)) return;
    const token: LoopContinuationToken = {
      selectionIdentity: this.selectionIdentity(ctx),
      epoch,
      loopId: state.loopId,
      generation: state.generation,
      cycle: state.cycle,
      contextEpoch: state.contextEpoch,
    };
    const existing = this.loopContinuationToken;
    if (existing
      && existing.selectionIdentity === token.selectionIdentity
      && existing.epoch === token.epoch
      && existing.loopId === token.loopId
      && existing.generation === token.generation
      && existing.cycle === token.cycle
      && existing.contextEpoch === token.contextEpoch) return;
    this.invalidatePendingWake();
    this.loopContinuationToken = token;
    void this.attemptLoopBootstrap(ctx, token, agentDir);
  }

  pause(ctx: ExtensionContext): GoalStateV1 | GoalStateV2 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status === "active") {
      this.evaluatorAbort?.abort();
      return this.transition("paused", "Paused by user.");
    }
    if (this.loopState && LOOP_PHASE_ACTIVE.includes(this.loopState.phase)) {
      this.evaluatorAbort?.abort();
      const paused = this.loopTerminal(this.loopState, "paused", "Paused by user.");
      this.persistLoop(paused);
      return paused;
    }
    return undefined;
  }

  resume(ctx: ExtensionContext): GoalStateV1 | GoalStateV2 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state?.status === "paused") {
      const next: GoalStateV1 = { ...this.state, status: "active", updatedAt: Date.now(), terminalReason: undefined };
      this.persist(next);
      this.hidden(GOAL_CONTINUE_MESSAGE, `Resume autonomous pursuit of the active goal:\n\n${next.objective}`);
      return next;
    }
    if (this.loopState?.phase === "paused") {
      if (this.loopState.strategy === "PREWALK" && !this.prewalkReadyLoops.has(this.loopState.loopId)) {
        return this.blockLoop(this.loopState, "PREWALK continuation is unsafe without a fresh approved PREWALK execution.");
      }
      const next: GoalStateV2 = {
        ...this.loopState,
        phase: "implementing",
        updatedAt: Date.now(),
        reasons: { ...this.loopState.reasons, pause: undefined },
      };
      if (next.reasons && !next.reasons.block && !next.reasons.stagnation) next.reasons = undefined;
      this.persistLoop(next);
      this.scheduleLoopBootstrap(ctx, next, this.sessionEpoch);
      return next;
    }
    return undefined;
  }

  stop(ctx: ExtensionContext, reason = "Stopped by user."): GoalStateV1 | GoalStateV2 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state && this.state.status !== "stopped") {
      this.evaluatorAbort?.abort();
      return this.transition("stopped", reason);
    }
    if (this.loopState && this.loopState.phase !== "stopped") {
      this.evaluatorAbort?.abort();
      const stopped = this.loopTerminal(this.loopState, "stopped", reason);
      this.persistLoop(stopped);
      return stopped;
    }
    return undefined;
  }

  clear(ctx: ExtensionContext): GoalStateV1 | GoalStateV2 | undefined {
    this.invalidatePendingEvaluation();
    this.syncBranch(ctx);
    if (this.state) {
      this.evaluatorAbort?.abort();
      const cleared = terminalState(this.state, "stopped", CLEARED_REASON);
      this.persist(cleared);
      this.state = undefined;
      return cleared;
    }
    if (this.loopState) {
      this.evaluatorAbort?.abort();
      const cleared: GoalStateV2 = {
        ...this.loopState,
        phase: "stopped",
        updatedAt: Date.now(),
        reasons: { ...this.loopState.reasons, block: CLEARED_REASON },
      };
      this.persistLoop(cleared);
      this.loopState = undefined;
      return cleared;
    }
    return undefined;
  }

  scheduleSubagentWake(): void {
    if (this.navigationPending) return;
    if (this.pendingWake || this.loopContinuationToken) {
      this.retryPendingWake();
      return;
    }
    if (this.wakeTimer !== undefined) clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    const ctx = this.ctx;
    const epoch = this.sessionEpoch;
    if (!ctx) return;
    const scheduledLoop = this.branchLoopState(ctx);
    if (scheduledLoop && LOOP_PHASE_ACTIVE.includes(scheduledLoop.phase)) {
      this.scheduleLoopBootstrap(ctx, scheduledLoop, epoch);
      return;
    }
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
    if (this.navigationPending) return;
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

  private refreshLoopEvaluationState(
    ctx: ExtensionContext,
    token: { epoch: number; loopId: string; generation: number; cycle: number; contextEpoch: number },
    phases: readonly GoalLoopPhase[] = LOOP_PHASE_ACTIVE,
  ): boolean {
    if (token.epoch !== this.sessionEpoch || this.ctx !== ctx) return false;
    this.loopState = this.branchLoopState(ctx);
    const current = this.loopState;
    return current?.loopId === token.loopId
      && current.generation === token.generation
      && current.cycle === token.cycle
      && current.contextEpoch === token.contextEpoch
      && phases.includes(current.phase);
  }

  private async evaluateLoopOnce(ctx: ExtensionContext, initial: GoalStateV2): Promise<void> {
    if (initial.phase !== "implementing") return;
    const token = {
      epoch: this.sessionEpoch,
      loopId: initial.loopId,
      generation: initial.generation,
      cycle: initial.cycle,
      contextEpoch: initial.contextEpoch,
    };
    if (!parentReady(ctx) || hasActiveSubagents()) return;
    const entries = ctx.sessionManager.buildContextEntries();
    const evidenceText = buildGoalEvidence(entries);
    const evidenceFingerprint = fingerprintEvidence(evidenceText);
    const settings = loadGoalLoopSettings(ctx.cwd);
    const judgeAbort = new AbortController();
    this.evaluatorAbort = judgeAbort;

    let judgeOutput: string;
    try {
      const judge = await runEvaluator(this.pi, ctx, "GoalJudge", buildJudgePrompt({
        objective: initial.objective,
        criteria: initial.criteria,
        evidence: evidenceText,
        iteration: initial.cycle,
        capabilities: this.capabilities(),
      }), judgeAbort.signal);
      if (judge.failure || judge.aborted) throw new Error(judge.failure ?? "GoalJudge aborted");
      judgeOutput = judge.output;
    } catch (error) {
      if (this.refreshLoopEvaluationState(ctx, token)) {
        this.blockLoop(this.loopState!, `GoalJudge failed for the fixed-point loop: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    } finally {
      if (this.evaluatorAbort === judgeAbort) this.evaluatorAbort = undefined;
    }

    if (!this.refreshLoopEvaluationState(ctx, token) || !this.loopState) return;
    const judgeVerdict = parseGoalVerdict(judgeOutput);
    if (!judgeVerdict) {
      this.blockLoop(this.loopState, "GoalJudge returned malformed output for the fixed-point loop.");
      return;
    }
    if (judgeVerdict.blocked || judgeVerdict.impossible) {
      this.blockLoop(this.loopState, judgeVerdict.reason);
      return;
    }
    if (!judgeVerdict.ok) {
      const previous = this.judgeNoProgress.get(initial.loopId);
      const judgeProgress = previous?.fingerprint === evidenceFingerprint
        ? { fingerprint: evidenceFingerprint, count: previous.count + 1 }
        : { fingerprint: evidenceFingerprint, count: 1 };
      this.judgeNoProgress.set(initial.loopId, judgeProgress);
      if (judgeProgress.count >= settings.repeatedFingerprintThreshold) {
        this.blockLoop(this.loopState, `No progress: GoalJudge evidence fingerprint repeated ${judgeProgress.count} times.`);
        return;
      }
      const continuing: GoalStateV2 = {
        ...this.loopState,
        phase: "implementing",
        updatedAt: Date.now(),
        reasons: { ...this.loopState.reasons, stagnation: judgeVerdict.reason },
      };
      this.persistLoop(continuing);
      this.scheduleLoopBootstrap(ctx, continuing, this.sessionEpoch);
      return;
    }

    this.judgeNoProgress.delete(initial.loopId);
    const verifying: GoalStateV2 = { ...this.loopState, phase: "verifying", updatedAt: Date.now() };
    this.persistLoop(verifying);
    const verifyToken = { ...token };
    let verifierOutput: string;
    const verifierAbort = new AbortController();
    try {
      this.evaluatorAbort = verifierAbort;
      const original = await loadVerifiedOriginalPlan({
        loopId: verifying.loopId,
        provenance: verifying.plan,
        agentDir: this.loopStorageAgentDir(verifying),
        maxBytes: settings.maxPlanBytes,
      });
      let correction;
      if (verifying.verifier?.correctionPath && verifying.verifier.correctionHash) {
        const artifact = await loadVerifiedCorrectionPlan({
          loopId: verifying.loopId,
          cycle: verifying.cycle,
          path: verifying.verifier.correctionPath,
          correctionHash: verifying.verifier.correctionHash,
          maxCycles: verifying.maxCycles,
          agentDir: this.loopStorageAgentDir(verifying),
          maxBytes: settings.maxCorrectionBytes,
        });
        correction = { path: artifact.path, hash: artifact.hash, content: artifact.content };
      }
      const verifier = await runEvaluator(this.pi, ctx, "GoalVerifier", buildVerifierPrompt({
        objective: verifying.objective,
        criteria: verifying.criteria,
        judgeReason: judgeVerdict.reason,
        judgeEvidence: judgeVerdict.evidence,
        loop: {
          loopId: verifying.loopId,
          generation: verifying.generation,
          contextEpoch: verifying.contextEpoch,
          cycle: verifying.cycle,
          strategy: verifying.strategy,
          originalPlan: { path: original.path, hash: original.hash, content: original.content },
          correction,
          evidenceFingerprint,
          previousRepositoryFingerprint: verifying.verifier?.repositoryFingerprint,
        },
      }), verifierAbort.signal);
      if (verifier.failure || verifier.aborted) throw new Error(verifier.failure ?? "GoalVerifier aborted");
      verifierOutput = verifier.output;
    } catch (error) {
      if (this.refreshLoopEvaluationState(ctx, verifyToken)) {
        this.blockLoop(this.loopState!, `GoalVerifier was inconclusive: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    } finally {
      if (this.evaluatorAbort === verifierAbort) this.evaluatorAbort = undefined;
    }

    if (!this.refreshLoopEvaluationState(ctx, verifyToken, ["verifying"]) || !this.loopState) return;
    const parsed = parseVerifierVerdict(verifierOutput);
    if (!parsed || !("outcome" in parsed)) {
      this.blockLoop(this.loopState, "GoalVerifier returned malformed fixed-point output.", {
        outcome: "inconclusive",
        evidenceFingerprint,
      });
      return;
    }
    await this.applyLoopVerifierVerdict(ctx, verifyToken, parsed, evidenceFingerprint, settings.maxCorrectionBytes, settings.repeatedFingerprintThreshold);
  }

  private async applyLoopVerifierVerdict(
    ctx: ExtensionContext,
    token: { epoch: number; loopId: string; generation: number; cycle: number; contextEpoch: number },
    verdict: GoalLoopVerifierVerdict,
    evidenceFingerprint: string,
    maxCorrectionBytes: number,
    repeatedFingerprintThreshold: number,
  ): Promise<void> {
    if (!this.refreshLoopEvaluationState(ctx, token, ["verifying"]) || !this.loopState) return;
    const current = this.loopState;
    const repositoryFingerprint = verdict.repositoryFingerprint;
    const suppliedEvidenceFingerprint = verdict.evidenceFingerprint ?? evidenceFingerprint;
    if (!repositoryFingerprint) {
      this.blockLoop(current, "GoalVerifier did not provide a trustworthy repository snapshot fingerprint.", {
        outcome: "inconclusive",
        evidenceFingerprint: suppliedEvidenceFingerprint,
      });
      return;
    }
    if (verdict.snapshot?.originalPlanHash !== undefined
      && verdict.snapshot.originalPlanHash !== current.plan.snapshotHash) {
      this.blockLoop(current, "GoalVerifier reported a snapshot different from the immutable original plan.", {
        outcome: "inconclusive",
        repositoryFingerprint,
        evidenceFingerprint: suppliedEvidenceFingerprint,
      });
      return;
    }
    if (verdict.snapshot?.correctionHash !== undefined
      && verdict.snapshot.correctionHash !== current.verifier?.correctionHash) {
      this.blockLoop(current, "GoalVerifier reported a snapshot different from the immutable corrective plan.", {
        outcome: "inconclusive",
        repositoryFingerprint,
        evidenceFingerprint: suppliedEvidenceFingerprint,
      });
      return;
    }
    if (verdict.strategy !== undefined && verdict.strategy !== current.strategy) {
      this.blockLoop(current, "GoalVerifier attempted to change the approved loop execution strategy.", {
        outcome: "inconclusive",
        repositoryFingerprint,
        evidenceFingerprint: suppliedEvidenceFingerprint,
      });
      return;
    }
    if (current.strategy === "PREWALK" && verdict.outcome === "replan" && verdict.prewalk?.required !== true) {
      this.blockLoop(current, "PREWALK strategy is unsafe without an explicit PREWALK continuation requirement.", {
        outcome: "inconclusive",
        repositoryFingerprint,
        evidenceFingerprint: suppliedEvidenceFingerprint,
      });
      return;
    }
    if (current.strategy !== "PREWALK" && verdict.prewalk !== undefined) {
      this.blockLoop(current, "Verifier PREWALK requirement conflicts with the approved loop strategy.", {
        outcome: "inconclusive",
        repositoryFingerprint,
        evidenceFingerprint: suppliedEvidenceFingerprint,
      });
      return;
    }

    const baseVerifier = {
      outcome: verdict.outcome,
      repositoryFingerprint,
      evidenceFingerprint: suppliedEvidenceFingerprint,
    } as const;
    if (verdict.outcome === "pass") {
      const completed: GoalStateV2 = {
        ...current,
        phase: "completed",
        verifier: baseVerifier,
        updatedAt: Date.now(),
      };
      this.persistLoop(completed);
      this.notifyLoop(completed, `Goal loop completed: ${verdict.reason}`);
      return;
    }
    if (verdict.outcome === "blocked" || verdict.outcome === "inconclusive") {
      this.blockLoop(current, `GoalVerifier ${verdict.outcome}: ${verdict.reason}`, baseVerifier);
      return;
    }
    if (!verdict.correction) {
      this.blockLoop(current, "GoalVerifier requested a replan without an actionable corrective plan.", {
        ...baseVerifier,
        outcome: "inconclusive",
      });
      return;
    }
    if (current.cycle >= current.maxCycles) {
      this.blockLoop(current, `Maximum corrective cycle limit reached (${current.maxCycles}).`, {
        ...baseVerifier,
        outcome: "inconclusive",
      });
      return;
    }
    if (current.strategy === "PREWALK" && !this.prewalkReadyLoops.has(current.loopId)) {
      this.blockLoop(current, "PREWALK corrective execution is not safely approved.", {
        ...baseVerifier,
        outcome: "inconclusive",
      });
      return;
    }

    // Publish the lifecycle phase before the filesystem operation. No verifier
    // outcome is recorded yet because a replan outcome is valid only together
    // with its immutable correction artifact pair.
    const replanning: GoalStateV2 = { ...current, phase: "replanning", updatedAt: Date.now() };
    this.persistLoop(replanning);
    let correction;
    try {
      correction = await persistCorrectionPlan({
        loopId: current.loopId,
        cycle: current.cycle + 1,
        content: verdict.correction,
        maxCycles: current.maxCycles,
        agentDir: this.loopStorageAgentDir(current),
        maxBytes: maxCorrectionBytes,
      });
    } catch (error) {
      if (this.refreshLoopEvaluationState(ctx, token, ["replanning"])) {
        this.blockLoop(this.loopState!, `Unable to persist the corrective plan: ${error instanceof Error ? error.message : String(error)}`, {
          ...baseVerifier,
          outcome: "inconclusive",
        });
      }
      return;
    }
    if (!this.refreshLoopEvaluationState(ctx, token, ["replanning"]) || !this.loopState) return;

    const fingerprintKey = `${current.loopId}\u0000${repositoryFingerprint}\u0000${correction.hash}`;
    const remembered = this.fingerprintCounts.get(fingerprintKey)
      ?? (current.verifier?.outcome === "replan"
        && current.verifier.repositoryFingerprint === repositoryFingerprint
        && current.verifier.correctionHash === correction.hash
        ? 1
        : 0);
    const count = remembered + 1;
    this.fingerprintCounts.set(fingerprintKey, count);
    const correctiveVerifier: GoalStateV2["verifier"] = {
      ...baseVerifier,
      outcome: "replan",
      correctionPath: correction.path,
      correctionHash: correction.hash,
    };
    if (count >= repeatedFingerprintThreshold) {
      this.blockLoop(this.loopState!, `No progress: repository/correction fingerprint repeated ${count} times.`, correctiveVerifier);
      return;
    }

    const nextCandidate: GoalStateV2 = {
      ...replanning,
      phase: "implementing",
      cycle: current.cycle + 1,
      contextEpoch: current.contextEpoch + 1,
      verifier: correctiveVerifier,
      updatedAt: Date.now(),
      reasons: { ...current.reasons, stagnation: undefined },
      epochMarker: undefined,
    };
    if (nextCandidate.reasons && !nextCandidate.reasons.pause && !nextCandidate.reasons.block) nextCandidate.reasons = undefined;
    try {
      const marked = await this.markLoopEpoch(
        ctx,
        nextCandidate,
        loadGoalLoopSettings(ctx.cwd).maxBootstrapBytes,
      );
      if (!this.refreshLoopEvaluationState(ctx, token, ["replanning"])) return;
      this.persistLoop(marked.state);
      this.scheduleLoopBootstrap(ctx, marked.state, this.sessionEpoch);
    } catch (error) {
      if (this.refreshLoopEvaluationState(ctx, token, ["replanning"])) {
        this.blockLoop(this.loopState!, `Unable to establish the corrective context epoch: ${error instanceof Error ? error.message : String(error)}`, {
          ...correctiveVerifier,
          outcome: "inconclusive",
        });
      }
    }
  }

  private async evaluateOnce(ctx: ExtensionContext): Promise<void> {
    this.syncBranch(ctx);
    if (this.loopContinuationToken) return;
    if (this.loopState && LOOP_PHASE_ACTIVE.includes(this.loopState.phase)) {
      await this.evaluateLoopOnce(ctx, this.loopState);
      return;
    }
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
    const judgeAbort = new AbortController();
    this.evaluatorAbort = judgeAbort;

    let judgeOutput: string;
    try {
      const judge = await runEvaluator(this.pi, ctx, "GoalJudge", buildJudgePrompt({
        objective: current.objective,
        criteria: current.criteria,
        evidence: evidenceText,
        previousReason: current.lastReason,
        iteration: current.iteration,
        capabilities: this.capabilities(),
      }), judgeAbort.signal);
      if (judge.failure || judge.aborted) throw new Error(judge.failure ?? "GoalJudge aborted");
      judgeOutput = judge.output;
    } catch (error) {
      await this.evaluatorFailure(ctx, epoch, current, error instanceof Error ? error.message : String(error));
      return;
    } finally {
      if (this.evaluatorAbort === judgeAbort) this.evaluatorAbort = undefined;
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
      const verifierAbort = new AbortController();
      try {
        this.evaluatorAbort = verifierAbort;
        const verifier = await runEvaluator(this.pi, ctx, "GoalVerifier", buildVerifierPrompt({
          objective: current.objective,
          criteria: current.criteria,
          judgeReason: verdict.reason,
          judgeEvidence: verdict.evidence,
        }), verifierAbort.signal);
        if (verifier.failure || verifier.aborted) throw new Error(verifier.failure ?? "GoalVerifier aborted");
        const parsed = parseVerifierVerdict(verifier.output);
        if (!parsed || "outcome" in parsed) throw new Error("GoalVerifier returned malformed V1 output.");
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
        if (this.evaluatorAbort === verifierAbort) this.evaluatorAbort = undefined;
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
