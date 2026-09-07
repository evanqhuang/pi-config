import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "../src/agent-types.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";

const REPORT_TOOL = "report_progress";

const baseCard = {
  name: "wiring-test",
  description: "wiring test worker",
  extensions: false as const,
  skills: false as const,
  systemPrompt: "",
  promptMode: "replace" as const,
};

let root: string;
let runtime: ModelRuntime;
let model: Model<any>;
let calls: string[][];

function resultMessage(current: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: current.api,
    provider: current.provider,
    model: current.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function offlineStream(current: Model<any>, context: Context) {
  calls.push((context.tools ?? []).map(tool => tool.name));
  const stream = createAssistantMessageEventStream();
  const message = resultMessage(current);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}

function context() {
  const registry = {
    find: (provider: string, id: string) => runtime.getModel(provider, id),
    getAvailable: () => [model],
    runtime,
  };
  return {
    cwd: root,
    model,
    modelRegistry: registry,
    getSystemPrompt: () => "",
  } as any;
}

const pi = {
  exec: async () => ({ code: 1, stdout: "", stderr: "" }),
} as any;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-progress-wiring-"));
  calls = [];
  runtime = await ModelRuntime.create({
    modelsPath: null,
    credentials: new InMemoryCredentialStore(),
  });
  runtime.registerProvider("progress-wiring", {
    baseUrl: "http://offline.invalid/v1",
    api: "openai-completions",
    apiKey: "offline-test-key",
    models: [{
      id: "offline",
      name: "offline",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 128,
    }],
    streamSimple: offlineStream,
  });
  model = runtime.getModel("progress-wiring", "offline")!;
  registerAgents(new Map([["wiring-test", baseCard]]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function run(orchestratorOwned?: boolean, type = "wiring-test") {
  const result = await runAgent(context(), type, "do the work", {
    pi,
    model,
    isolated: true,
    orchestratorOwned,
  });
  result.session.dispose();
  return result;
}

describe("bounded progress checkpoint runner wiring", () => {
  it("adds the worker report tool only for explicit orchestrator ownership", async () => {
    await run(true);
    expect(calls[0]).toContain(REPORT_TOOL);

    calls.length = 0;
    await run();
    expect(calls[0]).not.toContain(REPORT_TOOL);
  });

  it("keeps native goal workers disabled even when ownership is forwarded", async () => {
    registerAgents(new Map([["GoalJudge", { ...baseCard, name: "GoalJudge" }]]));
    calls.length = 0;
    await run(true, "GoalJudge");
    expect(calls[0]).not.toContain(REPORT_TOOL);
  });

  it("preserves lifetime baselines across explicit resume and does not steer after completion", async () => {
    const first = await runAgent(context(), "wiring-test", "do the work", {
      pi,
      model,
      isolated: true,
      orchestratorOwned: true,
    });
    const runtimeAdapter = first.progressRuntime!;
    const firstTokens = runtimeAdapter.snapshot().displayTokens;
    const originalSteer = first.session.steer.bind(first.session);
    let steerCalls = 0;
    first.session.steer = async (...args: Parameters<typeof first.session.steer>) => {
      steerCalls++;
      return originalSteer(...args);
    };
    const resumed = await resumeAgent(first.session, "continue", {
      progressRuntime: runtimeAdapter,
      continueFromParent: true,
    });
    expect(resumed.checkpointSnapshot?.displayTokens).toBeGreaterThan(firstTokens);

    runtimeAdapter.requestCheckpoint("manual");
    runtimeAdapter.observe({
      type: "turn_end",
      message: { role: "assistant", stopReason: "toolUse" },
      toolResults: [],
    } as never);
    expect(steerCalls).toBe(0);
    first.session.dispose();
  });

  it("does not retain raw output in the runner checkpoint result", async () => {
    const result = await run(true);
    expect(result.checkpointSnapshot).toMatchObject({ lifecycle: "alive" });
    expect(JSON.stringify(result.checkpointSnapshot)).not.toContain("do the work");
    expect(JSON.stringify(result.checkpointSnapshot)).not.toContain("done");
  });
});
