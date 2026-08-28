import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const runAgent = vi.fn(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
    const session = {
      sessionManager: { getSessionFile: () => undefined },
      dispose: vi.fn(),
    };
    options.onSessionCreated?.(session);
    return { responseText: "scheduled", session, aborted: false, steered: false };
  });
  return { runAgent };
});

vi.mock("../src/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
  resumeAgent: vi.fn(),
  normalizeMaxTurns: (n: number | undefined) => n === 0 ? undefined : n,
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { AgentManager } from "../src/agent-manager.js";
import { setFallbackSubagent } from "../src/agent-types.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { SubagentScheduler } from "../src/schedule.js";

function fakePi() {
  const events = {
    emit: vi.fn(),
  };
  return { events } as any;
}

function fakeContext(cwd: string) {
  return {
    cwd,
    modelRegistry: {},
    model: undefined,
    getSystemPrompt: () => "",
    sessionManager: { getSessionId: () => "scheduler-test" },
  } as any;
}

async function writeWorkerCard(cwd: string, enabled = true): Promise<string> {
  const dir = join(cwd, ".pi", "agents");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "ImplementationWorker.md");
  await writeFile(path, [
    "---",
    "name: ImplementationWorker",
    "description: implementation worker",
    enabled ? "" : "enabled: false",
    "---",
    "worker",
    "",
  ].join("\n"));
  return path;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-scheduler-routing-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "global");
  const store = new ScheduleStore(join(root, "schedules.json"));
  const scheduler = new SubagentScheduler();
  const manager = new AgentManager();
  const pi = fakePi();
  const ctx = fakeContext(root);
  scheduler.start(pi, ctx, manager, store);
  return {
    root,
    previousAgentDir,
    store,
    scheduler,
    manager,
    pi,
    ctx,
    restore: async () => {
      scheduler.stop();
      await manager.dispose();
      setFallbackSubagent(undefined);
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  mocks.runAgent.mockClear();
});

describe("scheduled type-routing seam", () => {
  it("reloads cards at fire time and refuses a deleted card", async () => {
    const state = await setup();
    try {
      const cardPath = await writeWorkerCard(state.root);
      const job = state.scheduler.addJob({
        name: "deleted card",
        description: "deleted card",
        schedule: "+1m",
        subagent_type: "ImplementationWorker",
        prompt: "run",
      });
      await unlink(cardPath);

      (state.scheduler as any).executeJob(job.id);

      expect(state.store.get(job.id)?.lastStatus).toBe("error");
      expect(mocks.runAgent).not.toHaveBeenCalled();
      expect(state.pi.events.emit).toHaveBeenCalledWith(
        "subagents:scheduled",
        expect.objectContaining({ type: "error", jobId: job.id }),
      );
    } finally {
      await state.restore();
    }
  });

  it("reloads an edited disabled card before fire instead of using the stale registry", async () => {
    const state = await setup();
    try {
      const cardPath = await writeWorkerCard(state.root);
      const job = state.scheduler.addJob({
        name: "disabled card",
        description: "disabled card",
        schedule: "+1m",
        subagent_type: "implementationworker",
        prompt: "run",
      });
      await writeWorkerCard(state.root, false);

      (state.scheduler as any).executeJob(job.id);

      expect(state.store.get(job.id)?.lastStatus).toBe("error");
      expect(mocks.runAgent).not.toHaveBeenCalled();
      expect(cardPath).toContain("ImplementationWorker.md");
    } finally {
      await state.restore();
    }
  });

  it("does not use an explicit fallback after the current fallback card is deleted", async () => {
    const state = await setup();
    try {
      const cardPath = await writeWorkerCard(state.root);
      setFallbackSubagent("ImplementationWorker");
      const job = state.scheduler.addJob({
        name: "fallback card",
        description: "fallback card",
        schedule: "+1m",
        subagent_type: "missing-card",
        prompt: "run",
      });
      await unlink(cardPath);

      (state.scheduler as any).executeJob(job.id);

      expect(state.store.get(job.id)?.lastStatus).toBe("error");
      expect(mocks.runAgent).not.toHaveBeenCalled();
    } finally {
      await state.restore();
    }
  });
});
