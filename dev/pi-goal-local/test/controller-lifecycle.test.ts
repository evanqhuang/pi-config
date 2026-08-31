import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalController } from "../src/controller.js";
import {
  GOAL_CONTINUE_MESSAGE,
  GOAL_STATE_TYPE,
  GOAL_SUBAGENT_UPDATE_MESSAGE,
  type GoalStateV1,
} from "../src/types.js";

const subagents = vi.hoisted(() => ({
  hasActiveSubagents: vi.fn(() => false),
  runEvaluator: vi.fn(),
}));

vi.mock("../src/subagents.js", () => subagents);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function harness() {
  let branch: any[] = [];
  let idle = true;
  let pendingMessages = false;
  const pi = {
    appendEntry: vi.fn((customType: string, data: GoalStateV1) => {
      branch.push({ type: "custom", customType, data });
    }),
    sendMessage: vi.fn(),
  } as any;
  const ctx = {
    cwd: "/repo",
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    sessionManager: {
      getBranch: () => branch,
      buildContextEntries: () => branch,
      getSessionId: () => "session-1",
    },
  } as any;
  return {
    pi,
    ctx,
    controller: new GoalController(pi),
    branch: () => branch,
    setBranch: (next: any[]) => { branch = next; },
    setIdle: (next: boolean) => { idle = next; },
    setPendingMessages: (next: boolean) => { pendingMessages = next; },
  };
}

function goalEntries(entries: any[]): GoalStateV1[] {
  return entries
    .filter(entry => entry.type === "custom" && entry.customType === GOAL_STATE_TYPE)
    .map(entry => entry.data as GoalStateV1);
}

function activeGoal(overrides: Partial<GoalStateV1> = {}): GoalStateV1 {
  return {
    schemaVersion: 1,
    id: "goal-1",
    generation: 1,
    objective: "ship feature",
    criteria: ["tests pass"],
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    iteration: 0,
    consecutiveJudgeFailures: 0,
    verificationFailures: 0,
    noProgressCycles: 0,
    ...overrides,
  };
}

function continueMessages(pi: any): any[] {
  return pi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === GOAL_CONTINUE_MESSAGE);
}

beforeEach(() => {
  subagents.hasActiveSubagents.mockReset();
  subagents.hasActiveSubagents.mockReturnValue(false);
  subagents.runEvaluator.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("goal controller lifecycle guards", () => {
  it("restores an active goal as paused until explicitly resumed", () => {
    const { controller, ctx, pi, branch, setBranch } = harness();
    const activeGoal: GoalStateV1 = {
      schemaVersion: 1,
      id: "goal-1",
      generation: 1,
      objective: "ship feature",
      criteria: ["tests pass"],
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      iteration: 0,
      consecutiveJudgeFailures: 0,
      verificationFailures: 0,
      noProgressCycles: 0,
    };
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal }]);

    controller.restore(ctx);

    expect(controller.current?.status).toBe("paused");
    expect(goalEntries(branch()).at(-1)).toMatchObject({
      status: "paused",
      terminalReason: "Paused when the session was reopened.",
    });
    expect(pi.sendMessage).not.toHaveBeenCalled();

    controller.resume(ctx);

    expect(controller.current?.status).toBe("active");
    expect(goalEntries(branch()).at(-1)?.status).toBe("active");
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("resumes a ready selected active branch exactly once", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);

    controller.restoreSelectedBranch(ctx);
    expect(continueMessages(pi)).toHaveLength(0);

    vi.advanceTimersByTime(0);
    expect(continueMessages(pi)).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(continueMessages(pi)).toHaveLength(1);
  });

  it("retains a busy wake until agent_settled reattempts it", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    setIdle(false);

    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);
    expect(continueMessages(pi)).toHaveLength(0);

    setIdle(true);
    expect(controller.retryPendingWake(ctx)).toBe(true);
    expect(continueMessages(pi)).toHaveLength(1);
    controller.retryPendingWake(ctx);
    expect(continueMessages(pi)).toHaveLength(1);
  });

  it("does not start ordinary evaluation while a pending wake is undeliverable", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    setIdle(false);

    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);
    expect(controller.retryPendingWake(ctx)).toBe(true);

    controller.requestEvaluation(ctx);

    expect(subagents.runEvaluator).not.toHaveBeenCalled();
    expect(continueMessages(pi)).toHaveLength(0);
  });

  it("keeps a capped wake available for later event-driven readiness", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    setIdle(false);

    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(10_000);
    expect(continueMessages(pi)).toHaveLength(0);
    expect(controller.retryPendingWake(ctx)).toBe(true);

    setIdle(true);
    expect(controller.retryPendingWake(ctx)).toBe(true);
    expect(continueMessages(pi)).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(continueMessages(pi)).toHaveLength(1);
  });

  it.each(["completed", "failed"] as const)("reattempts a subagent-busy wake after subagents:%s", event => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    subagents.hasActiveSubagents.mockReturnValue(true);

    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(10_000);
    expect(continueMessages(pi)).toHaveLength(0);

    subagents.hasActiveSubagents.mockReturnValue(false);
    controller.scheduleSubagentWake();
    expect(continueMessages(pi)).toHaveLength(1);
    expect(pi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === GOAL_SUBAGENT_UPDATE_MESSAGE)).toHaveLength(0);
    controller.scheduleSubagentWake();
    expect(continueMessages(pi)).toHaveLength(1);
    expect(event).toMatch(/completed|failed/);
  });

  it("still sends a generic subagent update when no resume wake is pending", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    controller.refresh(ctx);

    controller.scheduleSubagentWake();
    vi.advanceTimersByTime(250);

    expect(continueMessages(pi)).toHaveLength(0);
    expect(pi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === GOAL_SUBAGENT_UPDATE_MESSAGE)).toHaveLength(1);
  });

  it("suppresses a stale generic wake after branch, goal id, or generation changes", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    const genericMessages = () => pi.sendMessage.mock.calls.filter(
      ([message]: any[]) => message.customType === GOAL_SUBAGENT_UPDATE_MESSAGE,
    );

    const firstBranchEntry = { type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() };
    setBranch([firstBranchEntry]);
    controller.refresh(ctx);
    controller.scheduleSubagentWake();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    vi.advanceTimersByTime(250);
    expect(genericMessages()).toHaveLength(0);

    const goalIdEntry = { type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() };
    setBranch([goalIdEntry]);
    controller.refresh(ctx);
    controller.scheduleSubagentWake();
    goalIdEntry.data = activeGoal({ id: "goal-2" });
    vi.advanceTimersByTime(250);
    expect(genericMessages()).toHaveLength(0);

    const generationEntry = { type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() };
    setBranch([generationEntry]);
    controller.refresh(ctx);
    controller.scheduleSubagentWake();
    generationEntry.data = activeGoal({ generation: 2 });
    vi.advanceTimersByTime(250);
    expect(genericMessages()).toHaveLength(0);
  });

  it("coalesces repeated lifecycle wake events into one continuation", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    setIdle(false);
    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);

    for (let i = 0; i < 10; i += 1) {
      controller.retryPendingWake(ctx);
      controller.scheduleSubagentWake();
    }
    setIdle(true);
    controller.retryPendingWake(ctx);
    controller.scheduleSubagentWake();
    expect(continueMessages(pi)).toHaveLength(1);
  });

  it("invalidates the first pending wake when navigation selects a second branch", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal({ objective: "first branch" }) }]);
    controller.restoreSelectedBranch(ctx);

    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal({ objective: "second branch" }) }]);
    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);

    expect(continueMessages(pi)).toHaveLength(1);
    expect(continueMessages(pi)[0][0]).toMatchObject({ content: expect.stringContaining("second branch") });
  });

  it.each(["pause", "stop", "clear"] as const)("suppresses a stale wake after /goal %s", action => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    controller.restoreSelectedBranch(ctx);
    controller[action](ctx);
    vi.runOnlyPendingTimers();

    expect(continueMessages(pi)).toHaveLength(0);
  });

  it("suppresses a stale wake after replacement or shutdown", () => {
    vi.useFakeTimers();
    const replacement = harness();
    replacement.setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    replacement.controller.restoreSelectedBranch(replacement.ctx);
    replacement.controller.start(replacement.ctx, "replacement", []);
    vi.runOnlyPendingTimers();
    expect(continueMessages(replacement.pi)).toHaveLength(0);

    const shutdown = harness();
    shutdown.setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    shutdown.controller.restoreSelectedBranch(shutdown.ctx);
    shutdown.controller.shutdown();
    vi.runOnlyPendingTimers();
    expect(continueMessages(shutdown.pi)).toHaveLength(0);
  });

  it("suppresses a wake when the selected branch no longer matches", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    controller.restoreSelectedBranch(ctx);

    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal({ status: "paused" }) }]);
    controller.retryPendingWake(ctx);
    vi.runOnlyPendingTimers();

    expect(continueMessages(pi)).toHaveLength(0);
  });

  it.each([
    ["pause", "paused"],
    ["stop", "stopped"],
  ] as const)("does not undo /goal %s when an aborted judge settles late", async (action, expectedStatus) => {
    const { controller, ctx, branch } = harness();
    subagents.runEvaluator.mockImplementationOnce((_pi, _ctx, _type, _prompt, signal?: AbortSignal) => new Promise(resolve => {
      signal?.addEventListener("abort", () => resolve({
        output: "",
        failure: "aborted",
        aborted: true,
        steered: false,
      }), { once: true });
    }));

    controller.start(ctx, "ship feature", ["tests pass"]);
    controller.requestEvaluation(ctx);
    await vi.waitFor(() => expect(subagents.runEvaluator).toHaveBeenCalledTimes(1));

    controller[action](ctx);
    const entryCountAfterAction = goalEntries(branch()).length;
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(controller.current?.status).toBe(expectedStatus);
    expect(goalEntries(branch()).at(-1)?.status).toBe(expectedStatus);
    expect(goalEntries(branch())).toHaveLength(entryCountAfterAction);
  });

  it("drops a stale judge verdict when /tree selects another branch with the same goal generation", async () => {
    const { controller, ctx, branch, setBranch } = harness();
    const judge = deferred<{ output: string; aborted: boolean; steered: boolean }>();
    subagents.runEvaluator.mockReturnValueOnce(judge.promise);

    controller.start(ctx, "ship feature", ["tests pass"]);
    const sharedGoal = { ...controller.current! };
    controller.requestEvaluation(ctx);
    await vi.waitFor(() => expect(subagents.runEvaluator).toHaveBeenCalledTimes(1));

    controller.prepareForNavigation();
    const selectedBranch = [{ type: "custom", customType: GOAL_STATE_TYPE, data: sharedGoal }];
    setBranch(selectedBranch);
    controller.restoreSelectedBranch(ctx);

    judge.resolve({
      output: JSON.stringify({ ok: true, reason: "old branch looked complete" }),
      aborted: false,
      steered: false,
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(subagents.runEvaluator).toHaveBeenCalledTimes(1);
    expect(controller.current?.status).toBe("active");
    expect(goalEntries(branch()).some(state => state.status === "completed")).toBe(false);
  });

  it("drops a stale verifier verdict after navigation", async () => {
    const { controller, ctx, branch } = harness();
    const verifier = deferred<{ output: string; aborted: boolean; steered: boolean }>();
    subagents.runEvaluator
      .mockReturnValueOnce(Promise.resolve({
        output: JSON.stringify({ ok: true, reason: "judge accepts" }),
        aborted: false,
        steered: false,
      }))
      .mockReturnValueOnce(verifier.promise);

    controller.start(ctx, "ship feature", ["tests pass"]);
    controller.requestEvaluation(ctx);
    await vi.waitFor(() => expect(subagents.runEvaluator).toHaveBeenCalledTimes(2));

    controller.prepareForNavigation();
    verifier.resolve({
      output: JSON.stringify({ ok: true, reason: "old verifier accepts" }),
      aborted: false,
      steered: false,
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(controller.current?.status).toBe("active");
    expect(goalEntries(branch()).some(state => state.status === "completed")).toBe(false);
  });
});
