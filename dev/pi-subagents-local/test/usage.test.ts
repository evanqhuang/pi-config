import { describe, expect, it } from "vitest";
import {
  addUsage,
  aggregateUsageIncludingDescendants,
  createUsageLedger,
  getDirectUsageTotals,
  getLifetimeTotal,
  getUsageCostProvenance,
  getUsageCostStatus,
  PendingUsagePool,
  recordUsageContribution,
  toReportedUsage,
  type LifetimeUsage,
} from "../src/usage.js";

const tokens = (overrides: Partial<LifetimeUsage> = {}): LifetimeUsage => ({
  input: 10,
  output: 2,
  cacheWrite: 1,
  ...overrides,
});

describe("usage cost contract", () => {
  it("keeps display total semantics and makes pricing status explicit", () => {
    expect(getLifetimeTotal({ input: 2, output: 3, cacheWrite: 4, cacheRead: 99, cost: 7 })).toBe(9);
    expect(getUsageCostStatus(tokens())).toBe("unavailable");
    expect(getUsageCostProvenance(tokens())).toBe("unknown");
    expect(getUsageCostStatus(tokens({ cost: 0 }))).toBe("model-priced");
    expect(getUsageCostStatus(tokens({ costComponents: { input: 1, output: 2 } }))).toBe("partial");
  });

  it("retains detailed cost components through addUsage and the existing SDK shape", () => {
    const total = tokens({ costComponents: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
    addUsage(total, tokens({ input: 1, output: 1, cacheWrite: 1, costComponents: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } }));

    expect(total.cost).toBe(36);
    expect(total.costComponents).toEqual({ input: 6, output: 8, cacheRead: 10, cacheWrite: 12 });
    expect(toReportedUsage(total)).toEqual({
      input: 11,
      output: 3,
      cacheRead: 0,
      cacheWrite: 2,
      totalTokens: 16,
      cost: { input: 6, output: 8, cacheRead: 10, cacheWrite: 12, total: 36 },
    });
  });

  it("drains detailed pending usage exactly once", () => {
    const pool = new PendingUsagePool();
    pool.add(tokens({ costComponents: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }));

    expect(pool.drain()?.cost).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 });
    expect(pool.drain()).toBeUndefined();
  });
});

describe("bounded usage attribution ledger", () => {
  it("attributes direct usage by provider/model and deduplicates stable identities", () => {
    let ledger = createUsageLedger({ maxRememberedIdentities: 4 });
    const contribution = {
      provider: "acme",
      model: "model-a",
      attemptId: "attempt-1",
      messageId: "message-1",
      usage: tokens({ cost: 3 }),
    };

    const first = recordUsageContribution(ledger, contribution);
    ledger = first.ledger;
    expect(first).toMatchObject({ accepted: true, duplicate: false, attributionGap: false });
    ledger = recordUsageContribution(ledger, contribution).ledger;

    expect(ledger.duplicateCount).toBe(1);
    expect(ledger.contributionCount).toBe(1);
    expect(getDirectUsageTotals(ledger)).toEqual([
      {
        provider: "acme",
        model: "model-a",
        usage: expect.objectContaining({ input: 10, output: 2, cacheWrite: 1, cost: 3 }),
        contributionCount: 1,
      },
    ]);
  });

  it("keeps unknown identity and pricing visible and bounds continuation state", () => {
    let ledger = createUsageLedger({ maxRememberedIdentities: 1, maxProviderModelBuckets: 2 });
    ledger = recordUsageContribution(ledger, {
      provider: null,
      model: null,
      attemptId: null,
      messageId: null,
      usage: tokens(),
    }).ledger;
    ledger = recordUsageContribution(ledger, {
      provider: "acme",
      model: "model-b",
      attemptId: "attempt-2",
      messageId: "message-2",
      usage: tokens({ cost: 1 }),
    }).ledger;
    ledger = recordUsageContribution(ledger, {
      provider: "acme",
      model: "model-c",
      attemptId: "attempt-3",
      messageId: "message-3",
      usage: tokens({ cost: 1 }),
    }).ledger;

    expect(ledger.version).toBe(1);
    expect(ledger.continuation.recentContributionIds).toHaveLength(1);
    expect(ledger.gapDetails.unknownIdentity).toBe(1);
    expect(ledger.gapDetails.unknownProviderOrModel).toBe(1);
    expect(ledger.gapDetails.unknownPricing).toBe(1);
    expect(ledger.gapDetails.overflowBuckets).toBe(1);
    expect(ledger.overflowTotal).toBeDefined();
    expect(ledger.attributionGaps).toBeGreaterThan(0);
  });

  it("keeps direct and descendant-inclusive totals separate", () => {
    let root = createUsageLedger();
    root = recordUsageContribution(root, {
      provider: "acme",
      model: "model-a",
      attemptId: "root-attempt",
      messageId: "root-message",
      usage: tokens({ input: 1 }),
    }).ledger;
    let child = createUsageLedger();
    child = recordUsageContribution(child, {
      provider: "acme",
      model: "model-a",
      attemptId: "child-attempt",
      messageId: "child-message",
      usage: tokens({ input: 4 }),
    }).ledger;

    const nodes = [
      { agentId: "root", parentAgentId: null, ledger: root },
      { agentId: "child", parentAgentId: "root", ledger: child },
    ];
    expect(aggregateUsageIncludingDescendants(nodes, "root").directTotals[0]?.usage.input).toBe(5);
    expect(root.directTotals[0]?.usage.input).toBe(1);
  });
});
