import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import goalExtension from "../src/index.js";
import {
  buildContextEpochBootstrap,
  createContextEpochMarker,
} from "../src/context-epoch.js";
import { GOAL_CONTEXT_EPOCH_TYPE, GOAL_STATE_V2_TYPE, type GoalStateV2 } from "../src/types.js";

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
    continuationInstruction: "Continue implementing the current immutable plan, then stop for GoalJudge and independent GoalVerifier evaluation.",
  });
  return createContextEpochMarker(bootstrap, { timestamp: 1 });
}

function integrationHarness() {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const branch: any[] = [];
  let provider: any;
  let command: any;
  let baseCompletionApplications = 0;
  const sentMessages: any[] = [];
  const sessionManager = {
    getBranch: () => branch,
    buildContextEntries: () => branch,
    getSessionId: () => "integration-session",
    getLeafId: () => "integration-leaf",
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
    notify() {},
  };
  const ctx = {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    ui,
    isIdle: () => true,
    hasPendingMessages: () => false,
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
      for (const listener of [...(listeners.get(channel) ?? [])]) listener(data);
    },
  };
  const pi = {
    events,
    on(name: string, handler: (event: any, eventCtx: any) => unknown) { handlers.set(name, handler); },
    registerCommand(_name: string, value: any) { command = value; },
    registerFlag() {},
    getFlag() { return undefined; },
    appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    sendMessage(message: unknown) {
      if (typeof message === "object" && message !== null && "customType" in message) {
        const persisted = { role: "custom", ...message } as Record<string, unknown>;
        if (persisted.customType === GOAL_CONTEXT_EPOCH_TYPE && typeof persisted.timestamp !== "number") {
          persisted.timestamp = 0;
        }
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
    command,
    sentMessages,
    get provider() { return provider; },
    get baseCompletionApplications() { return baseCompletionApplications; },
    sessionManager,
  };
}

type Message = ContextEvent["messages"][number];

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

  it("offers loop management and delegates --plan path completion to the ordinary provider", async () => {
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
    expect(harness.command.getArgumentCompletions("Implement --")?.[0]?.value).toBe("Implement --loop");

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
