import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalController } from "../src/controller.js";
import { GOAL_STATE_TYPE, type GoalStateV1 } from "../src/types.js";

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
  const pi = {
    appendEntry: vi.fn((customType: string, data: GoalStateV1) => {
      branch.push({ type: "custom", customType, data });
    }),
    sendMessage: vi.fn(),
  } as any;
  const ctx = {
    cwd: "/repo",
    isIdle: () => true,
    hasPendingMessages: () => false,
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
  };
}

function goalEntries(entries: any[]): GoalStateV1[] {
  return entries
    .filter(entry => entry.type === "custom" && entry.customType === GOAL_STATE_TYPE)
    .map(entry => entry.data as GoalStateV1);
}

beforeEach(() => {
  subagents.hasActiveSubagents.mockReset();
  subagents.hasActiveSubagents.mockReturnValue(false);
  subagents.runEvaluator.mockReset();
});

describe("goal controller lifecycle guards", () => {
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
});
