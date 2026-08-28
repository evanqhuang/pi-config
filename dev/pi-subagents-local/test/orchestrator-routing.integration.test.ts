import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

    try {
      // Read the real global card before replacing the global root, then parse
      // that same card through pi-subagents-local from the isolated root.
      const liveCard = join(getAgentDir(), "agents", "ImplementationWorker.md");
      await mkdir(dirname(isolatedCard), { recursive: true });
      await copyFile(liveCard, isolatedCard);
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
        subagent_type: "general-purpose",
        model: "other/provider-model",
        thinking: "low",
      };
      const toolCallResult = await pi.handlers.get("tool_call")!({ toolName: "Agent", input: request });
      expect(toolCallResult).toBeUndefined();
      expect(request).toMatchObject({
        subagent_type: "ImplementationWorker",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "xhigh",
      });

      const cards = loadCustomAgents(isolatedProjectDir);
      const registry = buildAgentRegistry(cards);
      const dispatch = resolveSpawnTypeIn(registry, request.subagent_type);
      expect(dispatch).toEqual({ ok: true, type: "ImplementationWorker" });

      const resolvedCard = getAgentConfigIn(registry, dispatch.ok ? dispatch.type : "");
      expect(resolvedCard).toMatchObject({
        name: "ImplementationWorker",
        model: "openai-codex/gpt-5.6-luna",
        thinking: "xhigh",
        extensions: false,
        skills: false,
        source: "global",
        sourcePath: isolatedCard,
      });
      expect(resolvedCard?.allowedSubagents).toBeUndefined();
      expect(resolvedCard?.extSelectors).toBeUndefined();

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
