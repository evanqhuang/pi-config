import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  resolveDefaultModel: vi.fn(),
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
  resolveDefaultModel: mocks.resolveDefaultModel,
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: mocks.createWorktree,
  cleanupWorktree: mocks.cleanupWorktree,
  isWorktreeIsolationEnabled: mocks.isWorktreeIsolationEnabled,
}));

import { getPiSubagentsServiceV3, PI_SUBAGENTS_SERVICE_V3 } from "../src/service.js";

let tempRoot: string;
let previousAgentDir: string | undefined;

function context(cwd: string): any {
  return { cwd, model: undefined, modelRegistry: {} };
}

function session() {
  const emit = vi.fn(async () => {});
  const value = {
    extensionRunner: { hasHandlers: () => true, emit },
    dispose: vi.fn(),
  };
  return { value, emit };
}

async function installCard(cwd: string, name: string): Promise<void> {
  const agentsDir = join(cwd, ".pi", "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, `${name}.md`), [
    "---",
    `name: ${name}`,
    "description: test card",
    "---",
    "test",
    "",
  ].join("\n"));
}

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  tempRoot = await mkdtemp(join(tmpdir(), "pi-subagents-service-"));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "global-agent");
  delete (globalThis as Record<PropertyKey, unknown>)[PI_SUBAGENTS_SERVICE_V3];
  mocks.runAgent.mockReset();
  mocks.resolveDefaultModel.mockReset();
  mocks.createWorktree.mockReset();
  mocks.cleanupWorktree.mockReset();
  mocks.isWorktreeIsolationEnabled.mockReset().mockReturnValue(true);
});

afterEach(async () => {
  delete (globalThis as Record<PropertyKey, unknown>)[PI_SUBAGENTS_SERVICE_V3];
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("ephemeral service safety and cleanup", () => {
  it.each(["lunacompliance", "LUNACOMPLIANCE", "LuNaCoMpLiAnCe"])(
    "canonicalizes case variant %s before applying policy",
    async requestedType => {
      const cwd = join(tempRoot, "project");
      await installCard(cwd, "LunaCompliance");
      const child = session();
      mocks.runAgent.mockImplementationOnce(async (_ctx: unknown, type: string, _prompt: string, options: any) => {
        options.onSessionCreated?.(child.value);
        return { responseText: "checked", session: child.value, aborted: false, steered: false };
      });

      const service = getPiSubagentsServiceV3();
      await service.runEphemeralAgent({
        pi: {} as any,
        ctx: context(cwd),
        type: requestedType,
        prompt: "check",
      });

      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.anything(),
        "LunaCompliance",
        "check",
        expect.objectContaining({ disallowedTools: ["bash"] }),
      );
    },
  );

  it.each(["lunatestverifier", "LUNATESTVERIFIER", "LuNaTeStVeRiFiEr"])(
    "canonicalizes case variant %s before enforcing unavailable policy",
    async requestedType => {
      const cwd = join(tempRoot, "project");
      await installCard(cwd, "LunaTestVerifier");
      mocks.isWorktreeIsolationEnabled.mockReturnValue(false);

      const service = getPiSubagentsServiceV3();
      await expect(service.runEphemeralAgent({
        pi: {} as any,
        ctx: context(cwd),
        type: requestedType,
        prompt: "verify",
      })).rejects.toThrow(/LunaTestVerifier.*requires worktree isolation/);
      expect(mocks.runAgent).not.toHaveBeenCalled();
    },
  );

  it("disposes a session captured before a later runner rejection", async () => {
    const cwd = join(tempRoot, "project");
    const child = session();
    mocks.runAgent.mockImplementationOnce(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      options.onSessionCreated?.(child.value);
      throw new Error("prompt failed");
    });

    const service = getPiSubagentsServiceV3();
    await expect(service.runEphemeralAgent({
      pi: {} as any,
      ctx: context(cwd),
      type: "general-purpose",
      prompt: "run",
    })).rejects.toThrow("prompt failed");

    expect(child.emit).toHaveBeenCalledWith({ type: "session_shutdown", reason: "quit" });
    expect(child.value.dispose).toHaveBeenCalledOnce();
  });
});
