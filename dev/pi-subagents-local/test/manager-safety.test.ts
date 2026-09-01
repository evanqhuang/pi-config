import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createWorktree = vi.fn();
  const cleanupWorktree = vi.fn();
  const pruneWorktrees = vi.fn();
  const isWorktreeIsolationEnabled = vi.fn(() => true);
  const runAgent = vi.fn(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
    const session = {
      sessionManager: { getSessionFile: () => undefined },
      dispose: vi.fn(),
    };
    options.onSessionCreated?.(session);
    return { responseText: "verified", session, aborted: false, steered: false };
  });
  return { createWorktree, cleanupWorktree, pruneWorktrees, isWorktreeIsolationEnabled, runAgent };
});

afterEach(() => {
  mocks.createWorktree.mockReset();
  mocks.cleanupWorktree.mockReset();
  mocks.isWorktreeIsolationEnabled.mockReset().mockReturnValue(true);
  mocks.runAgent.mockClear();
});

vi.mock("../src/worktree.js", () => ({
  createWorktree: mocks.createWorktree,
  cleanupWorktree: mocks.cleanupWorktree,
  pruneWorktrees: mocks.pruneWorktrees,
  isWorktreeIsolationEnabled: mocks.isWorktreeIsolationEnabled,
}));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
  resumeAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";

describe("manager verifier worktree plumbing", () => {
  it("creates and cleans disposable snapshots while retaining metadata", async () => {
    const worktree = {
      path: "/tmp/pi-agent-verifier",
      branch: "pi-agent-verifier",
      baseSha: "base-sha",
      workPath: "/tmp/pi-agent-verifier",
      finalization: "discard",
      source: {
        cwd: "/repo",
        root: "/repo",
        path: "/repo",
        baseSha: "base-sha",
      },
      snapshot: {
        sourcePath: "/repo",
        sourceRoot: "/repo",
        targetPath: "/tmp/pi-agent-verifier",
        baseSha: "base-sha",
        trackedDiffSha256: "diff-sha",
        trackedDiffBytes: 4,
        trackedPaths: ["tests/example.ts"],
        untrackedPaths: [],
        untrackedBytes: 0,
        complete: true,
      },
    };
    mocks.createWorktree.mockReturnValue(worktree);
    mocks.cleanupWorktree.mockReturnValue({
      hasChanges: true,
      discarded: true,
      source: worktree.source,
      snapshot: worktree.snapshot,
    });

    const manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: "/repo" } as any, "LunaTestVerifier", "verify", {
      description: "verify tests",
      isBackground: true,
    });

    const record = manager.getRecord(id)!;
    await record.promise;

    expect(mocks.createWorktree).toHaveBeenCalledWith("/repo", id, {
      finalization: "discard",
      snapshotSource: true,
    });
    expect(mocks.cleanupWorktree).toHaveBeenCalledWith(
      "/repo",
      worktree,
      "verify tests",
      { finalization: "discard" },
    );
    expect(record.worktreeResult).toMatchObject({
      hasChanges: true,
      discarded: true,
      snapshot: worktree.snapshot,
    });
    expect(record.invocation).toMatchObject({
      isolation: "worktree",
      worktreeDisposition: "discard",
      snapshotSource: true,
    });
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "LunaTestVerifier",
      "verify",
      expect.objectContaining({
        cwd: worktree.path,
        disallowedTools: [],
      }),
    );

    mocks.runAgent.mockClear();
    const complianceId = manager.spawn({} as any, { cwd: "/repo" } as any, "LunaCompliance", "check", {
      description: "check compliance",
      isBackground: true,
    });
    await manager.getRecord(complianceId)!.promise;
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "LunaCompliance",
      "check",
      expect.objectContaining({ disallowedTools: ["bash"] }),
    );

    await manager.dispose();
  });

  it("fails a direct policy-forced verifier instead of running in the source cwd", async () => {
    mocks.isWorktreeIsolationEnabled.mockReturnValue(false);
    const manager = new AgentManager();

    expect(() => manager.spawn({} as any, { cwd: "/repo" } as any, "LunaTestVerifier", "verify", {
      description: "verify tests",
      isBackground: true,
    })).toThrow(/worktree isolation is disabled/);
    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();

    await manager.dispose();
  });

  it("keeps ordinary worktree requests downgraded when isolation is disabled", async () => {
    mocks.isWorktreeIsolationEnabled.mockReturnValue(false);
    const manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "work", {
      description: "ordinary work",
      isolation: "worktree",
      isBackground: true,
    });

    await manager.getRecord(id)!.promise;
    expect(mocks.createWorktree).not.toHaveBeenCalled();
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.anything(),
      "general-purpose",
      "work",
      expect.objectContaining({ cwd: undefined }),
    );

    await manager.dispose();
  });

  it("surfaces ordinary cleanup failures while preserving the worktree path", async () => {
    const worktree = {
      path: "/tmp/pi-agent-ordinary-cleanup",
      branch: "pi-agent-ordinary-cleanup",
      baseSha: "base-sha",
      workPath: "/tmp/pi-agent-ordinary-cleanup",
      finalization: "commit" as const,
    };
    mocks.createWorktree.mockReturnValue(worktree);
    mocks.cleanupWorktree.mockImplementation(() => {
      throw new Error("pre-commit hook failed");
    });
    const complete = vi.fn();
    const manager = new AgentManager(complete);
    const id = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "work", {
      description: "ordinary work",
      isolation: "worktree",
      worktreeDisposition: "commit",
      isBackground: true,
    });

    await manager.getRecord(id)!.promise;
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("error");
    expect(record.error).toContain("pre-commit hook failed");
    expect(record.error).toContain(worktree.path);
    expect(record.result).toContain(worktree.path);
    expect(record.worktreeResult).toEqual({ hasChanges: true });
    expect(complete).toHaveBeenCalledWith(record);

    await manager.dispose();
  });

  it("reloads cards at the manager boundary and fails before creating a record", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-manager-routing-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    const agentsDir = join(root, "global", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "ImplementationWorker.md"), [
      "---",
      "name: ImplementationWorker",
      "description: implementation worker",
      "---",
      "worker",
      "",
    ].join("\n"));

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: root } as any, "implementationworker", "implement", {
        description: "implement",
        isBackground: true,
      });
      await manager.getRecord(id)!.promise;
      expect(manager.getRecord(id)?.type).toBe("ImplementationWorker");
      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.anything(),
        "ImplementationWorker",
        "implement",
        expect.anything(),
      );

      await rm(join(agentsDir, "ImplementationWorker.md"));
      const recordCount = manager.listAgents().length;
      expect(() => manager.spawn({} as any, { cwd: root } as any, "ImplementationWorker", "again", {
        description: "again",
        isBackground: true,
      })).toThrow(/Unknown or disabled agent type/);
      expect(manager.listAgents()).toHaveLength(recordCount);
    } finally {
      await manager.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the requested card is malformed", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-manager-malformed-routing-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    const agentsDir = join(root, "global", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "ImplementationWorker.md"), "---\nname: [\n---\n");

    const manager = new AgentManager();
    try {
      expect(() => manager.spawn({} as any, { cwd: root } as any, "ImplementationWorker", "implement", {
        description: "implement",
        isBackground: true,
      })).toThrow(/ImplementationWorker|malformed|YAML|frontmatter/i);
      expect(manager.listAgents()).toHaveLength(0);
      expect(mocks.runAgent).not.toHaveBeenCalled();
    } finally {
      await manager.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("canonicalizes lowercase verifier names before applying policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-manager-verifier-routing-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    const agentsDir = join(root, "global", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "LunaCompliance.md"), [
      "---",
      "name: LunaCompliance",
      "description: compliance verifier",
      "---",
      "verify",
      "",
    ].join("\n"));

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: root } as any, "lunacompliance", "check", {
        description: "check",
        isBackground: true,
      });
      await manager.getRecord(id)!.promise;

      expect(manager.getRecord(id)?.type).toBe("LunaCompliance");
      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.anything(),
        "LunaCompliance",
        "check",
        expect.objectContaining({ disallowedTools: ["bash"] }),
      );
    } finally {
      await manager.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not reinterpret a resume session through the current card registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-manager-resume-routing-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "global");
    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: root } as any, "HistoricalType", "continue", {
        description: "continue",
        resumeSessionFile: join(root, "historical.jsonl"),
        isBackground: true,
      });
      await manager.getRecord(id)!.promise;

      expect(manager.getRecord(id)?.type).toBe("HistoricalType");
      expect(mocks.runAgent).toHaveBeenCalledWith(
        expect.anything(),
        "HistoricalType",
        "continue",
        expect.not.objectContaining({ disallowedTools: ["bash"] }),
      );
    } finally {
      await manager.dispose();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a valid queued spawn after the running slot is released", async () => {
    let finishFirst!: (value: any) => void;
    mocks.runAgent.mockImplementationOnce(async () => new Promise(resolve => { finishFirst = resolve; }));

    const manager = new AgentManager(undefined, 1);
    try {
      const firstId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "first", {
        description: "first",
        isBackground: true,
      });
      const queuedId = manager.spawn({} as any, { cwd: "/repo" } as any, "GENERAL-PURPOSE", "queued", {
        description: "queued",
        isBackground: true,
      });
      expect(manager.getRecord(queuedId)?.status).toBe("queued");

      finishFirst({ responseText: "first", session: undefined, aborted: false, steered: false });
      await manager.getRecord(firstId)!.promise;
      await manager.getRecord(queuedId)!.promise;

      expect(mocks.runAgent).toHaveBeenCalledTimes(2);
      expect(manager.getRecord(queuedId)).toMatchObject({ type: "general-purpose", status: "completed" });
    } finally {
      await manager.dispose();
    }
  });

  it("detaches the newest eligible top-level foreground record", async () => {
    const finishers = new Map<string, (value: any) => void>();
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      if (prompt === "completed") {
        return { responseText: "completed", session, aborted: false, steered: false };
      }
      return new Promise(resolve => { finishers.set(prompt, resolve); });
    });

    const manager = new AgentManager();
    try {
      const firstId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "first", {
        description: "first",
        isBackground: false,
        blocking: true,
      });
      const backgroundId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "background", {
        description: "background",
        isBackground: true,
        blocking: true,
      });
      const nestedId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "nested", {
        description: "nested",
        isBackground: false,
        blocking: true,
        parentAgentId: "parent",
      });
      const newestId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "newest", {
        description: "newest",
        isBackground: false,
        blocking: true,
      });
      const completedId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "completed", {
        description: "completed",
        isBackground: false,
        blocking: true,
      });
      await manager.getRecord(completedId)!.promise;

      // Selection is based on insertion order, not Date.now(): the newest
      // eligible foreground is chosen even when other records are newer but
      // background, nested, or already complete.
      expect(manager.detachForeground()?.id).toBe(newestId);
      expect(manager.detachForeground()?.id).toBe(firstId);
      expect(manager.detachForeground()).toBeUndefined();
      expect(manager.getRecord(backgroundId)?.detached).toBeUndefined();
      expect(manager.getRecord(nestedId)?.detached).toBeUndefined();
      expect(manager.getRecord(completedId)?.detached).toBeUndefined();
    } finally {
      for (const finish of finishers.values()) {
        finish({ responseText: "done", session: undefined, aborted: false, steered: false });
      }
      await manager.dispose();
    }
  });

  it("returns a detached queued foreground caller before saturated background capacity frees", async () => {
    const finishers = new Map<string, (value: any) => void>();
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finishers.set(prompt, resolve); });
    });

    const manager = new AgentManager(undefined, 1);
    manager.setMaxConcurrentForeground(1);
    try {
      const backgroundId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "background", {
        description: "background",
        isBackground: true,
      });
      const first = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "first", {
        description: "first",
      });
      const second = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "second", {
        description: "second",
      });
      const queued = manager.listAgents().find(record => record.description === "second")!;
      expect(queued.status).toBe("queued");
      expect(mocks.runAgent).toHaveBeenCalledTimes(2);

      expect(manager.detachForeground()).toBe(queued);
      let timer!: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("detached foreground caller did not return")), 100);
      });
      const detached = await Promise.race([second, timeout]);
      clearTimeout(timer);
      expect(detached.detached).toBe(true);
      expect(queued.status).toBe("queued");
      expect(queued.isBackground).toBe(true);
      expect(mocks.runAgent).toHaveBeenCalledTimes(2);

      finishers.get("background")!({ responseText: "background", session: undefined, aborted: false, steered: false });
      await manager.getRecord(backgroundId)!.promise;
      expect(queued.status).toBe("running");
      expect(mocks.runAgent).toHaveBeenCalledTimes(3);

      finishers.get("first")!({ responseText: "first", session: undefined, aborted: false, steered: false });
      finishers.get("second")!({ responseText: "second", session: undefined, aborted: false, steered: false });
      await Promise.all([first, queued.promise]);
      expect(queued.status).toBe("completed");
    } finally {
      for (const finish of finishers.values()) {
        finish({ responseText: "done", session: undefined, aborted: false, steered: false });
      }
      await manager.dispose();
    }
  });

  it("does not release an uncharged foreground slot after the limit changes", async () => {
    const finishers = new Map<string, (value: any) => void>();
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finishers.set(prompt, resolve); });
    });

    const manager = new AgentManager();
    try {
      const unlimited = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "unlimited", {
        description: "unlimited",
      });
      manager.setMaxConcurrentForeground(1);
      expect(manager.detachForeground()?.description).toBe("unlimited");
      expect((await unlimited).detached).toBe(true);

      const first = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "first charged", {
        description: "first charged",
      });
      const second = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "second charged", {
        description: "second charged",
      });
      expect(manager.listAgents().find(record => record.description === "first charged")?.status).toBe("running");
      expect(manager.listAgents().find(record => record.description === "second charged")?.status).toBe("queued");

      finishers.get("first charged")!({ responseText: "first", session: undefined, aborted: false, steered: false });
      await first;
      expect(manager.listAgents().find(record => record.description === "second charged")?.status).toBe("running");

      finishers.get("unlimited")!({ responseText: "unlimited", session: undefined, aborted: false, steered: false });
      finishers.get("second charged")!({ responseText: "second", session: undefined, aborted: false, steered: false });
      await Promise.all([manager.listAgents().find(record => record.description === "unlimited")!.promise, second]);
    } finally {
      for (const finish of finishers.values()) {
        finish({ responseText: "done", session: undefined, aborted: false, steered: false });
      }
      await manager.dispose();
    }
  });

  it("detaches a running foreground agent without aborting its child", async () => {
    let finish!: (value: any) => void;
    let session: any;
    mocks.runAgent.mockImplementationOnce(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finish = resolve; });
    });

    const complete = vi.fn();
    const manager = new AgentManager(complete);
    const parent = new AbortController();
    try {
      const waiting = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "foreground", {
        description: "foreground",
        signal: parent.signal,
      });
      const record = manager.listAgents()[0]!;
      expect(record.status).toBe("running");

      expect(manager.detachForeground()).toBe(record);
      const outcome = await waiting;
      expect(outcome).toMatchObject({ id: record.id, detached: true });
      expect(record.isBackground).toBe(true);
      expect(record.blocking).toBeUndefined();
      expect(record.status).toBe("running");

      // Detachment removes the parent coupling; aborting the foreground tool's
      // signal after Ctrl+B must not stop the child.
      parent.abort();
      expect(record.status).toBe("running");

      finish({ responseText: "detached result", session, aborted: false, steered: false });
      await record.promise;
      expect(record.status).toBe("completed");
      expect(complete).toHaveBeenCalledWith(record);
    } finally {
      await manager.dispose();
    }
  });

  it("migrates a queued foreground agent to background scheduling", async () => {
    const finishers = new Map<string, (value: any) => void>();
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finishers.set(prompt, resolve); });
    });

    const manager = new AgentManager(undefined, 10);
    manager.setMaxConcurrentForeground(1);
    try {
      const first = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "first", {
        description: "first",
      });
      const second = manager.spawnAndWait({} as any, { cwd: "/repo" } as any, "general-purpose", "second", {
        description: "second",
      });
      const queued = manager.listAgents().find(record => record.description === "second")!;
      expect(queued.status).toBe("queued");

      expect(manager.detachForeground()).toBe(queued);
      const detached = await second;
      expect(detached.detached).toBe(true);
      expect(queued.isBackground).toBe(true);
      expect(queued.status).toBe("running");
      expect(finishers.has("second")).toBe(true);

      finishers.get("first")!({ responseText: "first result", session: undefined, aborted: false, steered: false });
      finishers.get("second")!({ responseText: "second result", session: undefined, aborted: false, steered: false });
      await Promise.all([first, queued.promise]);
      expect(queued.status).toBe("completed");
    } finally {
      await manager.dispose();
    }
  });

  it("reports a queued policy-forced verifier failure without starting it", async () => {
    let finishFirst!: (value: any) => void;
    mocks.runAgent.mockImplementationOnce(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      return new Promise(resolve => { finishFirst = resolve; });
    });

    const manager = new AgentManager(undefined, 1);
    const firstId = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "first", {
      description: "first",
      isBackground: true,
    });
    const verifierId = manager.spawn({} as any, { cwd: "/repo" } as any, "LunaTestVerifier", "verify", {
      description: "verify tests",
      isBackground: true,
    });
    expect(manager.getRecord(verifierId)?.status).toBe("queued");

    mocks.isWorktreeIsolationEnabled.mockReturnValue(false);
    finishFirst({ responseText: "first", session: undefined, aborted: false, steered: false });
    await manager.getRecord(firstId)!.promise;

    const verifier = manager.getRecord(verifierId)!;
    expect(verifier.status).toBe("error");
    expect(verifier.error).toContain("worktree isolation is disabled");
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);

    await manager.dispose();
  });
});
