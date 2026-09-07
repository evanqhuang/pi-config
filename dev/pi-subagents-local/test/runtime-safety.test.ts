import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { setWorktreeIsolationEnabled } from "../src/worktree.js";

interface Handler {
  (data?: unknown, ctx?: unknown): unknown;
}

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools: any[] = [];
  const shortcuts = new Map<string, { handler: Handler }>();
  const events = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter(item => item !== handler));
      };
    },
    emit(event: string, data: unknown) {
      for (const handler of [...(handlers.get(event) ?? [])]) void handler(data);
    },
  };
  const pi = {
    events,
    registerMessageRenderer: () => {},
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: () => {},
    registerShortcut: (name: string, shortcut: { handler: Handler }) => shortcuts.set(name, shortcut),
    on: (event: string, handler: Handler) => events.on(event, handler),
    sendMessage: () => {},
    appendEntry: () => {},
  };
  return { pi, tools, handlers, shortcuts };
}

const contexts: Array<{ dir: string; previous: string | undefined }> = [];
afterEach(async () => {
  setWorktreeIsolationEnabled(true);
  delete (globalThis as any)[Symbol.for("pi.local-mode.provider-policy")];
  for (const { dir, previous } of contexts.splice(0)) {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("runtime verifier safety", () => {
  it("blocks the Agent tool before spawning when required isolation is disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-runtime-safety-"));
    contexts.push({ dir, previous: process.env.PI_CODING_AGENT_DIR });
    process.env.PI_CODING_AGENT_DIR = join(dir, "global");
    const agentsDir = join(dir, "global", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "LunaTestVerifier.md"), [
      "---",
      "name: LunaTestVerifier",
      "description: verifier",
      "---",
      "verify",
      "",
    ].join("\n"));

    const { pi, tools, handlers, shortcuts } = fakePi();
    extension(pi as any);
    const shortcut = shortcuts.get("ctrl+b");
    expect(shortcut).toBeDefined();
    const notify = [] as string[];
    await shortcut!.handler({ ui: { notify: (message: string) => notify.push(message) } });
    expect(notify).toEqual(["No foreground agent to detach"]);
    setWorktreeIsolationEnabled(false);
    const agent = tools.find(tool => tool.name === "Agent");
    expect(agent).toBeDefined();

    const result = await agent.execute(
      "call-1",
      {
        prompt: "verify",
        description: "verify tests",
        subagent_type: "LunaTestVerifier",
        isolation: "off",
      },
      new AbortController().signal,
      undefined,
      {
        cwd: dir,
        ui: {},
        mode: "rpc",
        hasUI: false,
        model: undefined,
        modelRegistry: {},
        sessionManager: { getSessionId: () => "session" },
        getSystemPrompt: () => "",
      },
    );

    expect(result.content[0].text).toContain("requires worktree isolation");
    expect(result.content[0].text).toContain("will not downgrade");

    // The process-wide programmatic funnel used by RPC, mentions, and registry
    // callers must enforce the same policy as the Agent tool.
    const registry = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    expect(() => registry.spawn(
      pi,
      {
        cwd: dir,
        modelRegistry: {},
        sessionManager: { getSessionId: () => "session" },
      },
      "LunaTestVerifier",
      "verify",
      {},
    )).toThrow(/requires worktree isolation/);

    expect(handlers.get("session_shutdown")).toBeDefined();
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });

  it("blocks a cloud-pinned card even when that child disables extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-agent-local-model-safety-"));
    contexts.push({ dir, previous: process.env.PI_CODING_AGENT_DIR });
    process.env.PI_CODING_AGENT_DIR = join(dir, "global");
    const agentsDir = join(dir, "global", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "ImplementationWorker.md"), [
      "---",
      "name: ImplementationWorker",
      "description: implementation worker",
      "extensions: false",
      "model: openai-codex/gpt-5.6-luna",
      "---",
      "implement",
      "",
    ].join("\n"));

    const cloudModel = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    const localModel = { provider: "qwen38-main", id: "qwen3.8-27b", name: "Qwen3.8 27B Main" };
    const modelRegistry = {
      getAvailable: () => [cloudModel, localModel],
      getAll: () => [cloudModel, localModel],
      find: (provider: string, id: string) => [cloudModel, localModel]
        .find(model => model.provider === provider && model.id === id),
    };
    (globalThis as any)[Symbol.for("pi.local-mode.provider-policy")] = { enabled: true };

    const { pi, tools, handlers } = fakePi();
    extension(pi as any);
    const agent = tools.find(tool => tool.name === "Agent");
    expect(agent).toBeDefined();

    const result = await agent.execute(
      "call-local-model-policy",
      {
        prompt: "implement",
        description: "implement code",
        subagent_type: "ImplementationWorker",
      },
      new AbortController().signal,
      undefined,
      {
        cwd: dir,
        ui: {},
        mode: "rpc",
        hasUI: false,
        model: localModel,
        modelRegistry,
        sessionManager: { getSessionId: () => "session" },
        getSystemPrompt: () => "",
      },
    );

    expect(result.content[0].text).toContain("Local mode only permits local subagent models");
    expect(result.content[0].text).toContain("openai-codex/gpt-5.6-luna");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  });
});
