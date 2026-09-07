import { describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  createProgressCheckpointController,
  type ProgressCheckpointConfig,
} from "../src/progress-checkpoint.js";
import {
  createProgressRuntime,
  PROGRESS_CHECKPOINT_STEERING_MARKER,
  PROGRESS_REPORT_TOOL_NAME,
} from "../src/progress-runtime.js";

const activation = { explicit: true, orchestratorOwned: true } as const;

function makeController(overrides: Partial<ProgressCheckpointConfig> = {}) {
  return createProgressCheckpointController({
    activation,
    displayTokenInterval: 2,
    ...overrides,
  });
}

function assistantEvent(usage: Record<string, number>, stopReason: "toolUse" | "stop" = "toolUse") {
  return {
    type: "message_end" as const,
    message: {
      role: "assistant" as const,
      usage,
      stopReason,
    },
  } as never;
}

function turnEnd(stopReason: "toolUse" | "stop" = "toolUse") {
  return {
    type: "turn_end" as const,
    message: { role: "assistant" as const, stopReason },
    toolResults: [],
  } as never;
}

describe("progress runtime adapter", () => {
  it("reports lifetime display tokens without cache reads and steers only after tool completion", async () => {
    const controller = makeController();
    const steers: string[] = [];
    const attention: unknown[] = [];
    const runtime = createProgressRuntime(controller, (message) => {
      steers.push(message);
    }, (effect) => {
      attention.push(effect);
    });

    const usage = assistantEvent({ input: 1, output: 1, cacheRead: 10, cacheWrite: 0 });
    runtime.observe(usage);
    runtime.observe(usage);
    expect(runtime.snapshot().displayTokens).toBe(2);
    runtime.observe({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "inspect",
      args: { path: "a" },
    } as never);
    runtime.observe({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "inspect",
      result: { text: "done" },
      isError: false,
    } as never);
    expect(steers).toEqual([]);

    const effects = runtime.observe(turnEnd());
    expect(effects).toMatchObject([{ type: "checkpoint-request" }]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain(PROGRESS_CHECKPOINT_STEERING_MARKER);
    expect(steers[0]).toContain(PROGRESS_REPORT_TOOL_NAME);
    expect(steers[0]).toContain("progress-checkpoint-1");
    expect(attention).toEqual([]);

    const reportTool = runtime.reportTool;
    const first = await reportTool.execute("report-1", {
      checkpointId: "progress-checkpoint-1",
      progress: "inspected the file",
      evidence: "the tool returned done",
      blocker: "",
      nextAction: "continue",
    }, undefined, undefined, undefined as never);
    expect(first.details).toEqual({ accepted: true, checkpointId: "progress-checkpoint-1" });

    const duplicate = await reportTool.execute("report-2", {
      checkpointId: "progress-checkpoint-1",
      progress: "same",
      evidence: "same evidence",
      blocker: "",
      nextAction: "continue",
    }, undefined, undefined, undefined as never);
    expect(duplicate.details).toEqual({ accepted: false, checkpointId: "progress-checkpoint-1" });
  });

  it("uses completed action/result hashes for repeated-tool detection", () => {
    const controller = makeController({ displayTokenInterval: 10_000, repeatedFingerprintThreshold: 2 });
    const steers: string[] = [];
    const runtime = createProgressRuntime(controller, (message) => { steers.push(message); }, () => {});
    const observeTool = (id: string) => {
      runtime.observe({ type: "tool_execution_start", toolCallId: id, toolName: "inspect", args: { path: "same" } } as never);
      runtime.observe({ type: "tool_execution_end", toolCallId: id, toolName: "inspect", result: "same", isError: false } as never);
    };
    observeTool("one");
    expect(runtime.observe(turnEnd())).toEqual([]);
    observeTool("two");
    expect(runtime.observe(turnEnd())).toMatchObject([{ type: "checkpoint-request", reason: "repeated-fingerprint" }]);
    expect(steers).toHaveLength(1);
  });

  it("calls attention once, and cancellation/settlement are idempotent and never steer", async () => {
    const controller = makeController({ repeatedReportThreshold: 2 });
    const steers: string[] = [];
    const attention: unknown[] = [];
    const runtime = createProgressRuntime({
      controller,
      steer: (message) => { steers.push(message); },
      onAttention: (effect) => { attention.push(effect); },
    });

    runtime.observe(assistantEvent({ input: 1, output: 1, cacheRead: 100, cacheWrite: 0 }));
    runtime.observe(turnEnd());
    const report = {
      checkpointId: "progress-checkpoint-1",
      progress: "working",
      evidence: "one fact",
      blocker: "",
      nextAction: "continue",
    } as const;
    expect((await runtime.reportTool.execute("r1", report, undefined, undefined, undefined as never)).details)
      .toEqual({ accepted: true, checkpointId: report.checkpointId });

    runtime.observe(assistantEvent({ input: 1, output: 1, cacheRead: 100, cacheWrite: 0 }));
    runtime.observe(turnEnd());
    const secondReport = { ...report, checkpointId: controller.snapshot().pendingCheckpoint?.checkpointId ?? "" };
    expect((await runtime.reportTool.execute("r2", secondReport, undefined, undefined, undefined as never)).details)
      .toEqual({ accepted: true, checkpointId: "progress-checkpoint-2" });
    runtime.observe(turnEnd());
    runtime.observe(turnEnd());
    expect(attention).toHaveLength(1);

    const canceled = createProgressRuntime(makeController(), (message) => { steers.push(message); }, () => {});
    canceled.observe(assistantEvent({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }));
    canceled.cancel();
    canceled.cancel();
    canceled.observe(turnEnd());
    expect(steers).toHaveLength(2);

    const settled = createProgressRuntime(makeController(), (message) => { steers.push(message); }, () => {});
    settled.observe(assistantEvent({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }));
    settled.settle();
    settled.settle();
    settled.observe(turnEnd());
    expect(steers).toHaveLength(2);
  });
});

interface ProviderCall {
  readonly tools: readonly string[];
  readonly messages: readonly unknown[];
}

const usage = {
  input: 1,
  output: 1,
  cacheRead: 100,
  cacheWrite: 0,
  totalTokens: 102,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function resultMessage(
  model: Model<any>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function offlineStream(
  model: Model<any>,
  context: Context,
  calls: ProviderCall[],
  checkpointId: () => string | undefined,
) {
  calls.push({
    tools: (context.tools ?? []).map((tool) => tool.name),
    messages: structuredClone(context.messages),
  });
  const callNumber = calls.length;
  const message = callNumber === 1
    ? resultMessage(model, [{
        type: "toolCall",
        id: "work-1",
        name: "inspect",
        arguments: {},
      }], "toolUse")
    : callNumber === 2
      ? resultMessage(model, [{
          type: "toolCall",
          id: "report-1",
          name: PROGRESS_REPORT_TOOL_NAME,
          arguments: {
            checkpointId: checkpointId() ?? "missing-checkpoint",
            progress: "finished inspection",
            evidence: "the inspect tool returned its completed result",
            blocker: "",
            nextAction: "finish",
          },
        }], "toolUse")
      : resultMessage(model, [{ type: "text", text: "final answer" }], "stop");
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end();
  });
  return stream;
}

const inspectTool = defineTool({
  name: "inspect",
  label: "inspect",
  description: "Inspect the assigned item.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text" as const, text: "inspection complete" }], details: {} };
  },
});

describe("progress runtime against installed SDK timing", () => {
  it("steers after a completed tool and makes no model call after final completion", async () => {
    const calls: ProviderCall[] = [];
    const runtimeModel = await ModelRuntime.create({
      modelsPath: null,
      credentials: new InMemoryCredentialStore(),
    });
    runtimeModel.registerProvider("progress-test", {
      baseUrl: "http://offline.invalid/v1",
      api: "openai-completions",
      apiKey: "offline-test-key",
      models: [{
        id: "progress-test-model",
        name: "progress-test-model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32_000,
        maxTokens: 256,
      }],
      streamSimple: (model, context) => offlineStream(model, context, calls, () => checkpointId),
    });
    const model = runtimeModel.getModel("progress-test", "progress-test-model");
    if (!model) throw new Error("offline progress model was not registered");

    const controller = makeController();
    let checkpointId: string | undefined;
    const lifecycle: string[] = [];
    let session!: AgentSession;
    const runtime = createProgressRuntime(
      controller,
      (message) => {
        lifecycle.push("steer");
        const match = message.match(/Checkpoint ID: ("[^"]+")/);
        if (match?.[1]) checkpointId = JSON.parse(match[1]) as string;
        return session.steer(message);
      },
      () => { lifecycle.push("attention"); },
    );
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: process.cwd(),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const created = await createAgentSession({
      cwd: process.cwd(),
      model,
      modelRuntime: runtimeModel,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      tools: ["inspect"],
      customTools: [inspectTool, runtime.reportTool],
      thinkingLevel: "off",
    });
    session = created.session;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end") lifecycle.push("tool-end");
      runtime.observe(event);
    });
    try {
      await session.prompt("Inspect the assigned item.");
      expect(calls).toHaveLength(3);
      expect(checkpointId).toBe("progress-checkpoint-1");
      expect(lifecycle.indexOf("tool-end")).toBeGreaterThanOrEqual(0);
      expect(lifecycle.indexOf("steer")).toBeGreaterThan(lifecycle.indexOf("tool-end"));
      expect(lifecycle).not.toContain("attention");
      expect(calls[2]?.messages).toBeDefined();
      const completedCallCount = calls.length;
      await session.waitForIdle();
      expect(calls).toHaveLength(completedCallCount);
    } finally {
      unsubscribe();
      session.dispose();
    }
  });
});
