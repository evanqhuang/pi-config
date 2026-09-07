import {
  addUsage,
  aggregateDirectUsage,
  getLifetimeTotal,
  getUsageCostProvenance,
  getUsageCostStatus,
  type LifetimeUsage,
  type UsageCostProvenance,
  type UsageCostStatus,
  type UsageLedgerSummary,
} from "./usage.js";

/** A worker record needed to render current-run status and direct usage. */
export type UsageViewWorker = {
  readonly id: string;
  readonly status: string;
  readonly model?: string;
  readonly thinking?: string | boolean;
  readonly directUsageLedger?: UsageLedgerSummary;
  readonly checkpointStatus?: string;
};

/**
 * A restoration gap is deliberately permissive at this boundary: runtimes can
 * report a count, or retain a short diagnostic while restoring a run.
 */
export type UsageRestorationGap =
  | number
  | string
  | boolean
  | {
      readonly count?: number;
      readonly message?: string;
      readonly [key: string]: unknown;
    };

export type UsageViewInput = {
  readonly parent?: UsageLedgerSummary;
  readonly workers: readonly UsageViewWorker[];
  /** Authoritative current-run worker totals, including evicted records. */
  readonly workerTotals?: UsageLedgerSummary;
  readonly restorationGap?: UsageRestorationGap;
  /** Maximum exact provider/model rows shown in each section. */
  readonly maxModelRows?: number;
  /** USD model-estimate warning threshold. Omitted means no warning ceiling. */
  readonly costWarningThreshold?: number;
};

export type UsageViewModelRow = {
  readonly provider: string | null;
  readonly model: string | null;
  readonly label: string;
  /** input + output + cacheWrite; cache reads are intentionally excluded. */
  readonly displayTokens: number;
  readonly cacheReadTokens: number;
  /** The provider-reported token total, including cache reads. */
  readonly reportedTokens: number;
  readonly costStatus: UsageCostStatus;
  readonly costProvenance: UsageCostProvenance;
  /** Known model-pricing amount, when any amount is known. */
  readonly knownCost?: number;
};

export type UsageViewOverflow = {
  readonly bucketCount: number;
  readonly label: "other provider/model buckets";
  readonly displayTokens: number;
  readonly cacheReadTokens: number;
  readonly reportedTokens: number;
  readonly costStatus: UsageCostStatus;
  readonly costProvenance: UsageCostProvenance;
  readonly knownCost?: number;
};

export type UsageViewSectionSnapshot = {
  /** False means there was no ledger at all, rather than a free zero. */
  readonly available: boolean;
  readonly displayTokens: number;
  readonly cacheReadTokens: number;
  readonly reportedTokens: number;
  readonly costStatus: UsageCostStatus;
  readonly costProvenance: UsageCostProvenance;
  readonly knownCost?: number;
  readonly rows: readonly UsageViewModelRow[];
  readonly overflow?: UsageViewOverflow;
  readonly attributionGaps: number;
};

export type UsageViewWorkerStatus = {
  readonly id: string;
  readonly status: string;
  readonly model?: string;
  readonly thinking?: string | boolean;
  readonly checkpointStatus?: string;
  /** Whether this record itself carried a direct ledger. */
  readonly directUsageAvailable: boolean;
};

export type UsageViewCostWarning = {
  readonly section: "parent" | "workers";
  readonly threshold: number;
  readonly knownCost: number;
  readonly costStatus: UsageCostStatus;
};

export type UsageViewSnapshot = {
  readonly parent?: UsageViewSectionSnapshot;
  readonly workers: UsageViewSectionSnapshot;
  readonly workerStatuses: readonly UsageViewWorkerStatus[];
  readonly workerCount: number;
  readonly uniqueWorkerCount: number;
  readonly missingWorkerUsageCount: number;
  readonly restorationGap?: UsageRestorationGap;
  readonly costWarningThreshold?: number;
  readonly warnings: readonly UsageViewCostWarning[];
};

export type UsageViewResult = {
  readonly text: string;
  readonly snapshot: UsageViewSnapshot;
};

const DEFAULT_MAX_MODEL_ROWS = 8;

type MutableTotals = LifetimeUsage;

function emptyUsage(): LifetimeUsage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function boundedRows(value: number | undefined): number {
  return finite(value) ? Math.max(1, Math.floor(value)) : DEFAULT_MAX_MODEL_ROWS;
}

function knownCost(usage: LifetimeUsage): number | undefined {
  if (finite(usage.cost)) return usage.cost;
  if (finite(usage.costComponents?.total)) return usage.costComponents?.total;
  const values = [
    usage.costComponents?.input,
    usage.costComponents?.output,
    usage.costComponents?.cacheRead,
    usage.costComponents?.cacheWrite,
  ].filter(finite);
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function mergeUsage(target: MutableTotals, source: LifetimeUsage): void {
  // addUsage carries the usage module's explicit partial/unavailable status
  // merge semantics and keeps this renderer consistent with ledger totals.
  addUsage(target, source);
}

function sectionUsage(ledger: UsageLedgerSummary): LifetimeUsage {
  const total = emptyUsage();
  for (const bucket of ledger.directTotals) mergeUsage(total, bucket.usage);
  if (ledger.overflowTotal) mergeUsage(total, ledger.overflowTotal);
  return total;
}

function modelLabel(provider: string | null, model: string | null): string {
  return `${provider ?? "unknown provider"}/${model ?? "unknown model"}`;
}

function rowFromUsage(
  provider: string | null,
  model: string | null,
  usage: LifetimeUsage,
): UsageViewModelRow {
  return {
    provider,
    model,
    label: modelLabel(provider, model),
    displayTokens: getLifetimeTotal(usage),
    cacheReadTokens: usage.cacheRead ?? 0,
    reportedTokens: getLifetimeTotal(usage) + (usage.cacheRead ?? 0),
    costStatus: getUsageCostStatus(usage),
    costProvenance: getUsageCostProvenance(usage),
    ...(knownCost(usage) !== undefined ? { knownCost: knownCost(usage) } : {}),
  };
}

function overflowFromUsage(usage: LifetimeUsage, bucketCount: number): UsageViewOverflow {
  return {
    bucketCount,
    label: "other provider/model buckets",
    displayTokens: getLifetimeTotal(usage),
    cacheReadTokens: usage.cacheRead ?? 0,
    reportedTokens: getLifetimeTotal(usage) + (usage.cacheRead ?? 0),
    costStatus: getUsageCostStatus(usage),
    costProvenance: getUsageCostProvenance(usage),
    ...(knownCost(usage) !== undefined ? { knownCost: knownCost(usage) } : {}),
  };
}

function normaliseLedger(ledger: UsageLedgerSummary): UsageLedgerSummary {
  // A summary normally already has unique buckets. Re-aggregating also makes
  // the view safe for deserialised summaries and guarantees provider/model
  // grouping without mutating caller-owned state.
  return aggregateDirectUsage([ledger]);
}

function makeSection(ledger: UsageLedgerSummary | undefined, maxRows: number): UsageViewSectionSnapshot {
  if (!ledger) {
    return {
      available: false,
      displayTokens: 0,
      cacheReadTokens: 0,
      reportedTokens: 0,
      costStatus: "unavailable",
      costProvenance: "unknown",
      rows: [],
      attributionGaps: 0,
    };
  }

  const normalised = normaliseLedger(ledger);
  const total = sectionUsage(normalised);
  const buckets = normalised.directTotals;
  const rows = buckets.slice(0, maxRows).map(bucket => rowFromUsage(bucket.provider, bucket.model, bucket.usage));
  const hiddenUsage = emptyUsage();
  let hiddenBucketCount = 0;
  for (const bucket of buckets.slice(maxRows)) {
    mergeUsage(hiddenUsage, bucket.usage);
    hiddenBucketCount += 1;
  }
  if (normalised.overflowTotal) {
    mergeUsage(hiddenUsage, normalised.overflowTotal);
    hiddenBucketCount += 1;
  }

  return {
    available: true,
    displayTokens: getLifetimeTotal(total),
    cacheReadTokens: total.cacheRead ?? 0,
    reportedTokens: getLifetimeTotal(total) + (total.cacheRead ?? 0),
    costStatus: getUsageCostStatus(total),
    costProvenance: getUsageCostProvenance(total),
    ...(knownCost(total) !== undefined ? { knownCost: knownCost(total) } : {}),
    rows,
    ...(hiddenBucketCount > 0 ? { overflow: overflowFromUsage(hiddenUsage, hiddenBucketCount) } : {}),
    attributionGaps: normalised.attributionGaps,
  };
}

function restorationGapCount(gap: UsageRestorationGap | undefined): number {
  if (typeof gap === "number") return finite(gap) ? Math.max(0, Math.floor(gap)) : 0;
  if (typeof gap === "object" && gap !== null && finite(gap.count)) return Math.max(0, Math.floor(gap.count));
  return gap === undefined || gap === false ? 0 : 1;
}

function restorationGapLabel(gap: UsageRestorationGap | undefined): string | undefined {
  if (gap === undefined || gap === false) return undefined;
  if (typeof gap === "string" && gap.length > 0) return gap;
  if (typeof gap === "object" && gap !== null && gap.message) return gap.message;
  const count = restorationGapCount(gap);
  return `restored usage gap: ${count || 1}`;
}

function statusText(worker: UsageViewWorkerStatus): string {
  const details = [worker.status];
  if (worker.model) details.push(`model ${worker.model}`);
  if (worker.thinking !== undefined) details.push(`thinking ${String(worker.thinking)}`);
  if (worker.checkpointStatus) details.push(`checkpoint ${worker.checkpointStatus}`);
  if (!worker.directUsageAvailable) details.push("usage unavailable");
  return `${worker.id} [${details.join("; ")}]`;
}

function formatTokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`;
}

function costText(section: UsageViewSectionSnapshot | UsageViewModelRow): string {
  if (section.costStatus === "unavailable") return "cost unavailable";
  const amount = section.knownCost === undefined ? "unknown" : formatCost(section.knownCost);
  if (section.costStatus === "partial") return `partial known subtotal ${amount}`;
  if (section.costProvenance === "unknown") return `priced estimate ${amount} (provenance unknown)`;
  return `priced estimate ${amount}`;
}

function sectionText(name: string, section: UsageViewSectionSnapshot): string {
  if (!section.available) return `${name}: usage unavailable (no current-run ledger; not zero)`;
  const rows = section.rows.map(row => `${row.label} ${formatTokens(row.displayTokens)} (${costText(row)})`).join(", ");
  const rowText = rows.length > 0 ? `; ${rows}` : "";
  const overflow = section.overflow
    ? `; +${section.overflow.bucketCount} overflow bucket${section.overflow.bucketCount === 1 ? "" : "s"}`
    : "";
  const gaps = section.attributionGaps > 0 ? `; attribution gaps ${section.attributionGaps}` : "";
  return `${name}: display tokens ${formatTokens(section.displayTokens)} (cache-read ${formatTokens(section.cacheReadTokens)}, reported ${formatTokens(section.reportedTokens)}); ${costText(section)}${rowText}${overflow}${gaps}`;
}

function normaliseThreshold(value: number | undefined): number | undefined {
  return finite(value) && value >= 0 ? value : undefined;
}

function warningFor(
  section: "parent" | "workers",
  snapshot: UsageViewSectionSnapshot,
  threshold: number | undefined,
): UsageViewCostWarning | undefined {
  if (threshold === undefined || snapshot.knownCost === undefined || snapshot.costStatus === "unavailable") return undefined;
  return snapshot.knownCost > threshold
    ? { section, threshold, knownCost: snapshot.knownCost, costStatus: snapshot.costStatus }
    : undefined;
}

function uniqueWorkers(workers: readonly UsageViewWorker[]): UsageViewWorker[] {
  const seen = new Set<string>();
  const unique: UsageViewWorker[] = [];
  for (const worker of workers) {
    if (seen.has(worker.id)) continue;
    seen.add(worker.id);
    unique.push(worker);
  }
  return unique;
}

/**
 * Render pure, current-run usage. Worker totals are direct ledgers only:
 * neither this helper nor its snapshot reads ancestor lifetime usage.
 */
export function renderUsageView(input: UsageViewInput): UsageViewResult {
  const maxRows = boundedRows(input.maxModelRows);
  const unique = uniqueWorkers(input.workers);
  const ledgerByWorkerId = new Map<string, UsageLedgerSummary | undefined>();
  for (const worker of input.workers) {
    if (!ledgerByWorkerId.has(worker.id)) ledgerByWorkerId.set(worker.id, worker.directUsageLedger);
    else if (ledgerByWorkerId.get(worker.id) === undefined && worker.directUsageLedger !== undefined) {
      // A stale duplicate may lack its ledger while a later record has it;
      // still select at most one ledger for this worker id.
      ledgerByWorkerId.set(worker.id, worker.directUsageLedger);
    }
  }
  const workerLedgers = [...ledgerByWorkerId.values()]
    .filter((ledger): ledger is UsageLedgerSummary => ledger !== undefined);
  // workerTotals is authoritative when supplied. In particular, it is not
  // added to visible worker records, which may be retained copies of the same
  // current-run usage.
  const workerLedger = input.workerTotals ?? (workerLedgers.length > 0 ? aggregateDirectUsage(workerLedgers) : undefined);
  const parent = makeSection(input.parent, maxRows);
  const workers = makeSection(workerLedger, maxRows);
  const threshold = normaliseThreshold(input.costWarningThreshold);
  const warnings = [
    warningFor("parent", parent, threshold),
    warningFor("workers", workers, threshold),
  ].filter((warning): warning is UsageViewCostWarning => warning !== undefined);
  const workerStatuses = unique.map(worker => ({
    id: worker.id,
    status: worker.status,
    ...(worker.model !== undefined ? { model: worker.model } : {}),
    ...(worker.thinking !== undefined ? { thinking: worker.thinking } : {}),
    ...(worker.checkpointStatus !== undefined ? { checkpointStatus: worker.checkpointStatus } : {}),
    directUsageAvailable: worker.directUsageLedger !== undefined,
  }));
  const missingWorkerUsageCount = input.workerTotals === undefined
    ? unique.filter(worker => ledgerByWorkerId.get(worker.id) === undefined).length
    : 0;
  const snapshot: UsageViewSnapshot = {
    ...(input.parent !== undefined ? { parent } : {}),
    workers,
    workerStatuses,
    workerCount: input.workers.length,
    uniqueWorkerCount: unique.length,
    missingWorkerUsageCount,
    ...(input.restorationGap !== undefined ? { restorationGap: input.restorationGap } : {}),
    ...(threshold !== undefined ? { costWarningThreshold: threshold } : {}),
    warnings,
  };

  const lines = [sectionText("parent", parent), sectionText("workers", workers)];
  if (workerStatuses.length > 0) lines.push(`worker status: ${workerStatuses.map(statusText).join(", ")}`);
  if (missingWorkerUsageCount > 0) lines.push(`worker usage gap: ${missingWorkerUsageCount} record${missingWorkerUsageCount === 1 ? "" : "s"} missing direct ledger (not zero)`);
  const restoration = restorationGapLabel(input.restorationGap);
  if (restoration) lines.push(restoration);
  if (warnings.length > 0) {
    lines.push(warnings.map(warning => `${warning.section} cost warning: ${formatCost(warning.knownCost)} exceeds configured threshold ${formatCost(warning.threshold)}`).join("; "));
  }

  return { text: lines.join("\n"), snapshot };
}

/** Descriptive alias for callers that prefer the current-run name. */
export const renderCurrentRunUsage = renderUsageView;
