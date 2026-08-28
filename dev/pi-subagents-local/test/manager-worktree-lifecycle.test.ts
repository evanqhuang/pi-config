import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

vi.mock("../src/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
  resumeAgent: mocks.resumeAgent,
}));

import { AgentManager } from "../src/agent-manager.js";

const repositories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-manager-worktree-test-"));
  repositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Manager Worktree Test"]);
  writeFileSync(join(root, "source.txt"), "source\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

function worktrees(root: string): string {
  return git(root, ["worktree", "list", "--porcelain"]);
}

function session(options: any): any {
  const value = {
    sessionManager: { getSessionFile: () => undefined },
    dispose: vi.fn(),
    steer: vi.fn(async () => {}),
  };
  options.onSessionCreated?.(value);
  return value;
}

function spawnDisposable(manager: AgentManager, root: string): string {
  return manager.spawn({} as any, { cwd: root } as any, "general-purpose", "verify", {
    description: "verify",
    isBackground: true,
    isolation: "worktree",
    worktreeDisposition: "discard",
    snapshotSource: true,
  });
}

afterEach(() => {
  mocks.runAgent.mockReset();
  for (const root of repositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disposable manager worktree terminal paths", () => {
  it("cleans a worktree when the runner fails synchronously during startup", async () => {
    const root = repository();
    const before = worktrees(root);
    mocks.runAgent.mockImplementation(() => { throw new Error("runner startup failed"); });
    const manager = new AgentManager();

    expect(() => spawnDisposable(manager, root)).toThrow("runner startup failed");
    expect(worktrees(root)).toBe(before);
    expect(manager.listAgents()).toHaveLength(0);
    await manager.dispose();
  });

  it("aborts and releases a disposable verifier when onSpawned throws", async () => {
    const root = repository();
    const before = worktrees(root);
    let failedId!: string;
    let failedRecord: any;
    let failedWorktreePath!: string;
    let aborted = false;
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const child = session(options);
      return new Promise(resolve => {
        options.signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ responseText: "stopped", session: child, aborted: true, steered: false });
        }, { once: true });
      });
    });
    const complete = vi.fn();
    const manager = new AgentManager(complete, 1);

    expect(() => manager.spawn({} as any, { cwd: root } as any, "LunaTestVerifier", "verify", {
      description: "verify tests",
      isBackground: true,
      onSpawned: id => {
        failedId = id;
        failedRecord = manager.getRecord(id);
        failedWorktreePath = failedRecord.worktree.path;
        throw new Error("output wiring failed");
      },
    })).toThrow("output wiring failed");

    expect(aborted).toBe(true);
    expect(failedRecord).toBeDefined();
    expect(manager.getRecord(failedId)).toBeUndefined();
    expect(manager.listAgents()).toHaveLength(0);
    expect(existsSync(failedWorktreePath)).toBe(false);
    expect(worktrees(root)).toBe(before);
    expect((manager as any).runningBackground).toBe(0);
    expect((manager as any).queue).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();

    await failedRecord.promise;
    await manager.dispose();
  });

  it("cleans a stopped worktree after the abort-aware run settles", async () => {
    const root = repository();
    let resolveRun!: (value: any) => void;
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const child = session(options);
      return new Promise(resolve => {
        resolveRun = resolve;
        options.signal.addEventListener("abort", () => resolve({
          responseText: "stopped",
          session: child,
          aborted: true,
          steered: false,
        }), { once: true });
      });
    });
    const manager = new AgentManager();
    const id = spawnDisposable(manager, root);
    const record = manager.getRecord(id)!;
    const worktreePath = record.worktree!.path;

    expect(manager.abort(id)).toBe(true);
    resolveRun({ responseText: "stopped", session: record.session, aborted: true, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");
    expect(worktrees(root)).not.toContain(worktreePath);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("source\n");
    await manager.dispose();
  });

  it("cleans a timeout-style aborted run", async () => {
    const root = repository();
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => ({
      responseText: "partial",
      session: session(options),
      aborted: true,
      steered: false,
    }));
    const manager = new AgentManager();
    const id = spawnDisposable(manager, root);
    const record = manager.getRecord(id)!;
    const worktreePath = record.worktree!.path;

    await record.promise;

    expect(record.status).toBe("aborted");
    expect(worktrees(root)).not.toContain(worktreePath);
    await manager.dispose();
  });

  it("force-removes an active disposable worktree during shutdown", async () => {
    const root = repository();
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      session(options);
      return new Promise(() => {});
    });
    const manager = new AgentManager();
    const id = spawnDisposable(manager, root);
    const worktreePath = manager.getRecord(id)!.worktree!.path;

    await manager.dispose();

    expect(worktrees(root)).not.toContain(worktreePath);
  }, 10_000);

  it("discards an internal commit without touching the source checkout", async () => {
    const root = repository();
    const sourceHead = git(root, ["rev-parse", "HEAD"]);
    const sourceStatus = git(root, ["status", "--porcelain"]);
    mocks.runAgent.mockImplementation(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const child = session(options);
      writeFileSync(join(options.cwd, "agent.txt"), "agent commit\n");
      git(options.cwd, ["add", "agent.txt"]);
      git(options.cwd, ["commit", "-qm", "agent internal commit"]);
      return { responseText: "done", session: child, aborted: false, steered: false };
    });
    const manager = new AgentManager();
    const id = spawnDisposable(manager, root);
    const record = manager.getRecord(id)!;
    const worktreePath = record.worktree!.path;

    await record.promise;

    expect(record.worktreeResult).toMatchObject({ hasChanges: true, discarded: true });
    expect(git(root, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(git(root, ["status", "--porcelain"])).toBe(sourceStatus);
    expect(git(root, ["branch", "--list"])).not.toContain("pi-agent-");
    expect(worktrees(root)).not.toContain(worktreePath);
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("source\n");
    await manager.dispose();
  });
});
