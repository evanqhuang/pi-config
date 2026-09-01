import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import goalExtension from "../src/index.js";
import { GoalController } from "../src/controller.js";
import { CLEARED_REASON } from "../src/state.js";
import {
  GOAL_CONTEXT_EPOCH_TYPE,
  GOAL_CONTINUE_MESSAGE,
  GOAL_STATE_TYPE,
  GOAL_STATE_V2_TYPE,
  GOAL_SUBAGENT_UPDATE_MESSAGE,
  type GoalStateV1,
  type GoalStateV2,
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
  let leafId: string | null = "leaf-0";
  let sessionId = "session-1";
  let nextLeaf = 1;
  let idle = true;
  let pendingMessages = false;
  const sessionManager = {
    getBranch: () => branch,
    buildContextEntries: () => branch,
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
  };
  const pi = {
    appendEntry: vi.fn((customType: string, data: GoalStateV1) => {
      branch.push({ type: "custom", customType, data });
      leafId = `leaf-${nextLeaf++}`;
    }),
    sendMessage: vi.fn(),
  } as any;
  const createContext = () => ({
    cwd: "/repo",
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    sessionManager,
  }) as any;
  const ctx = createContext();
  return {
    pi,
    ctx,
    createContext,
    controller: new GoalController(pi),
    branch: () => branch,
    setBranch: (next: any[], nextLeafId: string | null = `leaf-${nextLeaf++}`) => {
      branch = next;
      leafId = nextLeafId;
    },
    setSessionId: (next: string) => { sessionId = next; },
    setIdle: (next: boolean) => { idle = next; },
    setPendingMessages: (next: boolean) => { pendingMessages = next; },
  };
}

function extensionHarness() {
  let branch: any[] = [];
  let leafId: string | null = "leaf-0";
  let nextLeaf = 1;
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let goalCommand: ((args: string, ctx: any) => Promise<void>) | undefined;
  const sessionManager = {
    getBranch: () => branch,
    buildContextEntries: () => branch,
    getSessionId: () => "session-1",
    getLeafId: () => leafId,
  };
  const ctx = {
    cwd: "/repo",
    hasUI: false,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager,
  } as any;
  const pi = {
    on: vi.fn((event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler)),
    events: { on: vi.fn() },
    registerCommand: vi.fn((_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
      goalCommand = command.handler;
    }),
    appendEntry: vi.fn((customType: string, data: GoalStateV1) => {
      branch.push({ type: "custom", customType, data });
      leafId = `leaf-${nextLeaf++}`;
    }),
    sendMessage: vi.fn(),
  } as any;
  goalExtension(pi);
  return {
    pi,
    ctx,
    branch: () => branch,
    setBranch: (next: any[], nextLeafId: string | null) => {
      branch = next;
      leafId = nextLeafId;
    },
    emit: (event: string, data: any = { type: event }) => handlers.get(event)?.(data, { ...ctx }),
    runGoal: async (args: string) => goalCommand?.(args, { ui: { notify: vi.fn() } }),
  };
}

function goalEntries(entries: any[]): GoalStateV1[] {
  return entries
    .filter(entry => entry.type === "custom" && entry.customType === GOAL_STATE_TYPE)
    .map(entry => entry.data as GoalStateV1);
}

function loopEntries(entries: any[]): any[] {
  return entries
    .filter(entry => entry.type === "custom" && entry.customType === GOAL_STATE_V2_TYPE)
    .map(entry => entry.data);
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

function epochMessages(pi: any): any[] {
  return pi.sendMessage.mock.calls.filter(([message]: any[]) => message.customType === GOAL_CONTEXT_EPOCH_TYPE);
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
  it("blocks late agent settlement while tree navigation is in progress", async () => {
    const runtime = extensionHarness();
    runtime.emit("session_start", { type: "session_start", reason: "startup" });
    await runtime.runGoal("ship feature -- tests pass");
    runtime.pi.sendMessage.mockClear();
    subagents.runEvaluator.mockClear();

    runtime.emit("session_before_tree", {
      type: "session_before_tree",
      preparation: { targetId: "earlier-message", oldLeafId: "leaf-1" },
    });
    runtime.emit("agent_settled");

    expect(subagents.runEvaluator).not.toHaveBeenCalled();
    expect(continueMessages(runtime.pi)).toHaveLength(0);

    runtime.setBranch([{ id: "earlier-message", type: "message", parentId: null }], "earlier-message");
    runtime.emit("session_tree", { type: "session_tree", oldLeafId: "leaf-1", newLeafId: "earlier-message" });
    runtime.emit("agent_settled");

    expect(goalEntries(runtime.branch()).at(-1)).toMatchObject({
      status: "paused",
      terminalReason: "Paused after rewinding the conversation.",
    });
    expect(subagents.runEvaluator).not.toHaveBeenCalled();
    expect(continueMessages(runtime.pi)).toHaveLength(0);
  });

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

  it("carries an active goal onto an empty rewound branch as paused", () => {
    const { controller, ctx, pi, branch, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "source-leaf");

    controller.prepareForTreeNavigation(ctx);
    setBranch([{ id: "earlier-message", type: "message", parentId: null }], "target-leaf");
    controller.restoreSelectedBranch(ctx);

    expect(controller.current).toMatchObject({
      id: "goal-1",
      status: "paused",
      terminalReason: "Paused after rewinding the conversation.",
    });
    expect(goalEntries(branch())).toHaveLength(1);
    expect(continueMessages(pi)).toHaveLength(0);
    expect(subagents.runEvaluator).not.toHaveBeenCalled();

    controller.resume(ctx);

    expect(controller.current?.status).toBe("active");
    expect(goalEntries(branch()).at(-1)?.status).toBe("active");
    expect(continueMessages(pi)).toHaveLength(1);
  });

  it.each([
    ["active", activeGoal()],
    ["paused", activeGoal({ status: "paused" })],
    ["completed", activeGoal({ status: "completed" })],
    ["cleared", activeGoal({ status: "stopped", terminalReason: CLEARED_REASON })],
  ] as const)("keeps an existing %s target-branch marker authoritative", (_label, targetGoal) => {
    vi.useFakeTimers();
    const { controller, ctx, pi, branch, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal({ objective: "source" }) }], "source-leaf");
    controller.prepareForTreeNavigation(ctx);

    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: targetGoal }], "target-leaf");
    controller.restoreSelectedBranch(ctx);
    vi.runOnlyPendingTimers();

    expect(goalEntries(branch())).toHaveLength(1);
    expect(goalEntries(branch())[0]).toEqual(targetGoal);
    expect(controller.current).toEqual(_label === "cleared" ? undefined : targetGoal);
    expect(continueMessages(pi)).toHaveLength(_label === "active" ? 1 : 0);
  });

  it("consumes a tree carry once and clears it on non-tree navigation", () => {
    const oneShot = harness();
    oneShot.setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "source-leaf");
    oneShot.controller.prepareForTreeNavigation(oneShot.ctx);
    oneShot.setBranch([], "first-target");
    oneShot.controller.restoreSelectedBranch(oneShot.ctx);
    expect(goalEntries(oneShot.branch())).toHaveLength(1);

    oneShot.setBranch([], "second-target");
    oneShot.controller.restoreSelectedBranch(oneShot.ctx);
    expect(goalEntries(oneShot.branch())).toHaveLength(0);

    const cancelled = harness();
    cancelled.setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "source-leaf");
    cancelled.controller.prepareForTreeNavigation(cancelled.ctx);
    cancelled.controller.prepareForNavigation();
    cancelled.setBranch([], "target-leaf");
    cancelled.controller.restoreSelectedBranch(cancelled.ctx);
    expect(goalEntries(cancelled.branch())).toHaveLength(0);
  });

  it("reanchors a V2 loop once after explicit tree navigation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-tree-reanchor-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const planPath = join(root, "approved-plan.md");
    await writeFile(planPath, "# Approved plan\nImplement the feature.\n", "utf8");
    const runtime = harness();
    runtime.setIdle(false);

    try {
      const original = await runtime.controller.startLoop(runtime.ctx, "ship feature", ["tests pass"], {
        planPath,
        agentDir: root,
      });
      const originalPlan = original.plan;
      runtime.controller.prepareForTreeNavigation(runtime.ctx);
      runtime.setBranch([
        { id: "tree-target", type: "message", message: { role: "user", content: "selected branch" } },
      ], "tree-target");
      runtime.controller.restoreSelectedBranch(runtime.ctx);

      expect(runtime.controller.currentLoop).toMatchObject({
        phase: "paused",
        loopId: original.loopId,
        generation: original.generation,
        contextEpoch: 0,
        cycle: original.cycle,
      });
      expect(runtime.controller.currentLoop?.reanchor).toMatchObject({
        kind: "tree-selection",
        sessionId: "session-1",
        targetLeafId: "tree-target",
      });

      const reopened = new GoalController(runtime.pi);
      reopened.restore(runtime.ctx);
      const resumed = await reopened.resume(runtime.ctx) as GoalStateV2;
      expect(resumed).toMatchObject({
        phase: "implementing",
        loopId: original.loopId,
        generation: original.generation,
        contextEpoch: 1,
        cycle: original.cycle,
        plan: originalPlan,
      });
      expect(resumed.epochMarker?.id).not.toBe(original.epochMarker?.id);

      runtime.setIdle(true);
      reopened.retryPendingWake(runtime.ctx);
      await vi.waitFor(() => expect(epochMessages(runtime.pi)).toHaveLength(1));
      expect(continueMessages(runtime.pi)).toHaveLength(1);
      expect(reopened.currentLoop?.contextEpoch).toBe(1);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates the exact legacy tree-gap pause once after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-legacy-reanchor-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const planPath = join(root, "approved-plan.md");
    await writeFile(planPath, "# Approved plan\nImplement the feature.\n", "utf8");
    const runtime = harness();
    runtime.setIdle(false);

    try {
      const original = await runtime.controller.startLoop(runtime.ctx, "ship feature", ["tests pass"], {
        planPath,
        agentDir: root,
      });
      const legacyPaused: GoalStateV2 = {
        ...original,
        phase: "paused",
        reasons: {
          pause: "Paused because goal-loop context continuity was unsafe: No safe complete user-led turn suffix was established; automatic continuation must pause.",
        },
      };
      runtime.setBranch([
        { id: "legacy-target", type: "message", message: { role: "user", content: "selected branch" } },
        { id: "legacy-paused", type: "custom", customType: GOAL_STATE_V2_TYPE, data: legacyPaused },
      ], "legacy-paused");

      const ordinarySession = new GoalController(runtime.pi);
      ordinarySession.restore(runtime.ctx);
      expect(ordinarySession.currentLoop?.reanchor).toBeUndefined();

      runtime.setSessionId("01a05a4b-d7fe-7b2c-8458-965d0a199975");
      const reopened = new GoalController(runtime.pi);
      reopened.restore(runtime.ctx);
      expect(reopened.currentLoop?.reanchor).toMatchObject({
        kind: "tree-selection",
        sessionId: "01a05a4b-d7fe-7b2c-8458-965d0a199975",
        targetLeafId: "legacy-paused",
      });
      const resumed = await reopened.resume(runtime.ctx) as GoalStateV2;
      expect(resumed.contextEpoch).toBe(original.contextEpoch + 1);
      expect(resumed.reanchor).toBeUndefined();
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps manual same-branch V2 pause/resume on its current epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-manual-resume-"));
    const planPath = join(root, "approved-plan.md");
    await writeFile(planPath, "# Approved plan\nImplement the feature.\n", "utf8");
    const runtime = harness();
    runtime.setIdle(false);

    try {
      const original = await runtime.controller.startLoop(runtime.ctx, "ship feature", ["tests pass"], {
        planPath,
        agentDir: root,
      });
      const paused = runtime.controller.pause(runtime.ctx) as GoalStateV2;
      const resumed = runtime.controller.resume(runtime.ctx) as GoalStateV2;
      expect(paused.phase).toBe("paused");
      expect(resumed).toMatchObject({
        phase: "implementing",
        loopId: original.loopId,
        generation: original.generation,
        contextEpoch: original.contextEpoch,
        epochMarker: original.epochMarker,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reanchor after an unknown continuity failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-unknown-resume-"));
    const planPath = join(root, "approved-plan.md");
    await writeFile(planPath, "# Approved plan\nImplement the feature.\n", "utf8");
    const runtime = harness();
    runtime.setIdle(false);

    try {
      const original = await runtime.controller.startLoop(runtime.ctx, "ship feature", ["tests pass"], {
        planPath,
        agentDir: root,
      });
      runtime.controller.prepareForTreeNavigation(runtime.ctx);
      runtime.setBranch([], "tree-target");
      runtime.controller.restoreSelectedBranch(runtime.ctx);
      runtime.controller.pause(runtime.ctx, "Paused because an unknown continuity failure occurred.");

      const resumed = runtime.controller.resume(runtime.ctx) as GoalStateV2;
      expect(resumed.contextEpoch).toBe(original.contextEpoch);
      expect(resumed.epochMarker).toEqual(original.epochMarker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("reattempts a pending wake with a fresh context for the same session and leaf", () => {
    vi.useFakeTimers();
    const { controller, ctx, createContext, pi, setBranch, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "shared-leaf");
    setIdle(false);

    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);
    setIdle(true);

    expect(controller.retryPendingWake(createContext())).toBe(true);
    expect(continueMessages(pi)).toHaveLength(1);
    expect(controller.retryPendingWake(createContext())).toBe(false);
  });

  it.each(["leaf", "session"] as const)("invalidates a pending wake when the %s changes", changed => {
    vi.useFakeTimers();
    const { controller, ctx, createContext, pi, setBranch, setSessionId, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "source-leaf");
    setIdle(false);
    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);

    if (changed === "leaf") {
      setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "other-leaf");
    } else {
      setSessionId("session-2");
    }
    setIdle(true);

    expect(controller.retryPendingWake(createContext())).toBe(false);
    expect(continueMessages(pi)).toHaveLength(0);
  });

  it.each(["id", "generation"] as const)("invalidates a pending wake when the goal %s changes on the same leaf", changed => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    const entry = { type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() };
    setBranch([entry], "shared-leaf");
    setIdle(false);
    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);

    entry.data = changed === "id" ? activeGoal({ id: "goal-2" }) : activeGoal({ generation: 2 });
    setIdle(true);

    expect(controller.retryPendingWake(ctx)).toBe(false);
    expect(continueMessages(pi)).toHaveLength(0);
  });

  it("invalidates a pending wake when navigation advances the epoch", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }], "shared-leaf");
    setIdle(false);
    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);

    controller.prepareForNavigation();
    setIdle(true);

    expect(controller.retryPendingWake(ctx)).toBe(false);
    expect(continueMessages(pi)).toHaveLength(0);
  });

  it.each([
    ["canceled session navigation", "session"],
    ["failed tree navigation", "tree"],
  ] as const)("recovers lifecycle work after %s", async (_label, kind) => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch } = harness();
    setBranch([{ type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
    controller.refresh(ctx);

    if (kind === "session") controller.prepareForNavigation();
    else controller.prepareForTreeNavigation(ctx);

    // No completion event is emitted for a canceled/failed navigation. The
    // fallback must release the guard on the next lifecycle turn.
    await Promise.resolve();
    controller.scheduleSubagentWake();
    vi.advanceTimersByTime(250);
    expect(pi.sendMessage.mock.calls.filter(
      ([message]: any[]) => message.customType === GOAL_SUBAGENT_UPDATE_MESSAGE,
    )).toHaveLength(1);

    controller.requestEvaluation(ctx);
    expect(subagents.runEvaluator).toHaveBeenCalledTimes(1);
  });

  it("uses the complete branch path when leaf ids are unavailable", () => {
    vi.useFakeTimers();
    const { controller, ctx, pi, setBranch, setIdle } = harness();
    const sharedGoal = { id: "goal-entry", type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() };
    setBranch([{ id: "root", type: "message" }, sharedGoal, { id: "child-a", type: "message" }], null);
    setIdle(false);
    controller.restoreSelectedBranch(ctx);
    vi.advanceTimersByTime(0);

    setBranch([{ id: "root", type: "message" }, sharedGoal, { id: "child-b", type: "message" }], null);
    setIdle(true);

    expect(controller.retryPendingWake(ctx)).toBe(false);
    expect(continueMessages(pi)).toHaveLength(0);
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

    const firstBranchEntry = { id: "branch-a", type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() };
    setBranch([firstBranchEntry]);
    controller.refresh(ctx);
    controller.scheduleSubagentWake();
    setBranch([{ id: "branch-b", type: "custom", customType: GOAL_STATE_TYPE, data: activeGoal() }]);
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

  it.each(["blocked", "inconclusive"] as const)(
    "transitions a V2 verifier %s outcome to a safe blocked state without continuing the epoch",
    async outcome => {
      const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-controller-terminal-"));
      const cwd = join(root, "workspace");
      const agentDir = join(root, "agent");
      await mkdir(cwd);
      await mkdir(agentDir);
      const planPath = join(cwd, "approved-plan.md");
      await writeFile(planPath, "# Approved plan\nImplement and test the feature.\n", "utf8");

      let branch: any[] = [];
      let leafId = "leaf-0";
      const sessionManager = {
        getBranch: () => branch,
        buildContextEntries: () => branch,
        getSessionId: () => "loop-session",
        getLeafId: () => leafId,
      };
      const pi = {
        appendEntry: vi.fn((customType: string, data: any) => {
          branch.push({ type: "custom", customType, data });
          leafId = `leaf-${branch.length}`;
        }),
        sendMessage: vi.fn(),
      } as any;
      const ctx = {
        cwd,
        isIdle: () => true,
        hasPendingMessages: () => false,
        sessionManager,
      } as any;
      const controller = new GoalController(pi);
      subagents.runEvaluator.mockImplementation((_pi: any, _ctx: any, type: string) => type === "GoalJudge"
        ? Promise.resolve({
          output: JSON.stringify({ ok: true, reason: "candidate complete" }),
          aborted: false,
          steered: false,
        })
        : Promise.resolve({
          output: JSON.stringify({
            outcome,
            reason: `Verifier cannot establish a safe ${outcome} result.`,
            repositoryFingerprint: `repo-${outcome}`,
            evidenceFingerprint: `evidence-${outcome}`,
          }),
          aborted: false,
          steered: false,
        }));

      try {
        await controller.startLoop(ctx, "ship feature", ["tests pass"], { planPath, agentDir });
        await vi.waitFor(() => expect(epochMessages(pi)).toHaveLength(1));
        await vi.waitFor(() => expect(continueMessages(pi)).toHaveLength(1));
        const initialEpochMessages = epochMessages(pi).length;
        const initialContinuationMessages = continueMessages(pi).length;

        controller.requestEvaluation(ctx);
        await vi.waitFor(() => expect(controller.currentLoop?.phase).toBe("blocked"));

        expect(subagents.runEvaluator).toHaveBeenCalledTimes(2);
        expect(controller.currentLoop).toMatchObject({
          phase: "blocked",
          cycle: 0,
          contextEpoch: 0,
          verifier: {
            outcome,
            repositoryFingerprint: `repo-${outcome}`,
            evidenceFingerprint: `evidence-${outcome}`,
          },
          reasons: { block: `GoalVerifier ${outcome}: Verifier cannot establish a safe ${outcome} result.` },
        });
        expect(loopEntries(branch).at(-1)).toMatchObject({
          phase: "blocked",
          cycle: 0,
          contextEpoch: 0,
          verifier: { outcome },
        });
        expect(epochMessages(pi)).toHaveLength(initialEpochMessages);
        expect(continueMessages(pi)).toHaveLength(initialContinuationMessages);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("runs an actual V2 verifier replan through a new immutable context epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-controller-"));
    const cwd = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(cwd);
    await mkdir(agentDir);
    const planPath = join(cwd, "approved-plan.md");
    await writeFile(planPath, "# Approved plan\nImplement and test the feature.\n", "utf8");

    let branch: any[] = [];
    let leafId = "leaf-0";
    let verifierCalls = 0;
    const sessionManager = {
      getBranch: () => branch,
      buildContextEntries: () => branch,
      getSessionId: () => "loop-session",
      getLeafId: () => leafId,
    };
    const pi = {
      appendEntry: vi.fn((customType: string, data: any) => {
        branch.push({ type: "custom", customType, data });
        leafId = `leaf-${branch.length}`;
      }),
      sendMessage: vi.fn(),
    } as any;
    const ctx = {
      cwd,
      isIdle: () => true,
      hasPendingMessages: () => false,
      sessionManager,
    } as any;
    const controller = new GoalController(pi);
    subagents.runEvaluator.mockImplementation((_pi: any, _ctx: any, type: string) => {
      if (type === "GoalJudge") {
        return Promise.resolve({ output: JSON.stringify({ ok: true, reason: "candidate complete" }), aborted: false, steered: false });
      }
      verifierCalls += 1;
      return Promise.resolve({
        output: verifierCalls === 1
          ? JSON.stringify({
            outcome: "replan",
            reason: "One acceptance check is still missing.",
            correction: "Add the missing acceptance check and run the focused test.\n",
            repositoryFingerprint: "repo-before-fix",
            evidenceFingerprint: "verifier-evidence-1",
          })
          : JSON.stringify({
            outcome: "pass",
            reason: "All acceptance checks pass.",
            repositoryFingerprint: "repo-after-fix",
            evidenceFingerprint: "verifier-evidence-2",
          }),
        aborted: false,
        steered: false,
      });
    });

    try {
      await controller.startLoop(ctx, "ship feature", ["tests pass"], { planPath, agentDir });
      await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
      controller.requestEvaluation(ctx);
      await vi.waitFor(() => expect(controller.currentLoop?.cycle).toBe(1));
      expect(controller.currentLoop).toMatchObject({ phase: "implementing", contextEpoch: 1, cycle: 1 });
      expect(controller.currentLoop?.verifier).toMatchObject({ outcome: "replan", repositoryFingerprint: "repo-before-fix" });
      expect(controller.currentLoop?.verifier?.correctionPath).toContain("cycle-1-plan.md");
      await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(4));
      controller.requestEvaluation(ctx);
      await vi.waitFor(() => expect(controller.currentLoop?.phase).toBe("completed"));
      expect(loopEntries(branch).at(-1)).toMatchObject({ phase: "completed", cycle: 1, contextEpoch: 1 });
      expect(verifierCalls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
