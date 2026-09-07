import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/agent-runner.js", async original => ({
  ...(await original<typeof import("../src/agent-runner.js")>()), runAgent: runner.run,
}));
import extension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import { getDirectUsageTotals } from "../src/usage.js";
import { fakePi, context } from "./helpers/extension-harness.js";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; vi.useRealTimers(); runner.run.mockReset(); });

async function setup(settings: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-group-completion-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global");
  await mkdir(join(root, "global", "agents"), { recursive: true });
  await writeFile(join(root, "global", "agents", "ImplementationWorker.md"), "---\nname: ImplementationWorker\ndescription: bounded implementation\ntools: all\nextensions: false\nskills: false\n---\nImplement the assigned unit.");
  await writeFile(join(root, "global", "subagents.json"), JSON.stringify(settings));
  const harness = fakePi();
  const ctx = context(root, harness.ui);
  const finishers = new Map<string, (value: any) => void>();
  runner.run.mockImplementation((_ctx: any, _type: string, prompt: string, options: any) => new Promise(resolve => {
    finishers.set(prompt, resolve);
    options.signal?.addEventListener("abort", () => resolve({ responseText: "cancelled", aborted: true, steered: false }), { once: true });
  }));
  extension(harness.pi as any);
  const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
  vi.useFakeTimers();
  const event = async (name: string, data: any) => {
    for (const handler of harness.handlers.get(name) ?? []) await handler(data, ctx);
  };
  cleanup = async () => {
    for (const finish of finishers.values()) finish({ responseText: "done", aborted: false, steered: false });
    await event("session_shutdown", {});
    await manager.waitForAll();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  };
  const launchResults: any[] = [];
  const launch = async (id: string) => {
    const result = await harness.tools.get("Agent").execute(id, { subagent_type: "ImplementationWorker", description: id, prompt: id, orchestrator_owned: true, run_in_background: true }, undefined, undefined, ctx);
    launchResults.push(result);
    expect(result.details, JSON.stringify(result)).toBeDefined();
    return manager.getRecord(result.details.agentId);
  };
  const finish = async (record: any) => {
    finishers.get(record.description)!({ responseText: record.description + " completed", aborted: false, steered: false });
    await record.promise;
  };
  return { ...harness, ctx, manager, event, launch, finish, launchResults };
}

it("joins slow sibling launches from one preflighted batch before notifying", async () => {
  const h = await setup();
  await h.event("tool_execution_start", { toolName: "Agent", toolCallId: "a" });
  await h.event("tool_execution_start", { toolName: "Agent", toolCallId: "b" });
  const a = await h.launch("a");
  await h.event("tool_execution_end", { toolName: "Agent", toolCallId: "a" });
  await h.finish(a);
  await vi.advanceTimersByTimeAsync(500);
  expect(h.messages).toHaveLength(0);
  const b = await h.launch("b");
  await h.event("tool_execution_end", { toolName: "Agent", toolCallId: "b" });
  await h.finish(b);
  await vi.advanceTimersByTimeAsync(300);
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0].details.id).toBe(a.id);
  expect(h.messages[0].details.others[0].id).toBe(b.id);
});

it("counts consumed completions as settled without delaying remaining results", async () => {
  const h = await setup();
  const a = await h.launch("a");
  const b = await h.launch("b");
  await h.finish(a);
  await h.tools.get("get_subagent_result").execute("consume", { agent_id: a.id }, undefined, undefined, h.ctx);
  await vi.advanceTimersByTimeAsync(100);
  await h.finish(b);
  await vi.advanceTimersByTimeAsync(300);
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0].content).toContain("b completed");
  expect(h.messages[0].content).not.toContain("a completed");
});

it("shutdown cancels batch timers and held group deliveries", async () => {
  const h = await setup();
  const a = await h.launch("a");
  await h.launch("b");
  await h.finish(a);
  await vi.advanceTimersByTimeAsync(100);
  await h.event("session_shutdown", {});
  await vi.advanceTimersByTimeAsync(31_000);
  expect(h.messages).toHaveLength(0);
});


it("delivers timeout partials and later stragglers exactly once", async () => {
  const h = await setup();
  const a = await h.launch("a");
  const b = await h.launch("b");
  const c = await h.launch("c");
  const d = await h.launch("d");
  await vi.advanceTimersByTimeAsync(100);
  await h.finish(a);
  await vi.advanceTimersByTimeAsync(30_200);
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0].content).toContain("partial");
  expect(h.messages[0].details.id).toBe(a.id);
  await h.finish(b);
  await vi.advanceTimersByTimeAsync(15_200);
  expect(h.messages).toHaveLength(2);
  expect(h.messages[1].details.id).toBe(b.id);
  await h.finish(c);
  await h.finish(d);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.messages).toHaveLength(3);
  expect(h.messages[2].details.id).toBe(c.id);
  expect(h.messages[2].details.others[0].id).toBe(d.id);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.messages).toHaveLength(3);
});

it("suppresses every consumed result even after group delivery is queued", async () => {
  const h = await setup();
  const a = await h.launch("a");
  const b = await h.launch("b");
  await vi.advanceTimersByTimeAsync(100);
  await h.finish(a);
  await h.finish(b);
  for (const record of [a, b]) await h.tools.get("get_subagent_result").execute("consume-" + record.id, { agent_id: record.id }, undefined, undefined, h.ctx);
  await vi.advanceTimersByTimeAsync(30_500);
  expect(h.messages).toHaveLength(0);
});

it("an aborted result wait leaves a productive worker available for eventual delivery", async () => {
  const h = await setup();
  const a = await h.launch("a");
  const abort = new AbortController();
  const waiting = h.tools.get("get_subagent_result").execute("wait", { agent_id: a.id, wait: true }, abort.signal, undefined, h.ctx);
  const rejected = expect(waiting).rejects.toThrow();
  abort.abort();
  await rejected;
  expect(a.status).toBe("running");
  expect(a.resultConsumed).not.toBe(true);
  await h.finish(a);
  await vi.advanceTimersByTimeAsync(300);
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0].details.id).toBe(a.id);
});

it("honors an explicit async join setting for owned workers", async () => {
  const h = await setup({ defaultJoinMode: "async" });
  const a = await h.launch("a");
  const b = await h.launch("b");
  await h.finish(a);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.messages).toHaveLength(1);
  expect(h.messages[0].details.id).toBe(a.id);
  await h.finish(b);
  await vi.advanceTimersByTimeAsync(200);
  expect(h.messages).toHaveLength(2);
  expect(h.messages[1].details.id).toBe(b.id);
});


it("keeps successive parent tool batches separate even within the debounce window", async () => {
  const h = await setup();
  const records = [];
  for (const id of ["a", "b"]) {
    await h.event("tool_execution_start", { toolName: "Agent", toolCallId: id });
    records.push(await h.launch(id));
    await h.event("tool_execution_end", { toolName: "Agent", toolCallId: id });
  }
  for (const record of records) await h.finish(record);
  await vi.advanceTimersByTimeAsync(300);
  expect(h.messages).toHaveLength(2);
  expect(h.messages.map(message => message.details.id)).toEqual(records.map(record => record.id));
});


it("group delivery and retrieval keep direct usage separate from descendant-inclusive usage", async () => {
  const h = await setup({ reportUsage: true });
  await writeFile(join(h.ctx.cwd, "global", "agents", "UsageChild.md"), "---\nname: UsageChild\ndescription: usage fixture\n---\nReturn a handoff.");
  const finishers = new Map<string, (value: any) => void>();
  let runtimeManager: any;
  runner.run.mockImplementation(async (_ctx: any, _type: string, prompt: string, options: any) => {
    runtimeManager = options.nestedRuntime.manager;
    const child = prompt === "child";
    const usage = { input: child ? 3 : 7, output: child ? 1 : 2, cacheWrite: 1, cacheRead: 4, cost: 1 };
    const contribution = { provider: "test", model: "fixture", attemptId: prompt, messageId: "1", usage };
    options.onUsageContribution(contribution);
    options.onUsageContribution(contribution);
    options.onAssistantUsage(usage);
    if (prompt === "a") {
      const nested = createNestedSubagentTools({ manager: runtimeManager, pi: h.pi as any, parentAgentId: options.nestedRuntime.parentAgentId, depth: 1, maxSubagentDepth: 2, allowedSubagents: ["UsageChild"], configCwd: h.ctx.cwd });
      const result = await nested.find(tool => tool.name === "Agent")!.execute("child-call", { subagent_type: "UsageChild", description: "child", prompt: "child" }, undefined, undefined, h.ctx);
      expect(result, JSON.stringify(result)).not.toHaveProperty("isError", true);
    }
    if (child) return { responseText: "child complete", aborted: false, steered: false };
    return new Promise(resolve => {
      finishers.set(prompt, resolve);
      options.signal.addEventListener("abort", () => resolve({ responseText: "cancelled", aborted: true, steered: false }), { once: true });
    });
  });
  const a = await h.launch("a");
  const b = await h.launch("b");
  await vi.advanceTimersByTimeAsync(100);
  expect(a.status, a.error).not.toBe("error");
  expect(b.status, b.error).not.toBe("error");
  for (const id of ["a", "b"]) finishers.get(id)!({ responseText: id + " complete", aborted: false, steered: false });
  await h.manager.waitForAll();
  await vi.advanceTimersByTimeAsync(200);
  expect(h.messages).toHaveLength(1);
  expect(a.lifetimeUsage).toMatchObject({ input: 10, output: 3, cacheWrite: 2 });
  expect(getDirectUsageTotals(a.directUsageLedger)[0].usage).toMatchObject({ input: 7, output: 2, cacheWrite: 1 });
  expect(runtimeManager.getCurrentRunUsageTotals()[0].usage).toMatchObject({ input: 17, output: 5, cacheWrite: 3 });
  const first = await h.tools.get("get_subagent_result").execute("usage-first", { agent_id: a.id }, undefined, undefined, h.ctx);
  const second = await h.tools.get("get_subagent_result").execute("usage-second", { agent_id: b.id }, undefined, undefined, h.ctx);
  const reported = [...h.launchResults, first, second].reduce((sum, result) => ({
    input: sum.input + (result.usage?.input ?? 0),
    output: sum.output + (result.usage?.output ?? 0),
    cacheWrite: sum.cacheWrite + (result.usage?.cacheWrite ?? 0),
  }), { input: 0, output: 0, cacheWrite: 0 });
  expect(reported).toEqual({ input: 17, output: 5, cacheWrite: 3 });
  expect(second.usage).toBeUndefined();
  expect(runtimeManager.getCurrentRunUsageTotals()[0].usage).toMatchObject({ input: 17, output: 5, cacheWrite: 3 });
});
