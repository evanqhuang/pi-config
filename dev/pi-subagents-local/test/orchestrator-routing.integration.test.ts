import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  buildAgentRegistry,
  getAgentConfigIn,
  getFallbackSubagent,
  isDefaultsDisabled,
  NO_FALLBACK,
  resolveSpawnTypeIn,
  setDefaultsDisabled,
  setFallbackSubagent,
} from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import registerSubagents from "../src/index.js";
import { fakePi as subagentHarness, context as subagentContext } from "./helpers/extension-harness.js";

const runner = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/agent-runner.js", async original => ({
  ...(await original<typeof import("../src/agent-runner.js")>()), runAgent: runner.run,
}));

// pi-plan-mode is intentionally imported as an extension, not reimplemented or
// mocked. Jiti is a dependency of pi-coding-agent and lets this test load the
// extension's TypeScript entrypoint without making it a production dependency.
type PlanModeExtension = (pi: PlanModePi) => Promise<void>;
type PlanModeModule = { default: PlanModeExtension };
const requireCodingAgent = createRequire(
  fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)),
);
const { createJiti } = requireCodingAgent("jiti") as {
  createJiti(entrypoint: string): { import(path: string): Promise<PlanModeModule> };
};
const planModeIndex = fileURLToPath(new URL("../../pi-plan-mode/index.ts", import.meta.url));
const { default: registerPlanMode } = await createJiti(planModeIndex).import(planModeIndex);

interface ToolLike {
  name: string;
  [key: string]: unknown;
}

type Handler = (...args: any[]) => unknown;

interface PlanModePi {
  events: {
    on(channel: string, handler: Handler): () => void;
    emit(channel: string, data: unknown): void;
  };
  tools: Map<string, ToolLike>;
  handlers: Map<string, Handler>;
  commands: Map<string, { handler: Handler }>;
  registerTool(tool: ToolLike): void;
  registerCommand(name: string, command: { handler: Handler }): void;
  registerShortcut(name: string, shortcut: { handler: Handler }): void;
  on(name: string, handler: Handler): void;
  getAllTools(): ToolLike[];
  setActiveTools(names: string[]): void;
  appendEntry(customType: string, data: unknown): void;
  sendUserMessage(message: string): void;
  sendMessage(message: unknown): void;
}

function mockPi(): PlanModePi {
  const tools = new Map<string, ToolLike>([
    ["read", { name: "read" }],
    ["write", { name: "write" }],
    ["edit", { name: "edit" }],
  ]);
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: Handler }>();
  const eventListeners = new Map<string, Set<Handler>>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const events = {
    on(channel: string, handler: Handler) {
      const listeners = eventListeners.get(channel) ?? new Set<Handler>();
      listeners.add(handler);
      eventListeners.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit(channel: string, data: unknown) {
      for (const handler of eventListeners.get(channel) ?? []) void handler(data);
    },
  };

  return {
    events,
    tools,
    handlers,
    commands,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut() {},
    on(name, handler) { handlers.set(name, handler); },
    getAllTools() { return [...tools.values()]; },
    setActiveTools() {},
    appendEntry(customType, data) { entries.push({ customType, data }); },
    sendUserMessage() {},
    sendMessage() {},
  };
}

function mockContext(cwd: string) {
  return {
    cwd,
    hasUI: true,
    isIdle: () => true,
    ui: {
      theme: { fg: (_name: string, text: string) => text },
      notify() {},
      setStatus() {},
    },
    sessionManager: {
      getEntries: () => [],
      getBranch: () => [],
      getSessionFile: () => undefined,
    },
  } as any;
}

let temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cross-extension ORCHESTRATOR routing", () => {
  it("routes through pi-plan-mode and resolves the live leaf card with strict fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cross-extension-routing-"));
    temporaryRoots.push(root);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousPlanDir = process.env.PI_PLAN_DIR;
    const previousContextDataDir = process.env.CONTEXT_MODE_DATA_DIR;
    const previousFallback = getFallbackSubagent();
    const previousDefaultsDisabled = isDefaultsDisabled();
    const isolatedAgentDir = join(root, "global-agent");
    const isolatedProjectDir = join(root, "project");
    const isolatedCard = join(isolatedAgentDir, "agents", "ImplementationWorker.md");
    let pi: PlanModePi | undefined;
    let shutdownSubagents: (() => Promise<void>) | undefined;

    try {
      // Read the real global card before replacing the global root, then parse
      // that same card through pi-subagents-local from the isolated root.
      const liveCard = join(getAgentDir(), "agents", "ImplementationWorker.md");
      await mkdir(dirname(isolatedCard), { recursive: true });
      await copyFile(liveCard, isolatedCard);
      for (const role of ["Explore", "Plan", "LunaCompliance", "LunaTestVerifier"]) {
        await copyFile(join(dirname(liveCard), role + ".md"), join(dirname(isolatedCard), role + ".md"));
      }
      await mkdir(isolatedProjectDir, { recursive: true });

      process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
      process.env.PI_PLAN_DIR = join(root, "plans");
      process.env.CONTEXT_MODE_DATA_DIR = join(root, "context-mode");
      setDefaultsDisabled(false);
      setFallbackSubagent(NO_FALLBACK);

      pi = mockPi();
      await registerPlanMode(pi);
      const ctx = mockContext(isolatedProjectDir);
      await pi.commands.get("orchestrator")!.handler(undefined, ctx);

      const request = {
        subagent_type: "ImplementationWorker",
        model: "other/provider-model",
        thinking: "low",
      };
      const toolCallResult = await pi.handlers.get("tool_call")!({ toolName: "Agent", input: request });
      expect(toolCallResult).toBeUndefined();
      expect(request).toMatchObject({
        subagent_type: "ImplementationWorker",
        model: "other/provider-model",
        thinking: "high",
        orchestrator_owned: true,
      });

      const cards = loadCustomAgents(isolatedProjectDir);
      const registry = buildAgentRegistry(cards);
      const dispatch = resolveSpawnTypeIn(registry, request.subagent_type);
      expect(dispatch).toEqual({ ok: true, type: "ImplementationWorker" });

      const resolvedCard = getAgentConfigIn(registry, dispatch.ok ? dispatch.type : "");
      expect(resolvedCard).toMatchObject({
        name: "ImplementationWorker",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "high",
        extensions: false,
        skills: false,
        source: "global",
        sourcePath: isolatedCard,
      });
      expect(resolvedCard?.allowedSubagents).toBeUndefined();
      expect(resolvedCard?.extSelectors).toBeUndefined();

      const harness = subagentHarness();
      registerSubagents(harness.pi as any);
      const runtimeCtx = subagentContext(isolatedProjectDir, harness.ui);
      const models = [
        { provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
        { provider: "other", id: "provider-model", name: "Explicit implementation model" },
      ];
      runtimeCtx.modelRegistry = {
        getAll: () => models,
        find: (provider: string, id: string) => models.find(m => m.provider === provider && m.id === id),
      };
      shutdownSubagents = async () => {
        for (const handler of harness.handlers.get("session_shutdown") ?? []) await handler({}, runtimeCtx);
      };
      runner.run.mockImplementation(async () => ({ responseText: "offline handoff", aborted: false, steered: false }));
      const agentTool = harness.tools.get("Agent");
      const dispatchRequest = async (input: Record<string, unknown>) => {
        const blocked = await pi!.handlers.get("tool_call")!({ toolName: "Agent", input }) as any;
        if (blocked?.block) return blocked;
        return agentTool.execute("dispatch", { prompt: "bounded unit", description: "offline dispatch", run_in_background: false, ...input }, undefined, undefined, runtimeCtx);
      };
      for (const [role, thinking, maxTurns] of [["Explore", "high", 24], ["Plan", "xhigh", 16]] as const) {
        const result = await dispatchRequest({ subagent_type: role });
        expect(result.details.status).toBe("completed");
        const call = runner.run.mock.calls.at(-1)!;
        expect(call[1]).toBe(role);
        expect(call[3]).toMatchObject({ thinkingLevel: thinking, maxTurns, orchestratorOwned: false });
        const card = getAgentConfigIn(registry, role)!;
        expect(card.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
        expect(card.allowedSubagents).toBeUndefined();
      }
      for (const input of [
        { subagent_type: "ImplementationWorker" },
        { subagent_type: "ImplementationWorker", model: "other/provider-model", thinking: "max" },
      ]) {
        const explicit = "model" in input;
        const result = await dispatchRequest(input);
        expect(result.details.status).toBe("completed");
        const options = runner.run.mock.calls.at(-1)![3];
        expect(options.model).toMatchObject(explicit ? models[1] : models[0]);
        expect(options.thinkingLevel).toBe(explicit ? "max" : "high");
        expect(options.orchestratorOwned).toBe(true);
        expect(options.maxTurns).toBeUndefined();
      }
      const beforeUnknown = runner.run.mock.calls.length;
      expect((await dispatchRequest({ subagent_type: "missing" })).block).toBe(true);
      expect(runner.run.mock.calls).toHaveLength(beforeUnknown);
      for (const role of ["LunaCompliance", "LunaTestVerifier"]) {
        const input = { subagent_type: role, model: "other/provider-model", thinking: "max", isolation: "off", snapshot_source: false };
        await pi.handlers.get("tool_call")!({ toolName: "Agent", input });
        const config = resolveAgentInvocationConfig(getAgentConfigIn(registry, role), input);
        expect(config.modelInput).toBe("openai-codex/gpt-5.6-luna");
        expect(config.thinking).toBe("high");
        if (role === "LunaCompliance") expect(config.disallowedTools).toContain("bash");
        else expect(config).toMatchObject({ isolation: "worktree", snapshotSource: true, worktreeDisposition: "discard" });
      }

      const missingCardResolution = resolveSpawnTypeIn(
        buildAgentRegistry(new Map()),
        request.subagent_type,
      );
      expect(missingCardResolution.ok).toBe(false);
      if (!missingCardResolution.ok) {
        expect(missingCardResolution.message).toContain("ImplementationWorker");
      }
      const unknownResolution = resolveSpawnTypeIn(registry, "missing-rewritten-type");
      expect(unknownResolution.ok).toBe(false);
      expect(getFallbackSubagent()).toBe(NO_FALLBACK);
    } finally {
      await shutdownSubagents?.();
      runner.run.mockReset();
      if (pi) await pi.handlers.get("session_shutdown")?.({}, mockContext(isolatedProjectDir));
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousPlanDir === undefined) delete process.env.PI_PLAN_DIR;
      else process.env.PI_PLAN_DIR = previousPlanDir;
      if (previousContextDataDir === undefined) delete process.env.CONTEXT_MODE_DATA_DIR;
      else process.env.CONTEXT_MODE_DATA_DIR = previousContextDataDir;
      setFallbackSubagent(previousFallback);
      setDefaultsDisabled(previousDefaultsDisabled);
    }
  });
});
