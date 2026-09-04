import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import goalExtension from "../src/index.js";
import * as planArtifacts from "../src/plan-artifacts.js";
import {
  buildContextEpochBootstrap,
  createContextEpochMarker,
} from "../src/context-epoch.js";
import {
  GOAL_CONTEXT_EPOCH_TYPE,
  GOAL_CONTINUE_MESSAGE,
  GOAL_STATE_TYPE,
  GOAL_STATE_V2_TYPE,
  type GoalStateV1,
  type GoalStateV2,
} from "../src/types.js";
import { PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL } from "../src/plan-bridge.js";

function pausedGoal(): GoalStateV1 {
  return {
    schemaVersion: 1,
    id: "goal-v1",
    generation: 1,
    status: "paused",
    objective: "Implement the feature.",
    criteria: ["tests pass"],
    createdAt: 1,
    updatedAt: 1,
    iteration: 0,
    consecutiveJudgeFailures: 0,
    verificationFailures: 0,
    noProgressCycles: 0,
  };
}

function loopState(agentDir = "/agent"): GoalStateV2 {
  const plan = "# Approved plan\nImplement the feature.\n";
  return {
    schemaVersion: 2,
    loopId: "loop-integration",
    generation: 1,
    contextEpoch: 0,
    phase: "implementing",
    cycle: 0,
    maxCycles: 3,
    objective: "Implement the feature.",
    criteria: ["tests pass"],
    plan: {
      sourceKind: "approved",
      sourcePath: "/workspace/approved-plan.md",
      snapshotPath: join(agentDir, "goal-loops", "loop-integration", "original-plan.md"),
      snapshotHash: createHash("sha256").update(plan).digest("hex"),
    },
  };
}

function epochMarker(state: GoalStateV2) {
  const plan = "# Approved plan\nImplement the feature.\n";
  const bootstrap = buildContextEpochBootstrap(state, {
    originalPlan: {
      path: state.plan.snapshotPath!,
      hash: state.plan.snapshotHash!,
      content: plan,
    },
    verifier: { discrepancies: [], requiredValidation: ["tests pass"] },
    capabilityGuidance: ["Use only available tools."],
    continuationInstruction: "Continue the approved implementation.",
  });
  return createContextEpochMarker(bootstrap, { timestamp: 1 });
}

function controllerEpochMarker(state: GoalStateV2) {
  const plan = "# Approved plan\nImplement the feature.\n";
  const bootstrap = buildContextEpochBootstrap(state, {
    originalPlan: {
      path: state.plan.snapshotPath!,
      hash: state.plan.snapshotHash!,
      content: plan,
    },
    verifier: { discrepancies: [], requiredValidation: ["Re-run the focused checks required by the acceptance criteria."] },
    capabilityGuidance: ["Use the main session's currently selected PLAN / ORCHESTRATOR / YOLO mode and available tools. Do not assume unavailable capabilities. Goal evaluation itself cannot mutate through GoalJudge; GoalVerifier is read-only acceptance verification."],
    continuationInstruction: state.pendingVerificationEntry === true
      ? "Inspect the repository and gather relevant tests and evidence only. Make no edits or implementation changes. Do not invoke GoalJudge or GoalVerifier directly. Stop after this one parent turn with concise evidence for the controller."
      : "Continue implementing the current immutable plan, then stop for GoalJudge and independent GoalVerifier evaluation.",
  });
  return createContextEpochMarker(bootstrap, { timestamp: 1 });
}

type IntegrationHarnessOptions = {
  flags?: Record<string, boolean | string | undefined>;
};

function integrationHarness(options: IntegrationHarnessOptions = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const registeredFlags = new Map<string, any>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const branch: any[] = [];
  let provider: any;
  let command: any;
  let baseCompletionApplications = 0;
  const sentMessages: any[] = [];
  const publicationOrder: string[] = [];
  const emittedChannels: string[] = [];
  const notifications = vi.fn();
  let idleBarrier = deferred<void>();
  const waitForIdle = vi.fn(() => idleBarrier.promise);
  let leafId = "integration-leaf";
  let sessionId = "integration-session";
  let sessionEntries: any[] | undefined;
  let idle = true;
  let pendingMessages = false;
  let aborts = 0;
  const sessionManager = {
    getBranch: () => branch,
    getEntries: () => sessionEntries ?? branch,
    buildContextEntries: () => branch,
    getSessionId: () => sessionId,
    getLeafId: () => leafId,
  };
  const baseProvider = {
    triggerCharacters: ["/"],
    async getSuggestions(lines: string[], cursorLine: number, cursorCol: number) {
      expect(lines[cursorLine]).toBe("--loop --plan plans/");
      expect(cursorCol).toBe("--loop --plan plans/".length);
      return { items: [{ value: "plans/approved.md", label: "approved.md" }], prefix: "plans/" };
    },
    applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: any, prefix: string) {
      baseCompletionApplications += 1;
      const line = lines[cursorLine] ?? "";
      const before = line.slice(0, cursorCol - prefix.length);
      const completedValue = prefix.startsWith("/") ? `/${item.value}` : item.value;
      const result = [...lines];
      result[cursorLine] = `${before}${completedValue}${line.slice(cursorCol)}`;
      return { lines: result, cursorLine, cursorCol: before.length + completedValue.length };
    },
    shouldTriggerFileCompletion: () => true,
  };
  const ui = {
    addAutocompleteProvider(factory: any) { provider = factory(baseProvider); },
    notify: notifications,
  };
  const ctx = {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    ui,
    isIdle: () => idle,
    hasPendingMessages: () => pendingMessages,
    abort: () => { aborts += 1; },
    sessionManager,
  } as any;
  const events = {
    on(channel: string, listener: (data: unknown) => void) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      return () => set.delete(listener);
    },
    emit(channel: string, data: unknown) {
      emittedChannels.push(channel);
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(data);
    },
  };
  const pi = {
    events,
    on(name: string, handler: (event: any, eventCtx: any) => unknown) { handlers.set(name, handler); },
    registerCommand(_name: string, value: any) { command = value; },
    registerFlag(name: string, definition: any) { registeredFlags.set(name, definition); },
    getFlag(name: string) { return options.flags?.[name]; },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
      if (customType === GOAL_STATE_V2_TYPE) {
        publicationOrder.push(`state:${(data as GoalStateV2).phase}`);
      } else if (customType === "pi-goal-state-v1") {
        publicationOrder.push(`state:${(data as { status: string }).status}`);
      }
    },
    sendMessage(message: unknown) {
      if (typeof message === "object" && message !== null && "customType" in message) {
        const persisted = { role: "custom", ...message } as Record<string, unknown>;
        if (persisted.customType === GOAL_CONTEXT_EPOCH_TYPE && typeof persisted.timestamp !== "number") {
          persisted.timestamp = 0;
        }
        if (persisted.customType === GOAL_CONTEXT_EPOCH_TYPE) publicationOrder.push("epoch");
        if (persisted.customType === "pi-goal-continue-v1") publicationOrder.push("continuation");
        sentMessages.push(persisted);
      } else {
        sentMessages.push(message);
      }
    },
  } as any;
  goalExtension(pi);
  return {
    pi,
    ctx,
    branch,
    handlers,
    get command() { return command; },
    sentMessages,
    publicationOrder,
    emittedChannels,
    notifications,
    registeredFlags,
    commandContext() { return { ui, waitForIdle }; },
    resolveIdleWait() {
      const current = idleBarrier;
      idleBarrier = deferred<void>();
      current.resolve();
    },
    rejectIdleWait(error: Error) {
      const current = idleBarrier;
      idleBarrier = deferred<void>();
      current.reject(error);
    },
    get waitForIdleCalls() { return waitForIdle.mock.calls.length; },
    get provider() { return provider; },
    get baseCompletionApplications() { return baseCompletionApplications; },
    sessionManager,
    setLeaf(next: string) { leafId = next; },
    setSessionId(next: string) { sessionId = next; },
    setSessionEntries(next: any[]) { sessionEntries = next; },
    setIdle(next: boolean) { idle = next; },
    setPendingMessages(next: boolean) { pendingMessages = next; },
    get aborts() { return aborts; },
  };
}

type Message = ContextEvent["messages"][number];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function explicitPlanHarness(
  prefix: string,
  flags: Record<string, boolean | string | undefined>,
  includeGoalPlan = true,
) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const sourcePath = join(root, "source-plan.md");
  await writeFile(sourcePath, "# Integration plan\nVerify the implementation.\n", "utf8");
  const harness = integrationHarness({ flags: includeGoalPlan ? { ...flags, "goal-plan": sourcePath } : flags });
  return {
    harness,
    root,
    sourcePath,
    async cleanup() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function pausedLoopHarness(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const artifactDir = join(root, "goal-loops", "loop-integration");
  const plan = "# Approved plan\nImplement the feature.\n";
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");
  const harness = integrationHarness();
  const state: GoalStateV2 = {
    ...loopState(root),
    phase: "paused",
    reasons: { pause: "Paused by user." },
  };
  state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
  harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });
  await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
  return {
    harness,
    state,
    async cleanup() {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("goal extension provider integration", () => {
  it("does not activate a goal from plan or mode transition events", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);

    harness.pi.events.emit("pi-plan-mode:implementation-started-v1", {
      version: 1,
      sourceKind: "approved",
      sourcePath: "/agent/plans/approved/plan.md",
      planPath: "/agent/plans/approved/plan.md",
      action: "yolo-direct",
      strategy: "YOLO",
      transitionId: "transition-1",
    });
    await Promise.resolve();

    expect(harness.branch.some(entry => entry.customType === GOAL_STATE_V2_TYPE)).toBe(false);
    expect(harness.sentMessages).toEqual([]);
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it.each(["command-wake", "settlement-backup"] as const)(
    "consumes a busy V2 resume exactly once through the %s ordering",
    async wakeOrder => {
      const { harness, cleanup } = await pausedLoopHarness("pi-goal-busy-resume-");
      try {
        harness.setIdle(false);
        const resumeCommand = harness.command.handler("resume", harness.commandContext());

        expect(harness.waitForIdleCalls).toBe(1);
        expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "paused", contextEpoch: 0 } });
        expect(harness.sentMessages).toEqual([]);

        harness.setIdle(true);
        if (wakeOrder === "command-wake") {
          harness.resolveIdleWait();
          await resumeCommand;
          await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
        } else {
          await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
          harness.resolveIdleWait();
          await resumeCommand;
        }

        await vi.waitFor(() => expect(harness.sentMessages).toHaveLength(2));
        expect(harness.branch.filter(entry =>
          entry.customType === GOAL_STATE_V2_TYPE && entry.data?.phase === "implementing"
        )).toHaveLength(1);
        expect(harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE)).toHaveLength(1);
        expect(harness.sentMessages.filter(message => message.customType === GOAL_CONTINUE_MESSAGE)).toHaveLength(1);
        expect(harness.publicationOrder).toEqual([
          "state:implementing",
          "epoch",
          "continuation",
        ]);
        expect(harness.notifications.mock.calls.filter(([message]) => message === "Goal resumed.")).toHaveLength(1);
      } finally {
        await cleanup();
      }
    },
  );

  it.each([false, true])(
    "preserves a busy V2 resume across compaction (willRetry=%s)",
    async willRetry => {
      const { harness, cleanup } = await pausedLoopHarness("pi-goal-compact-resume-");
      try {
        harness.setIdle(false);
        const resumeCommand = harness.command.handler("resume", harness.commandContext());
        harness.handlers.get("session_before_compact")!({ type: "session_before_compact" }, harness.ctx);
        harness.handlers.get("session_compact")!({ type: "session_compact", willRetry }, harness.ctx);

        expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "paused", contextEpoch: 0 } });
        expect(harness.sentMessages).toEqual([]);

        harness.setIdle(true);
        harness.resolveIdleWait();
        await resumeCommand;
        await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
        await vi.waitFor(() => expect(harness.sentMessages).toHaveLength(2));

        expect(harness.branch.filter(entry =>
          entry.customType === GOAL_STATE_V2_TYPE && entry.data?.phase === "implementing"
        )).toHaveLength(1);
        expect(harness.publicationOrder).toEqual([
          "state:implementing",
          "epoch",
          "continuation",
        ]);
      } finally {
        await cleanup();
      }
    },
  );

  it("cancels a busy V2 resume when its exact paused target is replaced", async () => {
    const { harness, state, cleanup } = await pausedLoopHarness("pi-goal-replaced-resume-");
    try {
      harness.setIdle(false);
      const resumeCommand = harness.command.handler("resume", harness.commandContext());
      harness.branch.push({
        type: "custom",
        customType: GOAL_STATE_V2_TYPE,
        data: { ...state, loopId: "replacement-loop", phase: "paused" },
      });

      harness.setIdle(true);
      harness.resolveIdleWait();
      await resumeCommand;

      expect(harness.branch.some(entry =>
        entry.customType === GOAL_STATE_V2_TYPE
          && entry.data?.loopId === state.loopId
          && entry.data?.phase === "implementing"
      )).toBe(false);
      expect(harness.sentMessages).toEqual([]);
      expect(harness.notifications).toHaveBeenCalledWith(
        "Queued goal resume cancelled because the paused goal target changed.",
        "warning",
      );
    } finally {
      await cleanup();
    }
  });

  it("resumes a busy V1 goal once without V2 epoch traffic", async () => {
    const harness = integrationHarness();
    harness.branch.push({ type: "custom", customType: GOAL_STATE_TYPE, data: pausedGoal() });
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);

    harness.setIdle(false);
    const resumeCommand = harness.command.handler("resume", harness.commandContext());
    harness.setIdle(true);
    harness.resolveIdleWait();
    await resumeCommand;
    await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);

    expect(harness.branch.filter(entry =>
      entry.customType === GOAL_STATE_TYPE && entry.data?.status === "active"
    )).toHaveLength(1);
    expect(harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE)).toHaveLength(0);
    expect(harness.sentMessages.filter(message => message.customType === GOAL_CONTINUE_MESSAGE)).toHaveLength(1);
    expect(harness.publicationOrder).toEqual(["state:active", "continuation"]);
  });

  it("disarms a queued resume when the idle barrier fails", async () => {
    const harness = integrationHarness();
    harness.branch.push({ type: "custom", customType: GOAL_STATE_TYPE, data: pausedGoal() });
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);

    harness.setIdle(false);
    const resumeCommand = harness.command.handler("resume", harness.commandContext());
    harness.rejectIdleWait(new Error("idle barrier failed"));
    await resumeCommand;

    harness.setIdle(true);
    await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
    expect(harness.branch.some(entry =>
      entry.customType === GOAL_STATE_TYPE && entry.data?.status === "active"
    )).toBe(false);
    expect(harness.sentMessages).toEqual([]);
    expect(harness.notifications).toHaveBeenCalledWith("idle barrier failed", "error");
  });

  it.each(["session_before_switch", "session_before_fork"] as const)(
    "cancels a busy resume when %s starts",
    async eventName => {
      const harness = integrationHarness();
      harness.branch.push({ type: "custom", customType: GOAL_STATE_TYPE, data: pausedGoal() });
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      harness.setIdle(false);
      const resumeCommand = harness.command.handler("resume", harness.commandContext());

      harness.handlers.get(eventName)!({ type: eventName }, harness.ctx);
      harness.setIdle(true);
      harness.resolveIdleWait();
      await resumeCommand;

      expect(harness.branch.some(entry =>
        entry.customType === GOAL_STATE_TYPE && entry.data?.status === "active"
      )).toBe(false);
      expect(harness.notifications.mock.calls.some(([message]) =>
        String(message).startsWith("Queued goal resume cancelled because")
      )).toBe(true);
    },
  );

  it.each(["start", "fresh", "pause", "stop", "clear"] as const)(
    "does not revive the old target after a conflicting /goal %s",
    async action => {
      const harness = integrationHarness();
      const oldGoal = pausedGoal();
      harness.branch.push({ type: "custom", customType: GOAL_STATE_TYPE, data: oldGoal });
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      harness.setIdle(false);
      const resumeCommand = harness.command.handler("resume", harness.commandContext());

      await harness.command.handler(
        action === "start" ? "replacement objective" : action,
        harness.commandContext(),
      );
      harness.setIdle(true);
      harness.resolveIdleWait();
      await resumeCommand;

      expect(harness.branch.some(entry =>
        entry.customType === GOAL_STATE_TYPE
          && entry.data?.id === oldGoal.id
          && entry.data?.status === "active"
      )).toBe(false);
      expect(harness.notifications.mock.calls.some(([message]) =>
        String(message).startsWith("Queued goal resume cancelled because")
      )).toBe(true);
    },
  );

  it("filters an active V2 epoch without old traffic and keeps the selected session stable", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    const state = loopState();
    harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });
    const marker = epochMarker(state);
    const messages = [
      { role: "user", content: "old sentinel from a previous epoch" },
      marker,
      { role: "user", content: "current request" },
    ] as Message[];

    const first = await harness.handlers.get("context")!({ type: "context", messages }, harness.ctx) as { messages: Message[] };
    const second = await harness.handlers.get("context")!({ type: "context", messages }, { ...harness.ctx }) as { messages: Message[] };

    expect(JSON.stringify(first)).not.toContain("old sentinel from a previous epoch");
    expect(JSON.stringify(first)).toContain("current request");
    expect(first.messages).toEqual(second.messages);
    expect(harness.sessionManager.getSessionId()).toBe("integration-session");
    expect(harness.sessionManager.getLeafId()).toBe("integration-leaf");
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it.each([
    ["sessionId", "getSessionId", (): string => "stale-session"],
    ["leafId", "getLeafId", (): string => "stale-leaf"],
  ] as const)("fails closed for a stale context wrapper with a different %s without aborting or mutating state", async (_selectionName, selectionField, staleValue) => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    const state = loopState();
    harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });
    const branchBefore = structuredClone(harness.branch);
    const staleContext = {
      ...harness.ctx,
      sessionManager: {
        ...harness.sessionManager,
        [selectionField]: staleValue,
      },
    };

    const result = await harness.handlers.get("context")!({
      type: "context",
      messages: [{ role: "user", content: "stale context" }],
    }, staleContext) as { messages: Message[] };

    expect(result).toEqual({ messages: [] });
    expect(harness.aborts).toBe(0);
    expect(harness.branch).toEqual(branchBefore);
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it("reanchors a lost epoch marker after session compaction before filtering provider context", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-integration-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const plan = "# Approved plan\nImplement the feature.\n";

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");

      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const expectedMarker = controllerEpochMarker(state);
      state.epochMarker = { id: expectedMarker.details.id, hash: expectedMarker.details.hash };
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      await harness.handlers.get("session_compact")!({ type: "session_compact" }, harness.ctx);
      await vi.waitFor(() => expect(
        harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE),
      ).toHaveLength(1));

      const reanchored = harness.sentMessages.find(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE);
      expect(reanchored).toMatchObject({
        customType: GOAL_CONTEXT_EPOCH_TYPE,
        details: state.epochMarker,
        display: false,
      });

      const messages = [
        { role: "compactionSummary", content: "old compaction content must not reach the provider" },
        reanchored,
        { role: "user", content: "request after compaction" },
      ] as Message[];
      const result = await harness.handlers.get("context")!({ type: "context", messages }, harness.ctx) as { messages: Message[] };

      expect(result.messages[0]).toMatchObject({ customType: GOAL_CONTEXT_EPOCH_TYPE, details: state.epochMarker });
      expect(JSON.stringify(result.messages)).not.toContain("old compaction content must not reach the provider");
      expect(JSON.stringify(result.messages)).toContain("request after compaction");
      expect(result.messages.filter(message => (message as { role?: string }).role === "custom")).toHaveLength(1);

      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a one-shot selected-branch compaction proof before idle marker publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-compact-handoff-"));
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const summary = "Current compacted implementation context.";
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), "# Approved plan\nImplement the feature.\n", "utf8");
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const expectedMarker = controllerEpochMarker(state);
      state.epochMarker = { id: expectedMarker.details.id, hash: expectedMarker.details.hash };
      harness.branch.push({
        id: "integration-leaf",
        parentId: null,
        timestamp: new Date(0).toISOString(),
        type: "custom",
        customType: GOAL_STATE_V2_TYPE,
        data: state,
      });
      harness.setIdle(false);
      const preservedAssistant = {
        role: "assistant",
        content: [{ type: "toolCall", id: "preserved-call", name: "read", arguments: {} }],
      };
      const preservedResult = {
        role: "toolResult",
        toolCallId: "preserved-call",
        content: [{ type: "text", text: "done" }],
      };
      const preservedFinal = {
        role: "assistant",
        content: [{ type: "text", text: "retry after compaction" }],
        stopReason: "error",
      };
      harness.branch.push(
        { id: "preserved-assistant", parentId: "integration-leaf", timestamp: new Date(1).toISOString(), type: "message", message: preservedAssistant },
        { id: "preserved-result", parentId: "preserved-assistant", timestamp: new Date(2).toISOString(), type: "message", message: preservedResult },
        { id: "preserved-final", parentId: "preserved-result", timestamp: new Date(3).toISOString(), type: "message", message: preservedFinal },
      );
      const compactionEntry = {
        id: "compact-entry",
        parentId: "preserved-final",
        type: "compaction",
        summary,
        firstKeptEntryId: "preserved-assistant",
        tokensBefore: 100_000,
        timestamp: new Date(4).toISOString(),
      };
      harness.branch.push(compactionEntry);
      harness.setLeaf("compact-entry");

      // Recovery is derived from durable selected-branch history and does not
      // depend on either compaction lifecycle callback reaching the extension.
      // Goal-owned follow-up traffic may also advance the selected leaf.
      harness.branch.push({
        id: "post-compact-child",
        parentId: "compact-entry",
        timestamp: new Date(5).toISOString(),
        type: "custom",
        customType: "post-compact-state",
        data: {},
      });
      harness.setLeaf("post-compact-child");
      expect(harness.sentMessages).toEqual([]);

      const compactedMessages = [
        { role: "compactionSummary", summary, tokensBefore: 100_000, timestamp: 4 },
        preservedAssistant,
        preservedResult,
        preservedFinal,
      ];
      const staleMessages = [
        { role: "compactionSummary", summary: "previous compacted context", tokensBefore: 80_000, timestamp: 0 },
        expectedMarker,
        ...Array.from({ length: 65 }, (_, index) => ({ role: "assistant", content: `stale pre-compaction message ${index}` })),
      ];
      const result = await harness.handlers.get("context")!({
        type: "context",
        messages: staleMessages,
      }, harness.ctx) as { messages: Message[] };

      expect(result.messages).toHaveLength(5);
      expect(result.messages[0]).toMatchObject({ customType: GOAL_CONTEXT_EPOCH_TYPE, details: state.epochMarker });
      expect(result.messages.slice(1)).toEqual(compactedMessages);
      expect(harness.aborts).toBe(0);
      expect(harness.branch.filter(entry => entry.customType === GOAL_STATE_V2_TYPE).at(-1))
        .toMatchObject({ data: { phase: "implementing" } });

      // The branch proof is consumed exactly once; it cannot bless a later markerless request.
      await harness.handlers.get("context")!({
        type: "context",
        messages: [{ role: "compactionSummary", summary, tokensBefore: 100_000, timestamp: 1 }],
      }, harness.ctx);
      expect(harness.aborts).toBe(1);
      expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "paused" } });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not trust a compaction that predates the latest goal state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-old-compaction-"));
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), "# Approved plan\nImplement the feature.\n", "utf8");
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const expectedMarker = controllerEpochMarker(state);
      state.epochMarker = { id: expectedMarker.details.id, hash: expectedMarker.details.hash };
      harness.branch.push({
        id: "old-compaction",
        type: "compaction",
        summary: "old summary",
      });
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      await harness.handlers.get("context")!({
        type: "context",
        messages: [{ role: "compactionSummary", summary: "old summary", tokensBefore: 100_000, timestamp: 1 }],
      }, harness.ctx);

      expect(harness.aborts).toBe(1);
      expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "paused" } });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["mismatched rebuilt summary", "failed later compaction"] as const)(
    "does not use selected compaction proof after %s",
    async mode => {
      const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-compaction-proof-reject-"));
      const artifactDir = join(root, "goal-loops", "loop-integration");
      const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = root;

      try {
        await mkdir(artifactDir, { recursive: true });
        await writeFile(join(artifactDir, "original-plan.md"), "# Approved plan\nImplement the feature.\n", "utf8");
        const harness = integrationHarness();
        await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
        const state = loopState(root);
        state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
        const expectedMarker = controllerEpochMarker(state);
        state.epochMarker = { id: expectedMarker.details.id, hash: expectedMarker.details.hash };
        const stateEntry = {
          id: "proof-state",
          parentId: null,
          timestamp: new Date(0).toISOString(),
          type: "custom",
          customType: GOAL_STATE_V2_TYPE,
          data: state,
        };
        const compactionEntry = {
          id: "proof-compaction",
          parentId: "proof-state",
          timestamp: new Date(1).toISOString(),
          type: "compaction",
          summary: "selected summary",
          tokensBefore: 100_000,
        };
        harness.branch.push(stateEntry, compactionEntry);
        harness.setLeaf("proof-compaction");

        if (mode === "mismatched rebuilt summary") {
          harness.setSessionEntries([
            stateEntry,
            { ...compactionEntry, summary: "different rebuilt summary" },
          ]);
        } else {
          await harness.handlers.get("session_compact_failed")!({
            type: "session_compact_failed",
            reason: "threshold",
            willRetry: false,
            aborted: true,
          }, harness.ctx);
        }

        await harness.handlers.get("context")!({
          type: "context",
          messages: [{ role: "compactionSummary", summary: "selected summary", tokensBefore: 100_000, timestamp: 1 }],
        }, harness.ctx);

        expect(harness.aborts).toBe(1);
        expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "paused" } });
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("reanchors pending verification with matching no-edit fallback guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-verify-reanchor-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const plan = "# Approved plan\nImplement the feature.\n";

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.pendingVerificationEntry = true;
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const expectedMarker = controllerEpochMarker(state);
      state.epochMarker = { id: expectedMarker.details.id, hash: expectedMarker.details.hash };
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      await harness.handlers.get("session_compact")!({ type: "session_compact" }, harness.ctx);
      await vi.waitFor(() => expect(
        harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE),
      ).toHaveLength(1));

      const reanchored = harness.sentMessages.find(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE);
      const bootstrap = JSON.parse(reanchored!.content);
      expect(bootstrap).toMatchObject({ pendingVerificationEntry: true, contextEpoch: state.contextEpoch });
      expect(bootstrap.continuationInstruction).toContain("Make no edits or implementation changes.");
      expect(bootstrap.continuationInstruction).toContain("Do not invoke GoalJudge or GoalVerifier directly.");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defers native overflow rebootstrap until the retry settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-overflow-"));
    const loader = vi.spyOn(planArtifacts, "loadVerifiedOriginalPlan").mockImplementation(async options => {
      const content = "# Approved plan\nImplement the feature.\n";
      return {
        path: options.provenance.snapshotPath!,
        hash: options.provenance.snapshotHash!,
        content,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        sourcePath: options.provenance.sourcePath ?? options.provenance.snapshotPath!,
        sourceKind: options.provenance.sourceKind === "approved" ? "approved" : "explicit",
        provenance: options.provenance,
      };
    });

    try {
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      await mkdir(join(root, "goal-loops", state.loopId), { recursive: true });
      await writeFile(state.plan.snapshotPath!, "# Approved plan\nImplement the feature.\n", "utf8");
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      await harness.handlers.get("session_compact")!({
        type: "session_compact",
        reason: "overflow",
        willRetry: true,
      }, harness.ctx);
      expect(loader).not.toHaveBeenCalled();
      expect(harness.sentMessages).toEqual([]);

      const result = await harness.handlers.get("context")!({
        type: "context",
        messages: [{ role: "compactionSummary", content: "unsafe transient summary" }],
      }, harness.ctx);
      expect(result).toBeUndefined();
      expect(harness.aborts).toBe(0);

      harness.setIdle(true);
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(
        harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE),
      ).toHaveLength(1));
      expect(harness.sentMessages.filter(message => message.customType === "pi-goal-continue-v1")).toHaveLength(1);
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
    } finally {
      loader.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reanchors after compaction when a queued continuation advances the leaf", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-integration-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const plan = "# Approved plan\nImplement the feature.\n";

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const expectedMarker = controllerEpochMarker(state);
      state.epochMarker = { id: expectedMarker.details.id, hash: expectedMarker.details.hash };
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      harness.setIdle(false);
      await harness.handlers.get("session_compact")!({ type: "session_compact" }, harness.ctx);
      expect(harness.sentMessages).toHaveLength(0);

      harness.setLeaf("post-compaction-continuation");
      harness.setIdle(true);
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      await vi.waitFor(() => expect(
        harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE),
      ).toHaveLength(1));
      expect(harness.sentMessages.filter(message => message.customType === "pi-goal-continue-v1")).toHaveLength(1);

      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      expect(harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE)).toHaveLength(1);
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("carries a reopened proof across startup sibling selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-startup-tree-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const plan = "# Approved plan\nImplement the feature.\n";

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");
      const harness = integrationHarness();
      harness.setSessionId("01a05a4b-d7fe-7b2c-8458-965d0a199975");
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const sourcePaused: GoalStateV2 = {
        ...state,
        phase: "paused",
        reasons: {
          pause: "Paused because goal-loop context continuity was unsafe: No safe complete user-led turn suffix was established; automatic continuation must pause.",
        },
      };
      harness.branch.push({
        id: "source-proof",
        type: "custom",
        customType: GOAL_STATE_V2_TYPE,
        data: sourcePaused,
      });
      harness.setLeaf("source-proof");
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      harness.handlers.get("session_before_tree")!({ type: "session_before_tree" }, harness.ctx);

      const rememberedPaused: GoalStateV2 = {
        ...state,
        phase: "paused",
        reasons: { pause: "Paused by user." },
      };
      harness.branch.splice(
        0,
        harness.branch.length,
        {
          id: "remembered-goal",
          type: "custom",
          customType: GOAL_STATE_V2_TYPE,
          data: rememberedPaused,
        },
        {
          id: "remembered-leaf",
          type: "custom",
          customType: "pi-plan-mode-state",
          data: { mode: "implement" },
        },
      );
      harness.setLeaf("remembered-leaf");
      harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: {
          phase: "paused",
          reanchor: { targetLeafId: "remembered-leaf" },
        },
      });

      harness.setIdle(false);
      const navigationResume = harness.command.handler("resume", harness.commandContext());
      expect(harness.notifications).toHaveBeenCalledWith(
        "Goal resume queued until the current agent turn settles.",
        "info",
      );
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "paused", contextEpoch: 0 },
      });

      const duringTurn = await harness.handlers.get("context")!({
        type: "context",
        messages: [
          { role: "user", content: "continue" },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "active-call", name: "read", arguments: {} }],
          },
          { role: "toolResult", toolCallId: "active-call", content: [{ type: "text", text: "done" }] },
        ],
      }, harness.ctx);
      expect(duringTurn).toBeUndefined();
      expect(harness.aborts).toBe(0);

      harness.handlers.get("session_before_tree")!({ type: "session_before_tree" }, harness.ctx);
      harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
      harness.setIdle(true);
      harness.resolveIdleWait();
      await navigationResume;
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "paused", contextEpoch: 0 },
      });

      harness.setIdle(false);
      const pendingResume = harness.command.handler("resume", harness.commandContext());
      harness.branch.push({
        id: "active-turn-descendant",
        parentId: "remembered-leaf",
        type: "custom",
        customType: "active-turn-progress",
        data: {},
      });
      harness.setLeaf("active-turn-descendant");
      harness.setIdle(true);
      harness.setPendingMessages(true);
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      harness.resolveIdleWait();
      await pendingResume;
      expect(harness.branch.findLast(entry => entry.customType === GOAL_STATE_V2_TYPE)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "paused", contextEpoch: 0 },
      });
      expect(harness.notifications).toHaveBeenCalledWith(
        "Queued goal resume is still waiting for pending messages to settle.",
        "warning",
      );

      harness.setPendingMessages(false);
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "implementing", contextEpoch: 1, reanchor: undefined },
      });
      await vi.waitFor(() => expect(
        harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE),
      ).toHaveLength(1));
      expect(harness.sentMessages.filter(message => message.customType === "pi-goal-continue-v1")).toHaveLength(1);

      await harness.command.handler("pause", harness.commandContext());
      harness.setIdle(false);
      const conflictingResume = harness.command.handler("resume", harness.commandContext());
      await harness.command.handler("pause", harness.commandContext());
      harness.setIdle(true);
      harness.resolveIdleWait();
      await conflictingResume;
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "paused", contextEpoch: 1 },
      });

      harness.setIdle(false);
      const shutdownResume = harness.command.handler("resume", harness.commandContext());
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      harness.setIdle(true);
      harness.resolveIdleWait();
      await shutdownResume;
      await harness.handlers.get("agent_settled")!({ type: "agent_settled" }, harness.ctx);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "paused", contextEpoch: 1 },
      });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("adopts an explicitly selected branch on ordinary resume and accepts its fresh epoch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-tree-resume-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const plan = "# Approved plan\nImplement the feature.\n";

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const marker = controllerEpochMarker(state);
      state.epochMarker = { id: marker.details.id, hash: marker.details.hash };
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      harness.handlers.get("session_before_tree")!({ type: "session_before_tree" }, harness.ctx);
      harness.setIdle(false);
      harness.branch.splice(0, harness.branch.length, {
        id: "tree-target",
        type: "custom",
        customType: GOAL_STATE_V2_TYPE,
        data: state,
      });
      harness.setLeaf("tree-target");
      harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "implementing", loopId: state.loopId, contextEpoch: 0 },
      });

      const unsafe = await harness.handlers.get("context")!({
        type: "context",
        messages: [{ role: "branchSummary", content: "selected tree branch" }],
      }, harness.ctx) as { messages: Message[] };
      expect(unsafe.messages).toEqual([]);
      expect(harness.aborts).toBe(1);
      expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "paused", loopId: state.loopId, contextEpoch: 0 },
      });

      harness.setIdle(true);
      await harness.command.handler("resume", { ui: { notify: vi.fn() } });
      await vi.waitFor(() => expect(harness.branch.at(-1)).toMatchObject({
        customType: GOAL_STATE_V2_TYPE,
        data: { phase: "implementing", loopId: state.loopId, contextEpoch: 1 },
      }));
      await vi.waitFor(() => expect(
        harness.sentMessages.filter(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE),
      ).toHaveLength(1));

      const freshMarker = harness.sentMessages.find(message => message.customType === GOAL_CONTEXT_EPOCH_TYPE);
      const result = await harness.handlers.get("context")!({
        type: "context",
        messages: [freshMarker],
      }, harness.ctx) as { messages: Message[] };
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({ customType: GOAL_CONTEXT_EPOCH_TYPE });
      // The initial unsafe tree-continuity attempt aborted once; accepting the
      // fresh epoch must not trigger a repeated abort.
      expect(harness.aborts).toBe(1);
      expect(harness.branch.at(-1)).toMatchObject({ data: { contextEpoch: 1, phase: "implementing" } });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["malformed", "stale"] as const)("invalidates selected-branch eligibility for %s marker rejection", async kind => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-malformed-marker-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const artifactDir = join(root, "goal-loops", "loop-integration");
    const plan = "# Approved plan\nImplement the feature.\n";

    try {
      await mkdir(artifactDir, { recursive: true });
      await writeFile(join(artifactDir, "original-plan.md"), plan, "utf8");
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      state.plan.snapshotPath = join(await realpath(artifactDir), "original-plan.md");
      const marker = controllerEpochMarker(state);
      state.epochMarker = { id: marker.details.id, hash: marker.details.hash };
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });

      harness.handlers.get("session_before_tree")!({ type: "session_before_tree" }, harness.ctx);
      harness.setIdle(false);
      harness.setLeaf("tree-target");
      harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
      const invalidMarker = kind === "malformed"
        ? { ...marker, content: `${marker.content} ` }
        : controllerEpochMarker({ ...state, contextEpoch: state.contextEpoch + 1, epochMarker: undefined });
      const result = await harness.handlers.get("context")!({
        type: "context",
        messages: [invalidMarker],
      }, harness.ctx) as { messages: Message[] };

      expect(result.messages).toEqual([]);
      expect(harness.aborts).toBe(1);
      expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "paused", contextEpoch: 0 } });

      harness.setIdle(true);
      await harness.command.handler("resume", { ui: { notify: vi.fn() } });
      expect(harness.branch.at(-1)).toMatchObject({ data: { phase: "implementing", contextEpoch: 0 } });
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses and aborts when fallback artifact verification throws", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    const state = loopState(join(tmpdir(), "missing-goal-artifact"));
    harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });
    const result = await harness.handlers.get("context")!({
      type: "context",
      messages: [{ role: "user", content: "current request" }],
    }, harness.ctx) as { messages: Message[] };

    expect(result.messages).toEqual([]);
    expect(harness.aborts).toBe(1);
    expect(harness.branch.at(-1)).toMatchObject({ customType: GOAL_STATE_V2_TYPE, data: { phase: "paused" } });
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it("drops an async fallback after navigation supersedes its lifecycle token", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-loop-async-context-"));
    const release = deferred<void>();
    const originalLoader = vi.spyOn(planArtifacts, "loadVerifiedOriginalPlan").mockImplementation(async options => {
      await release.promise;
      return {
        path: options.provenance.snapshotPath!,
        hash: options.provenance.snapshotHash!,
        content: "# Approved plan\nImplement the feature.\n",
        sizeBytes: Buffer.byteLength("# Approved plan\nImplement the feature.\n", "utf8"),
        sourcePath: options.provenance.sourcePath ?? options.provenance.snapshotPath!,
        sourceKind: options.provenance.sourceKind === "approved" ? "approved" : "explicit",
        provenance: options.provenance,
      };
    });

    try {
      const harness = integrationHarness();
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      const state = loopState(root);
      harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });
      const pending = harness.handlers.get("context")!({
        type: "context",
        messages: [{ role: "user", content: "current request" }],
      }, harness.ctx) as Promise<{ messages: Message[] }>;
      await vi.waitFor(() => expect(originalLoader).toHaveBeenCalledTimes(1));

      harness.handlers.get("session_before_switch")!({ type: "session_before_switch" }, harness.ctx);
      harness.branch.splice(0, harness.branch.length);
      harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);
      release.resolve();

      const result = await pending;
      expect(result.messages).toEqual([]);
      expect(harness.aborts).toBe(0);
      expect(harness.branch).toHaveLength(0);
    } finally {
      originalLoader.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pauses and aborts instead of issuing a provider turn for unsafe context", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    const state = loopState();
    harness.branch.push({ type: "custom", customType: GOAL_STATE_V2_TYPE, data: state });
    const result = await harness.handlers.get("context")!({
      type: "context",
      messages: [
        epochMarker(state),
        { role: "assistant", content: [{ type: "toolCall", id: "orphan", name: "read", arguments: {} }] },
      ],
    }, harness.ctx) as { messages: Message[] };

    expect(result.messages).toEqual([]);
    expect(harness.aborts).toBe(1);
    expect(harness.branch.at(-1)).toMatchObject({ customType: GOAL_STATE_V2_TYPE, data: { phase: "paused" } });
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it("leaves a V1 goal context untouched", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    harness.branch.push({ type: "custom", customType: "pi-goal-state-v1", data: {
      schemaVersion: 1,
      id: "goal-v1",
      generation: 1,
      status: "active",
      objective: "ordinary goal",
      criteria: [],
      createdAt: 1,
      updatedAt: 1,
      iteration: 0,
      consecutiveJudgeFailures: 0,
      verificationFailures: 0,
      noProgressCycles: 0,
    } });
    const messages = [{ role: "user", content: "legacy sentinel" }] as Message[];
    const result = await harness.handlers.get("context")!({ type: "context", messages }, harness.ctx);
    expect(result).toBeUndefined();
    expect((messages[0] as { content?: unknown })?.content).toBe("legacy sentinel");
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it("registers global entry switches and starts a verify V2 loop through CLI dispatch", async () => {
    const { harness, cleanup } = await explicitPlanHarness("pi-goal-cli-verify-", { verify: true });
    try {
      expect(harness.registeredFlags.get("verify")).toMatchObject({
        type: "boolean",
        default: false,
      });
      expect(harness.registeredFlags.get("implement")).toMatchObject({
        type: "boolean",
        default: false,
      });
      expect(harness.registeredFlags.get("verify").description).toMatch(/verification/u);
      expect(harness.registeredFlags.get("implement").description).toMatch(/implementation/u);
      expect(harness.registeredFlags.get("goal-loop")).toMatchObject({ type: "boolean" });
      expect(harness.registeredFlags.get("goal-plan")).toMatchObject({ type: "string" });
      expect(harness.registeredFlags.get("goal-max-cycles")).toMatchObject({ type: "string" });

      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      await vi.waitFor(() => expect(
        harness.branch.filter(entry => entry.customType === GOAL_STATE_V2_TYPE),
      ).toHaveLength(1));
      const state = harness.branch.findLast(entry => entry.customType === GOAL_STATE_V2_TYPE)?.data as GoalStateV2;
      expect(state).toMatchObject({
        phase: "implementing",
        objective: "Verify the referenced plan.",
        pendingVerificationEntry: true,
      });
    } finally {
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      await cleanup();
    }
  });

  it("requires a plan for a global --verify start through the existing resolver", async () => {
    const harness = integrationHarness({ flags: { verify: true } });
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    await vi.waitFor(() => expect(harness.notifications.mock.calls.some(([message]) =>
      String(message).includes("No approved plan is available"),
    )).toBe(true));
    expect(harness.emittedChannels).toContain(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL);
    expect(harness.branch.some(entry => entry.customType === GOAL_STATE_V2_TYPE)).toBe(false);
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it("rejects conflicting global entry switches before resolver or durable V2 state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-goal-cli-conflict-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const harness = integrationHarness({ flags: { verify: true, implement: true } });
    try {
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      expect(harness.notifications).toHaveBeenCalledWith(
        "--verify and --implement are mutually exclusive.",
        "error",
      );
      expect(harness.emittedChannels).not.toContain(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL);
      expect(harness.branch.some(entry => entry.customType === GOAL_STATE_V2_TYPE)).toBe(false);
      await expect(realpath(join(root, "goal-loops"))).rejects.toThrow();
    } finally {
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a global --implement loop with the normal objective", async () => {
    const { harness, cleanup } = await explicitPlanHarness("pi-goal-cli-implement-", { implement: true });
    try {
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      await vi.waitFor(() => expect(
        harness.branch.filter(entry => entry.customType === GOAL_STATE_V2_TYPE),
      ).toHaveLength(1));
      const state = harness.branch.findLast(entry => entry.customType === GOAL_STATE_V2_TYPE)?.data as GoalStateV2;
      expect(state.objective).toBe("Implement the referenced plan.");
      expect(state.pendingVerificationEntry).toBeUndefined();
    } finally {
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      await cleanup();
    }
  });

  it("preserves the existing global loop, plan, and max-cycle switches", async () => {
    const { harness, cleanup } = await explicitPlanHarness("pi-goal-cli-existing-", {
      "goal-loop": true,
      "goal-max-cycles": "7",
    });
    try {
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      await vi.waitFor(() => expect(
        harness.branch.filter(entry => entry.customType === GOAL_STATE_V2_TYPE),
      ).toHaveLength(1));
      const state = harness.branch.findLast(entry => entry.customType === GOAL_STATE_V2_TYPE)?.data as GoalStateV2;
      expect(state).toMatchObject({
        objective: "Implement the referenced plan.",
        maxCycles: 7,
      });
      expect(state.pendingVerificationEntry).toBeUndefined();
    } finally {
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      await cleanup();
    }
  });

  it.each([
    { label: "verify default", args: "--verify", objective: "Verify the referenced plan.", pending: true },
    { label: "implement default", args: "--implement", objective: "Implement the referenced plan.", pending: false },
    { label: "verify explicit", args: "Inspect the implementation --verify", objective: "Inspect the implementation", pending: true },
    { label: "implement explicit", args: "Improve the implementation --implement", objective: "Improve the implementation", pending: false },
  ])("forwards slash objective $label entry metadata", async ({ args, objective, pending }) => {
    const { harness, sourcePath, cleanup } = await explicitPlanHarness("pi-goal-slash-entry-", {}, false);
    try {
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      await harness.command.handler(`${args} --plan ${sourcePath}`, harness.commandContext());
      const state = harness.branch.findLast(entry => entry.customType === GOAL_STATE_V2_TYPE)?.data as GoalStateV2;
      expect(state.objective).toBe(objective);
      expect(state.pendingVerificationEntry).toBe(pending ? true : undefined);
    } finally {
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      await cleanup();
    }
  });

  it.each([
    { switch: "verify", objective: "Verify the referenced plan." },
    { switch: "implement", objective: "Implement the referenced plan." },
  ])("forwards /goal fresh --$switch entry metadata", async ({ switch: entry, objective }) => {
    const { harness, sourcePath, cleanup } = await explicitPlanHarness("pi-goal-fresh-entry-", {}, false);
    const unsubscribe = harness.pi.events.on(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL, (request: any) => {
      harness.pi.events.emit(`${PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL}:reply:${request.requestId}`, {
        version: 1,
        requestId: request.requestId,
        result: {
          version: 1,
          sourceKind: "approved",
          sourcePath,
          planPath: sourcePath,
          action: "yolo-direct",
          strategy: "YOLO",
        },
      });
    });
    try {
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      await harness.command.handler(`fresh --${entry}`, harness.commandContext());
      const state = harness.branch.findLast(item => item.customType === GOAL_STATE_V2_TYPE)?.data as GoalStateV2;
      expect(state.objective).toBe(objective);
      expect(state.pendingVerificationEntry).toBe(entry === "verify" ? true : undefined);
    } finally {
      unsubscribe();
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      await cleanup();
    }
  });

  it("keeps bare /goal start on the V1 path", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
    await harness.command.handler("start", harness.commandContext());
    expect(harness.branch.some(entry => entry.customType === GOAL_STATE_V2_TYPE)).toBe(false);
    expect(harness.branch.findLast(entry => entry.customType === GOAL_STATE_TYPE)?.data).toMatchObject({
      status: "active",
      objective: "start",
    });
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });

  it("does not persist slash entry conflicts before parser errors are reported", async () => {
    const { harness, sourcePath, cleanup } = await explicitPlanHarness("pi-goal-slash-conflict-", {}, false);
    try {
      await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
      await harness.command.handler(`objective --verify --implement --plan ${sourcePath}`, harness.commandContext());
      expect(harness.branch.some(entry => entry.customType === GOAL_STATE_V2_TYPE)).toBe(false);
      expect(harness.notifications).toHaveBeenCalledWith(
        "--verify and --implement are mutually exclusive.",
        "error",
      );
    } finally {
      await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
      await cleanup();
    }
  });

  it("offers loop management, entry switches, and delegates --plan path completion to the ordinary provider", async () => {
    const harness = integrationHarness();
    await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);

    const builtinLine = "/resume";
    const builtin = harness.provider.applyCompletion(
      [builtinLine],
      0,
      builtinLine.length,
      { value: "resume", label: "resume" },
      builtinLine,
    );
    expect(builtin.lines[0]).toBe("/resume");
    expect(harness.baseCompletionApplications).toBe(1);

    const management = await harness.provider.getSuggestions(["/goal st"], 0, 9, { signal: new AbortController().signal });
    expect(management?.items.map((item: any) => item.value)).toContain("status");
    const objectiveEntries = harness.command.getArgumentCompletions("Implement --") ?? [];
    expect(objectiveEntries.map((item: any) => item.value)).toEqual(expect.arrayContaining([
      "Implement --verify",
      "Implement --implement",
    ]));
    expect(objectiveEntries.find((item: any) => item.value === "Implement --verify")?.description).toMatch(/no-edit/u);
    const freshEntries = harness.command.getArgumentCompletions("fresh --") ?? [];
    expect(freshEntries.map((item: any) => item.value)).toEqual(expect.arrayContaining([
      "fresh --verify",
      "fresh --implement",
    ]));
    expect(freshEntries.map((item: any) => item.value)).not.toContain("fresh start");

    const pathLine = "/goal --loop --plan plans/";
    const path = await harness.provider.getSuggestions([pathLine], 0, pathLine.length, { signal: new AbortController().signal });
    expect(path?.items[0]?.value).toBe("plans/approved.md");
    const applied = harness.provider.applyCompletion(
      [pathLine],
      0,
      pathLine.length,
      path!.items[0],
      path!.prefix,
    );
    expect(applied.lines[0]).toBe("/goal --loop --plan plans/approved.md");
    await harness.handlers.get("session_shutdown")!({ type: "session_shutdown" }, harness.ctx);
  });
});
