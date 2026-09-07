import { describe, expect, it, vi } from "vitest";

const runnerMocks = vi.hoisted(() => ({ runAgent: vi.fn() }));

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/agent-runner.js")>()),
  runAgent: runnerMocks.runAgent,
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent } from "../src/agent-runner.js";
import { getDirectUsageTotals } from "../src/usage.js";

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    usage: {
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

describe("runtime usage attribution", () => {
  it("emits stable per-attempt identities, message pricing, and model fallbacks on resume", async () => {
    const listeners: Array<(event: any) => void> = [];
    const session: any = {
      messages: [],
      model: {
        provider: "fallback-provider",
        id: "fallback-model",
        cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      },
      subscribe(listener: (event: any) => void) {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        };
      },
      async prompt() {
        const messages = [
          assistantMessage({
            provider: "priced-provider",
            model: "priced-model",
            usage: {
              input: 10,
              output: 3,
              cacheRead: 2,
              cacheWrite: 1,
              cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
            },
          }),
          assistantMessage({ provider: "unpriced-provider", model: "unpriced-model" }),
          assistantMessage({ provider: undefined, model: undefined }),
        ];
        for (const message of messages) {
          session.messages.push(message);
          for (const listener of [...listeners]) listener({ type: "message_end", message });
        }
      },
    };

    const contributions: any[] = [];
    const legacy: any[] = [];
    await resumeAgent(session, "continue", {
      onUsageContribution: contribution => contributions.push(contribution),
      onAssistantUsage: usage => legacy.push(usage),
    });

    expect(contributions).toHaveLength(3);
    expect(legacy).toHaveLength(3);
    expect(new Set(contributions.map(c => c.attemptId)).size).toBe(1);
    expect(contributions.map(c => c.messageId)).toEqual(["1", "2", "3"]);
    expect(contributions[0]).toMatchObject({ provider: "priced-provider", model: "priced-model" });
    expect(contributions[0].usage).toMatchObject({
      cacheRead: 2,
      cost: 10,
      costComponents: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      costStatus: "model-priced",
      costProvenance: "model-pricing-estimate",
    });
    expect(contributions[1].usage).toMatchObject({ costStatus: "unavailable", costProvenance: "unknown" });
    expect(contributions[2]).toMatchObject({ provider: "fallback-provider", model: "fallback-model" });
    expect(contributions[2].usage.costStatus).toBe("model-priced");

    await resumeAgent(session, "continue again", {
      onUsageContribution: contribution => contributions.push(contribution),
    });
    expect(contributions).toHaveLength(6);
    expect(contributions[3].attemptId).not.toBe(contributions[0].attemptId);
    expect(contributions[3].messageId).toBe("1");
  });

  it("keeps accepted direct worker usage after the AgentRecord is evicted", async () => {
    runnerMocks.runAgent.mockImplementationOnce(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      const usage = { input: 7, output: 2, cacheWrite: 1, cacheRead: 4, cost: 5 };
      const contribution = {
        provider: "worker-provider",
        model: "worker-model",
        attemptId: "attempt-1",
        messageId: "1",
        usage,
      };
      options.onUsageContribution?.(contribution);
      options.onAssistantUsage?.(usage);
      return { responseText: "done", session: { dispose() {} }, aborted: false, steered: false };
    });

    const managerUsage = vi.fn();
    const legacyUsage = vi.fn();
    const contributionUsage = vi.fn();
    const manager = new AgentManager(undefined, 10, undefined, undefined, managerUsage);
    const id = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "work", {
      description: "work",
      onAssistantUsage: legacyUsage,
      onUsageContribution: contributionUsage,
    });
    await manager.getRecord(id)!.promise;

    expect(managerUsage).toHaveBeenCalledTimes(1);
    expect(legacyUsage).toHaveBeenCalledTimes(1);
    expect(contributionUsage).toHaveBeenCalledTimes(1);
    expect(getDirectUsageTotals(manager.getCurrentRunUsageLedger())).toEqual([
      expect.objectContaining({ provider: "worker-provider", model: "worker-model" }),
    ]);

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
    expect(manager.getCurrentRunUsageTotals()[0]?.usage).toMatchObject({ input: 7, output: 2, cacheWrite: 1 });
    await manager.dispose();
  });

  it("does not restore legacy inclusive usage into direct or current-run totals", async () => {
    let release!: () => void;
    const started = new Promise<void>(resolve => { release = resolve; });
    const freshUsage = { input: 4, output: 2, cacheWrite: 1, cacheRead: 3, cost: 2 };
    const freshContribution = {
      provider: "fresh-provider",
      model: "fresh-model",
      attemptId: "fresh-attempt",
      messageId: "1",
      usage: freshUsage,
    };
    runnerMocks.runAgent.mockImplementationOnce(async (_ctx: unknown, _type: string, _prompt: string, options: any) => {
      await started;
      options.onUsageContribution?.(freshContribution);
      // A repeated delivery of the same message must not double-count it.
      options.onUsageContribution?.(freshContribution);
      options.onAssistantUsage?.(freshUsage);
      return { responseText: "done", session: { dispose() {} }, aborted: false, steered: false };
    });

    const manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: "/repo" } as any, "general-purpose", "legacy", {
      description: "legacy",
    });
    const record = manager.getRecord(id)!;
    const legacyLifetime = { input: 100, output: 40, cacheRead: 20, cacheWrite: 10, cost: 9 };
    delete record.directUsageLedger;
    record.lifetimeUsage = legacyLifetime;

    const restored = manager.getRecord(id)!;
    expect(restored.lifetimeUsage).toBe(legacyLifetime);
    expect(restored.directUsageLedger).toMatchObject({
      directTotals: [],
      contributionCount: 0,
      attributionGaps: 1,
      gapDetails: { unknownIdentity: 1 },
    });
    // Re-reading a legacy record does not re-add its inclusive history.
    expect(manager.listAgents()[0]!.directUsageLedger?.attributionGaps).toBe(1);
    expect(manager.getCurrentRunUsageTotals()).toEqual([]);

    release();
    await manager.getRecord(id)!.promise;

    expect(getDirectUsageTotals(manager.getRecord(id)!.directUsageLedger!)).toEqual([
      expect.objectContaining({
        provider: "fresh-provider",
        model: "fresh-model",
        usage: expect.objectContaining({ input: 4, output: 2, cacheWrite: 1 }),
        contributionCount: 1,
      }),
    ]);
    expect(manager.getCurrentRunUsageTotals()).toEqual([
      expect.objectContaining({
        provider: "fresh-provider",
        model: "fresh-model",
        usage: expect.objectContaining({ input: 4, output: 2, cacheWrite: 1 }),
        contributionCount: 1,
      }),
    ]);
    await manager.dispose();
  });
});
