import { describe, expect, it } from "vitest";
import {
  createUsageLedger,
  recordUsageContribution,
  type LifetimeUsage,
  type UsageLedgerSummary,
} from "../src/usage.js";
import { renderUsageView, type UsageViewWorker } from "../src/usage-view.js";

const usage = (overrides: Partial<LifetimeUsage> = {}): LifetimeUsage => ({
  input: 10,
  output: 2,
  cacheWrite: 1,
  ...overrides,
});

function ledgerFor(
  entries: Array<{
    provider?: string | null;
    model?: string | null;
    id: string;
    usage?: LifetimeUsage;
  }>,
): UsageLedgerSummary {
  let ledger = createUsageLedger({ maxProviderModelBuckets: 32 });
  for (const entry of entries) {
    ledger = recordUsageContribution(ledger, {
      provider: "provider" in entry ? entry.provider : "acme",
      model: "model" in entry ? entry.model : "model-a",
      attemptId: entry.id,
      messageId: `${entry.id}-message`,
      usage: entry.usage ?? usage(),
    }).ledger;
  }
  return ledger;
}

describe("current-run usage view", () => {
  it("counts mixed nested direct ledgers once and never uses ancestor lifetime usage", () => {
    const root = ledgerFor([{ id: "root", usage: usage({ input: 3 }) }]);
    const child = ledgerFor([{ id: "child", usage: usage({ input: 7 }) }]);
    const workers: UsageViewWorker[] = [
      { id: "root", status: "running", directUsageLedger: root },
      { id: "child", status: "running", directUsageLedger: child },
    ];

    const result = renderUsageView({
      parent: ledgerFor([{ id: "parent", usage: usage({ input: 100 }) }]),
      workers,
    });

    expect(result.snapshot.parent?.displayTokens).toBe(103);
    expect(result.snapshot.workers.displayTokens).toBe(16);
    expect(result.snapshot.workers.rows[0]?.displayTokens).toBe(16);
    expect(result.text).not.toContain("lifetime");
  });

  it("deduplicates worker records by id while preserving status rows", () => {
    const first = ledgerFor([{ id: "first", usage: usage({ input: 1 }) }]);
    const duplicate = ledgerFor([{ id: "duplicate", usage: usage({ input: 90 }) }]);
    const result = renderUsageView({
      workers: [
        { id: "worker-1", status: "running", directUsageLedger: first },
        { id: "worker-1", status: "running", directUsageLedger: duplicate },
      ],
    });

    expect(result.snapshot.workerCount).toBe(2);
    expect(result.snapshot.uniqueWorkerCount).toBe(1);
    expect(result.snapshot.workers.displayTokens).toBe(4);
    expect(result.snapshot.workerStatuses).toHaveLength(1);
  });

  it("shows unknown and partial pricing, missing models, and missing ledgers", () => {
    const unknown = ledgerFor([{ id: "unknown", provider: "acme", model: null }]);
    const partial = ledgerFor([{
      id: "partial",
      provider: "acme",
      model: "model-b",
      usage: usage({ costComponents: { input: 1, output: 2 } }),
    }]);
    const result = renderUsageView({
      workers: [
        { id: "unknown-model", status: "running", directUsageLedger: unknown },
        { id: "partial-cost", status: "checkpointing", checkpointStatus: "pending", directUsageLedger: partial },
        { id: "restored", status: "completed" },
      ],
    });

    expect(result.snapshot.workers.costStatus).toBe("partial");
    expect(result.snapshot.workers.rows.map(row => row.label)).toContain("acme/unknown model");
    expect(result.snapshot.missingWorkerUsageCount).toBe(1);
    expect(result.text).toContain("partial known subtotal");
    expect(result.text).toContain("cost unavailable");
    expect(result.text).toContain("checkpoint pending");
    expect(result.text).toContain("not zero");
  });

  it("keeps no-parent data visibly unavailable", () => {
    const result = renderUsageView({
      workers: [{ id: "no-ledger", status: "running" }],
      restorationGap: { count: 1, message: "restored worker usage is incomplete" },
    });

    expect(result.snapshot.parent).toBeUndefined();
    expect(result.text).toContain("parent: usage unavailable");
    expect(result.text).toContain("restored worker usage is incomplete");
    expect(result.text).not.toContain("parent: display tokens 0");
  });

  it("bounds model rows and retains an overflow summary", () => {
    const entries = Array.from({ length: 5 }, (_, index) => ({
      id: `entry-${index}`,
      provider: "acme",
      model: `model-${index}`,
      usage: usage({ input: index + 1 }),
    }));
    const result = renderUsageView({
      workers: [{ id: "worker", status: "running", directUsageLedger: ledgerFor(entries) }],
      maxModelRows: 2,
    });

    expect(result.snapshot.workers.rows).toHaveLength(2);
    expect(result.snapshot.workers.overflow?.bucketCount).toBe(3);
    expect(result.snapshot.workers.overflow?.displayTokens).toBe(21);
    expect(result.text).toContain("overflow buckets");
  });

  it("uses an explicit cost threshold only when configured", () => {
    const priced = ledgerFor([{ id: "priced", usage: usage({ cost: 12 }) }]);
    const withoutThreshold = renderUsageView({ workers: [{ id: "w", status: "done", directUsageLedger: priced }] });
    const withThreshold = renderUsageView({
      workers: [{ id: "w", status: "done", directUsageLedger: priced }],
      costWarningThreshold: 1,
    });

    expect(withoutThreshold.snapshot.warnings).toEqual([]);
    expect(withoutThreshold.text).not.toContain("warning");
    expect(withThreshold.snapshot.warnings).toHaveLength(1);
    expect(withThreshold.text).toContain("configured threshold");
  });

  it("uses retained workerTotals instead of adding visible records", () => {
    const visibleRecord = ledgerFor([{ id: "visible", usage: usage({ input: 1 }) }]);
    const retainedTotals = ledgerFor([{ id: "retained", usage: usage({ input: 9 }) }]);
    const result = renderUsageView({
      workerTotals: retainedTotals,
      workers: [{ id: "worker", status: "completed", directUsageLedger: visibleRecord }],
    });

    expect(result.snapshot.workers.displayTokens).toBe(12);
    expect(result.snapshot.workers.displayTokens).not.toBe(16);

    const afterRecordEviction = renderUsageView({ workerTotals: retainedTotals, workers: [] });
    expect(afterRecordEviction.snapshot.workers.displayTokens).toBe(12);
  });
});
