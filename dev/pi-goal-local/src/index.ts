import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildGoalEvidence,
  GOAL_JUDGE_TIMEOUT_MS,
  GOAL_STATE_TYPE,
  goalBudgetExhausted,
  latestGoalState,
  MAX_GOAL_CONDITION_LENGTH,
  MAX_GOAL_ITERATIONS,
  parseGoalVerdict,
  type GoalState,
  type GoalStatus,
} from "./core.js";

interface RuntimeTaskOwner {
  goalId: string;
  goalGeneration: number;
}

interface RuntimeTaskHub {
  hasRunning(owner?: RuntimeTaskOwner): boolean;
  setDefaultOwner(owner: RuntimeTaskOwner | undefined): void;
  clearDefaultOwner(expected?: RuntimeTaskOwner): void;
  withOwner<T>(owner: RuntimeTaskOwner | undefined, fn: () => T): T;
}

interface RuntimeTaskRegistry {
  getSession(sessionId: string): RuntimeTaskHub | undefined;
}

interface AgentRecordLike {
  status: string;
  result?: string;
  error?: string;
  resultConsumed?: boolean;
  promise?: Promise<unknown>;
  startGate?: Promise<void>;
  abortController?: AbortController;
}

interface AgentRegistry {
  spawn(
    pi: unknown,
    ctx: unknown,
    type: string,
    prompt: string,
    options: Record<string, unknown>,
  ): string;
  getRecord(id: string): AgentRecordLike | undefined;
}

const RUNTIME_REGISTRY_KEY = Symbol.for("pi-runtime-tasks:registry:v2");
const AGENT_REGISTRY_KEY = Symbol.for("pi-subagents:manager");
const GOAL_STATUS_MESSAGE = "pi-goal-status";
const GOAL_FEEDBACK_MESSAGE = "pi-goal-feedback";

function ownerFor(state: GoalState): RuntimeTaskOwner {
  return { goalId: state.id, goalGeneration: state.generation };
}

function textStatus(state: GoalState | undefined): string {
  if (!state) return "No goal has been set in this session.";
  const reason = state.lastReason ? ` — ${state.lastReason}` : "";
  return `${state.status.toUpperCase()}: ${state.condition} (${state.iterations}/${MAX_GOAL_ITERATIONS})${reason}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Goal evaluator timed out")), timeoutMs);
    timer.unref?.();
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForJudge(record: AgentRecordLike): Promise<void> {
  if (record.startGate) await record.startGate;
  if (record.promise) await record.promise;
}

export default function goalExtension(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let state: GoalState | undefined;
  let latestState: GoalState | undefined;
  let lastGeneration = 0;
  let activeJudge: AgentRecordLike | undefined;
  let evaluationPromise: Promise<void> | undefined;
  let queuedEvaluationContext: ExtensionContext | undefined;

  const runtimeRegistry = (): RuntimeTaskRegistry | undefined =>
    ((globalThis as unknown as Record<PropertyKey, unknown>)[RUNTIME_REGISTRY_KEY] as RuntimeTaskRegistry | undefined);
  const hub = (): RuntimeTaskHub | undefined =>
    sessionId ? runtimeRegistry()?.getSession(sessionId) : undefined;
  const agents = (): AgentRegistry | undefined =>
    ((globalThis as unknown as Record<PropertyKey, unknown>)[AGENT_REGISTRY_KEY] as AgentRegistry | undefined);

  const persist = (next: GoalState): void => {
    latestState = next;
    lastGeneration = Math.max(lastGeneration, next.generation);
    pi.appendEntry(GOAL_STATE_TYPE, next);
  };

  const armOwner = (next: GoalState): RuntimeTaskOwner => {
    const owner = ownerFor(next);
    hub()?.setDefaultOwner(owner);
    return owner;
  };

  const setActiveState = (next: GoalState): void => {
    state = next;
    persist(next);
    armOwner(next);
  };

  const transition = (status: GoalStatus, reason: string): GoalState | undefined => {
    if (!state) return undefined;
    const next: GoalState = {
      ...state,
      status,
      lastReason: reason,
      updatedAt: Date.now(),
    };
    state = status === "active" ? next : undefined;
    persist(next);
    if (status !== "active") hub()?.clearDefaultOwner(ownerFor(next));
    return next;
  };

  const runOwned = (owner: RuntimeTaskOwner, fn: () => void): void => {
    const currentHub = hub();
    if (currentHub) {
      currentHub.setDefaultOwner(owner);
      currentHub.withOwner(owner, fn);
    } else {
      fn();
    }
  };

  const recordInfrastructureFailure = (current: GoalState, reason: string): void => {
    if (!state || state.id !== current.id || state.generation !== current.generation) return;
    state = { ...current, lastReason: reason, updatedAt: Date.now() };
    persist(state);
    hub()?.setDefaultOwner(ownerFor(state));
    ctx?.ui.notify(reason, "warning");
  };

  const cancelJudge = (): void => {
    activeJudge?.abortController?.abort();
    activeJudge = undefined;
  };

  const evaluateOnce = async (settledCtx: ExtensionContext): Promise<void> => {
    if (!state) return;
    const current = state;
    const currentOwner = ownerFor(current);
    const currentHub = hub();

    currentHub?.clearDefaultOwner(currentOwner);
    if (currentHub?.hasRunning(currentOwner)) return;

    if (goalBudgetExhausted(current)) {
      const paused = transition("paused", "Goal budget exhausted; use /goal resume to continue.");
      if (paused) {
        pi.sendMessage({
          customType: GOAL_STATUS_MESSAGE,
          content: `Goal paused: ${paused.lastReason}`,
          display: true,
          details: { goalId: paused.id, generation: paused.generation, status: paused.status },
        });
      }
      return;
    }

    const agentRegistry = agents();
    if (!agentRegistry) {
      recordInfrastructureFailure(current, "Goal evaluator is unavailable; goal retained.");
      return;
    }

    const prompt = [
      "Condition:",
      current.condition,
      "",
      "Transcript evidence:",
      buildGoalEvidence(settledCtx.sessionManager.buildContextEntries()),
      "",
      "Return the required JSON verdict.",
    ].join("\n");

    let judgeId: string;
    try {
      const spawnJudge = () => agentRegistry.spawn(pi, settledCtx, "GoalJudge", prompt, {
        description: "Evaluate active goal",
        isBackground: true,
        maxTurns: 1,
        isolated: true,
      });
      judgeId = currentHub ? currentHub.withOwner(undefined, spawnJudge) : spawnJudge();
    } catch (error) {
      recordInfrastructureFailure(
        current,
        `Goal evaluator failed to start; goal retained: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const judge = agentRegistry.getRecord(judgeId);
    if (!judge) {
      recordInfrastructureFailure(current, "Goal evaluator record was unavailable; goal retained.");
      return;
    }

    activeJudge = judge;
    judge.resultConsumed = true;
    try {
      await withTimeout(waitForJudge(judge), GOAL_JUDGE_TIMEOUT_MS);
    } catch (error) {
      judge.abortController?.abort();
      recordInfrastructureFailure(
        current,
        `Goal evaluator failed; goal retained: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    } finally {
      if (activeJudge === judge) activeJudge = undefined;
    }

    if (!state || state.id !== current.id || state.generation !== current.generation) return;

    const verdict = parseGoalVerdict(judge.result);
    if (!verdict) {
      const suffix = judge.error ? `: ${judge.error}` : "";
      recordInfrastructureFailure(current, `Goal evaluator returned invalid output; goal retained${suffix}.`);
      return;
    }

    const evaluated: GoalState = {
      ...current,
      iterations: current.iterations + 1,
      updatedAt: Date.now(),
      lastReason: verdict.reason,
    };
    state = evaluated;
    persist(evaluated);

    if (verdict.ok || verdict.impossible) {
      const terminal = transition(verdict.ok ? "completed" : "failed", verdict.reason);
      if (!terminal) return;
      pi.sendMessage({
        customType: GOAL_STATUS_MESSAGE,
        content: `Goal ${verdict.ok ? "completed" : "failed"}: ${verdict.reason}`,
        display: true,
        details: {
          goalId: terminal.id,
          generation: terminal.generation,
          status: terminal.status,
          impossible: verdict.impossible === true,
        },
      });
      return;
    }

    if (goalBudgetExhausted(evaluated)) {
      const paused = transition("paused", "Goal budget exhausted; use /goal resume to continue.");
      if (paused) {
        pi.sendMessage({
          customType: GOAL_STATUS_MESSAGE,
          content: `Goal paused: ${paused.lastReason}`,
          display: true,
          details: { goalId: paused.id, generation: paused.generation, status: paused.status },
        });
      }
      return;
    }

    runOwned(currentOwner, () => {
      pi.sendMessage(
        {
          customType: GOAL_FEEDBACK_MESSAGE,
          content: `The active goal is not yet satisfied. Continue working toward it. Evaluator reason: ${verdict.reason}`,
          display: false,
          details: { goalId: current.id, generation: current.generation },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
  };

  const requestEvaluation = (settledCtx: ExtensionContext): Promise<void> => {
    queuedEvaluationContext = settledCtx;
    if (evaluationPromise) return evaluationPromise;

    evaluationPromise = (async () => {
      while (queuedEvaluationContext) {
        const nextCtx = queuedEvaluationContext;
        queuedEvaluationContext = undefined;
        await evaluateOnce(nextCtx);
      }
    })().finally(() => {
      evaluationPromise = undefined;
      if (queuedEvaluationContext) void requestEvaluation(queuedEvaluationContext);
    });
    return evaluationPromise;
  };

  pi.on("session_start", (_event, nextCtx) => {
    ctx = nextCtx;
    sessionId = nextCtx.sessionManager.getSessionId();
    latestState = latestGoalState(nextCtx.sessionManager.getBranch());
    lastGeneration = latestState?.generation ?? 0;
    state = latestState?.status === "active" ? latestState : undefined;
    if (state) armOwner(state);
  });

  pi.on("session_shutdown", () => {
    cancelJudge();
    if (state) hub()?.clearDefaultOwner(ownerFor(state));
    ctx = undefined;
    sessionId = undefined;
    state = undefined;
    queuedEvaluationContext = undefined;
  });

  pi.registerCommand("goal", {
    description: "Set, show, resume, or clear a persistent completion goal",
    handler: async (args, commandCtx) => {
      const value = (args ?? "").trim();
      if (!value) {
        commandCtx.ui.notify(textStatus(state ?? latestState), "info");
        return;
      }

      if (value === "clear" || value === "off") {
        const current = state ?? latestState;
        if (!current || current.status === "cleared") {
          commandCtx.ui.notify("No active or paused goal to clear.", "info");
          return;
        }

        cancelJudge();
        const cleared: GoalState = {
          ...current,
          generation: lastGeneration + 1,
          status: "cleared",
          updatedAt: Date.now(),
          lastReason: "Cleared by user",
        };
        state = undefined;
        persist(cleared);
        hub()?.clearDefaultOwner();
        commandCtx.ui.notify("Goal cleared.", "info");
        return;
      }

      if (value === "resume") {
        if (!latestState || latestState.status !== "paused") {
          commandCtx.ui.notify("There is no paused goal to resume.", "warning");
          return;
        }

        cancelJudge();
        const resumed: GoalState = {
          ...latestState,
          generation: lastGeneration + 1,
          status: "active",
          iterations: 0,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          lastReason: undefined,
        };
        setActiveState(resumed);
        runOwned(ownerFor(resumed), () => {
          pi.sendUserMessage(`Continue working autonomously until this condition is satisfied:\n\n${resumed.condition}`);
        });
        return;
      }

      if (value.length > MAX_GOAL_CONDITION_LENGTH) {
        commandCtx.ui.notify(
          `Goal is too long (maximum ${MAX_GOAL_CONDITION_LENGTH} characters).`,
          "error",
        );
        return;
      }

      cancelJudge();
      const next: GoalState = {
        id: randomUUID(),
        generation: lastGeneration + 1,
        condition: value,
        status: "active",
        iterations: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      setActiveState(next);
      runOwned(ownerFor(next), () => {
        pi.sendUserMessage(`Work autonomously until this condition is satisfied:\n\n${value}`);
      });
    },
  });

  pi.on("agent_settled", (_event, settledCtx) => requestEvaluation(settledCtx));
}
