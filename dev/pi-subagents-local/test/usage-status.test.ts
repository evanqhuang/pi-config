import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  calls: 0,
}));

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/agent-runner.js")>()),
  runAgent: runnerMocks.runAgent,
}));

import extension from "../src/index.js";

interface Handler {
  (data?: any, ctx?: any): unknown;
}

function fakePi() {
  const hostHandlers = new Map<string, Handler[]>();
  const eventHandlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, { handler: Handler }>();
  const entries: Array<{ customType: string; data: any }> = [];
  const events = {
    on(event: string, handler: Handler) {
      const list = eventHandlers.get(event) ?? [];
      list.push(handler);
      eventHandlers.set(event, list);
      return () => eventHandlers.set(event, (eventHandlers.get(event) ?? []).filter(item => item !== handler));
    },
    emit(event: string, data: unknown) {
      for (const handler of [...(eventHandlers.get(event) ?? [])]) void handler(data);
    },
  };
  const pi = {
    events,
    registerMessageRenderer: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
    registerShortcut: () => {},
    on(event: string, handler: Handler) {
      const list = hostHandlers.get(event) ?? [];
      list.push(handler);
      hostHandlers.set(event, list);
      return () => hostHandlers.set(event, (hostHandlers.get(event) ?? []).filter(item => item !== handler));
    },
    sendMessage: () => {},
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
  };
  return {
    pi,
    tools,
    commands,
    entries,
    emitHost(event: string, data: unknown, ctx: unknown) {
      for (const handler of [...(hostHandlers.get(event) ?? [])]) void handler(data, ctx);
    },
    shutdownHandlers: () => [...(hostHandlers.get("session_shutdown") ?? [])],
  };
}

const parentModel = {
  provider: "parent-provider",
  id: "parent-model",
  name: "Parent Model",
};

function context(cwd: string, notifications: string[]) {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    model: parentModel,
    modelRegistry: {},
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      onTerminalInput: () => () => {},
      addAutocompleteProvider: () => {},
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
    },
    getSystemPrompt: () => "",
  };
}

let roots: string[] = [];
let previousAgentDir: string | undefined;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  previousAgentDir = undefined;
  runnerMocks.runAgent.mockReset();
  runnerMocks.calls = 0;
});

describe("registered current-run usage and status", () => {
  it("separates parent/worker direct totals, preserves evicted totals, and reports gaps without provider calls", async () => {
    const root = await mkdtemp(join("/tmp", "pi-usage-status-"));
    roots.push(root);
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ reportUsage: true, usageWarningUsd: 1 }));
    process.env.PI_CODING_AGENT_DIR = agentDir;

    runnerMocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const call = ++runnerMocks.calls;
      expect(options.orchestratorOwned).toBe(true);
      const workerModel = {
        provider: "worker-provider",
        id: "worker-model",
        name: "Worker Model",
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      };
      const session = { model: workerModel, messages: [], dispose() {} };
      const usage = { input: 7, output: 2, cacheWrite: 1, cacheRead: 4, cost: 5 };
      options.onSessionCreated?.(session);
      options.onUsageContribution?.({
        provider: workerModel.provider,
        model: workerModel.id,
        attemptId: `worker-attempt-${call}`,
        messageId: "1",
        usage,
      });
      // The legacy callback is intentionally also fired. AgentManager must use
      // the contribution identity for direct ledgers, while this remains the
      // sole PendingUsagePool path for parent-session accounting.
      options.onAssistantUsage?.(usage);
      options.onCompaction?.({ reason: "threshold", tokensBefore: 100 });
      return { responseText: "worker result", session, aborted: false, steered: false };
    });

    const fake = fakePi();
    const notifications: string[] = [];
    const ctx = context(root, notifications);
    extension(fake.pi as any);

    const lifecycle: Record<string, any[]> = { started: [], completed: [], compacted: [] };
    for (const name of Object.keys(lifecycle)) {
      fake.pi.events.on(`subagents:${name}`, data => lifecycle[name].push(data));
    }

    const agent = fake.tools.get("Agent");
    expect(agent).toBeDefined();
    const agentResult = await agent.execute(
      "call-1",
      {
        prompt: "do work",
        description: "do work",
        subagent_type: "general-purpose",
        orchestrator_owned: true,
        thinking: "high",
        run_in_background: false,
      },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(runnerMocks.calls).toBe(1);
    expect(agentResult.content[0].text).toContain("worker result");
    expect(agentResult.usage).toMatchObject({ input: 7, output: 2, cacheRead: 4 });
    expect(agentResult.details).toMatchObject({
      model: "worker-provider/worker-model",
      thinking: "high",
      directUsageLedger: expect.objectContaining({ version: 1 }),
      inclusiveUsage: expect.objectContaining({ input: 7, output: 2 }),
    });

    expect(lifecycle.started[0]).toMatchObject({ model: "parent-provider/parent-model", thinking: "high" });
    expect(lifecycle.completed[0]).toMatchObject({
      model: "worker-provider/worker-model",
      thinking: "high",
      directUsageLedger: expect.objectContaining({ contributionCount: 1 }),
      inclusiveUsage: expect.objectContaining({ input: 7, output: 2 }),
    });
    expect(lifecycle.compacted[0]).toMatchObject({
      model: "worker-provider/worker-model",
      directUsageLedger: expect.objectContaining({ contributionCount: 1 }),
      inclusiveUsage: expect.objectContaining({ input: 7, output: 2 }),
    });

    // Parent events are the only source of parent direct usage. A zero SDK cost
    // with no model rates remains visibly unknown rather than a free charge.
    fake.emitHost("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        provider: "parent-provider",
        model: "parent-model",
        responseId: "parent-response-1",
        timestamp: 1,
        usage: { input: 11, output: 3, cacheRead: 2, cacheWrite: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
    }, ctx);

    const usageEntriesBeforeCommand = fake.entries.filter(entry => entry.customType === "subagents:usage").length;
    const command = fake.commands.get("agents");
    expect(command).toBeDefined();
    await command!.handler("usage", ctx);
    const status = notifications.at(-1) ?? "";
    expect(status).toContain("parent: display tokens 15");
    expect(status).toContain("parent: ");
    expect(status).toContain("cost unavailable");
    expect(status).toContain("workers: display tokens 10");
    expect(status).toContain("worker-provider/worker-model");
    expect(status).toContain("configured threshold");
    expect(status).not.toContain("toolResult");
    const usageEntries = fake.entries.filter(entry => entry.customType === "subagents:usage");
    expect(usageEntries.length).toBeGreaterThanOrEqual(3); // started, compacted, completed
    expect(usageEntries.every(entry => entry.data.version === 1)).toBe(true);
    expect(usageEntries.every(entry => entry.data.parent && entry.data.workerTotals)).toBe(true);

    // Repeated retrieval/rendering is read-only. PendingUsagePool was drained
    // by the Agent tool once, and get_subagent_result cannot duplicate it.
    const getResult = fake.tools.get("get_subagent_result");
    const first = await getResult.execute("get-1", { agent_id: lifecycle.completed[0].id }, undefined, undefined, ctx);
    const second = await getResult.execute("get-2", { agent_id: lifecycle.completed[0].id }, undefined, undefined, ctx);
    expect(first.usage).toBeUndefined();
    expect(second.usage).toBeUndefined();
    await command!.handler("usage", ctx);
    expect(notifications.at(-1)).toBe(status);
    expect(fake.entries.filter(entry => entry.customType === "subagents:usage")).toHaveLength(usageEntriesBeforeCommand);

    // Resume/fork history is not scanned or reconstructed; the command keeps
    // current-run totals and explicitly marks the restored-history gap.
    fake.emitHost("session_start", { type: "session_start", reason: "resume", previousSessionFile: "old.json" }, ctx);
    await new Promise(resolve => setTimeout(resolve, 0));
    await command!.handler("usage", ctx);
    const restoredStatus = notifications.at(-1) ?? "";
    expect(restoredStatus).toContain("restored history usage gap");
    expect(restoredStatus).toContain("workers: display tokens 10");
    expect(restoredStatus).not.toContain("worker status:");

    // Marking the result consumed allows manager eviction; workerTotals still
    // render the exact direct total after the record disappears.
    await fake.shutdownHandlers()[0]?.({});
  });
});
