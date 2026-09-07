/** usage.ts — Pure token/cost usage attribution and session-stats readers. */

/**
 * The four separately priced parts of a model response.
 *
 * These fields are optional on purpose.  Older callers only supplied `cost`,
 * and some providers only price a subset of the parts.  An omitted field is
 * unknown, not an assertion that the part cost zero.
 */
export type UsageCostComponents = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** A provider-supplied total, when it is available independently. */
  total?: number;
};

/** Cost is always an estimate from model pricing; it is never a subscription charge. */
export type UsageCostProvenance = "model-pricing-estimate" | "unknown";
export type UsageCostStatus = "model-priced" | "partial" | "unavailable";

/**
 * Lifetime usage components, accumulated via `message_end` events.  `cost` is
 * retained as the old flat total for source compatibility.  New code can use
 * `costComponents` for the detailed model-pricing estimate and
 * `costStatus`/`costProvenance` to distinguish unknown pricing from a zero
 * estimate.
 *
 * `cacheRead` is excluded from `getLifetimeTotal`, but retained for billing
 * and reporting.  See the function documentation below.
 */
export type LifetimeUsage = {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead?: number;
  cost?: number;
  costComponents?: UsageCostComponents;
  costStatus?: UsageCostStatus;
  costProvenance?: UsageCostProvenance;
};

const COST_COMPONENT_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type CostComponentKey = (typeof COST_COMPONENT_KEYS)[number];

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasDefinedCostComponent(components: UsageCostComponents | undefined, key: CostComponentKey): boolean {
  return components?.[key] !== undefined;
}

function hasAnyCostData(u: LifetimeUsage | undefined): boolean {
  if (!u) return false;
  if (u.cost !== undefined) return true;
  if (u.costComponents?.total !== undefined) return true;
  return COST_COMPONENT_KEYS.some(key => hasDefinedCostComponent(u.costComponents, key));
}

function knownComponentTotal(components: UsageCostComponents | undefined): number | undefined {
  if (!components) return undefined;
  const known = COST_COMPONENT_KEYS.filter(key => isFiniteNumber(components[key]));
  if (known.length === 0) return undefined;
  return known.reduce((sum, key) => sum + (components[key] as number), 0);
}

function usageCostTotal(u: LifetimeUsage | undefined): number | undefined {
  if (!u) return undefined;
  if (isFiniteNumber(u.cost)) return u.cost;
  if (isFiniteNumber(u.costComponents?.total)) return u.costComponents.total;
  return knownComponentTotal(u.costComponents);
}

/**
 * Return the explicit cost status, or infer it from the supplied fields.
 * Missing pricing is represented as `unavailable`; it is not silently
 * reclassified as a zero-priced response.
 */
export function getUsageCostStatus(u?: LifetimeUsage): UsageCostStatus {
  if (u?.costStatus) return u.costStatus;
  if (!hasAnyCostData(u)) return "unavailable";

  const components = u?.costComponents;
  if (!components) return "model-priced";
  const hasComponent = COST_COMPONENT_KEYS.some(key => hasDefinedCostComponent(components, key));
  const allComponents = COST_COMPONENT_KEYS.every(key => hasDefinedCostComponent(components, key));
  if (allComponents) return "model-priced";
  // A total without component detail is still a known estimate.  Once a
  // partial breakdown is supplied, however, call the missing parts out.
  if (!hasComponent && (u?.cost !== undefined || components.total !== undefined)) return "model-priced";
  return "partial";
}

/** Return the provenance of a cost value; no value denotes a real charge. */
export function getUsageCostProvenance(u?: LifetimeUsage): UsageCostProvenance {
  if (u?.costProvenance) return u.costProvenance;
  return getUsageCostStatus(u) === "unavailable" ? "unknown" : "model-pricing-estimate";
}

/**
 * Sum of lifetime *token* components for DISPLAY, or 0 if undefined.
 * Deliberately excludes `cacheRead` and cost — that is money, not tokens.
 */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? u.input + u.output + u.cacheWrite : 0;
}

/** Accumulated cost in USD, or 0 when the old display API has no known total. */
export function getLifetimeCost(u?: LifetimeUsage): number {
  return usageCostTotal(u) ?? 0;
}

function copyCostComponents(components: UsageCostComponents | undefined): UsageCostComponents | undefined {
  return components ? { ...components } : undefined;
}

function copyUsage(u: LifetimeUsage): LifetimeUsage {
  return {
    input: u.input,
    output: u.output,
    cacheWrite: u.cacheWrite,
    ...(u.cacheRead !== undefined ? { cacheRead: u.cacheRead } : {}),
    ...(u.cost !== undefined ? { cost: u.cost } : {}),
    ...(u.costComponents ? { costComponents: copyCostComponents(u.costComponents) } : {}),
    ...(u.costStatus ? { costStatus: u.costStatus } : {}),
    ...(u.costProvenance ? { costProvenance: u.costProvenance } : {}),
  };
}

function addCostComponents(into: LifetimeUsage, delta: LifetimeUsage): void {
  if (!delta.costComponents) return;
  const existing = into.costComponents ?? {};
  const merged: UsageCostComponents = { ...existing };
  for (const key of [...COST_COMPONENT_KEYS, "total"] as const) {
    const value = delta.costComponents[key];
    if (value !== undefined) merged[key] = (existing[key] ?? 0) + value;
  }
  into.costComponents = merged;
}

function mergeCostMetadata(into: LifetimeUsage, delta: LifetimeUsage): void {
  // Flat `cost` is the legacy field.  Its status remains available through
  // getUsageCostStatus() without adding metadata properties to old accumulators;
  // detailed components and explicit metadata are the new contract.
  const incomingStatus = delta.costStatus ?? (delta.costComponents ? getUsageCostStatus(delta) : undefined);
  const existingStatus = into.costStatus ?? (into.costComponents ? getUsageCostStatus(into) : undefined);
  if (incomingStatus) {
    into.costStatus = existingStatus ? mergeCostStatuses(existingStatus, incomingStatus) : incomingStatus;
  }

  const incomingProvenance = delta.costProvenance ?? (delta.costComponents ? getUsageCostProvenance(delta) : undefined);
  const existingProvenance = into.costProvenance ?? (into.costComponents ? getUsageCostProvenance(into) : undefined);
  if (incomingProvenance) {
    into.costProvenance = mergeCostProvenance(existingProvenance, incomingProvenance, into.costStatus);
  }
}

function mergeCostStatuses(a: UsageCostStatus, b: UsageCostStatus): UsageCostStatus {
  if (a === b) return a;
  if (a === "unavailable" && b === "unavailable") return "unavailable";
  return "partial";
}

function mergeCostProvenance(
  a: UsageCostProvenance | undefined,
  b: UsageCostProvenance,
  status: UsageCostStatus | undefined,
): UsageCostProvenance {
  if (status === "unavailable") return "unknown";
  if (a === "unknown" || b === "unknown") return "unknown";
  return "model-pricing-estimate";
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  into.input += delta.input;
  into.output += delta.output;
  into.cacheWrite += delta.cacheWrite;
  if (delta.cacheRead !== undefined) into.cacheRead = (into.cacheRead ?? 0) + delta.cacheRead;

  // Keep the historical flat total, while accepting a detailed-only delta.
  // A partial breakdown contributes its known subtotal but remains marked
  // `partial` below, so the missing amount is not mistaken for zero.
  const deltaCost = usageCostTotal(delta);
  // Preserve the old no-op appearance for an unadorned flat cost of zero;
  // explicit metadata or detailed components still make that zero meaningful.
  if (deltaCost !== undefined &&
      (deltaCost !== 0 || into.cost !== undefined || delta.costStatus !== undefined ||
        delta.costProvenance !== undefined || delta.costComponents !== undefined)) {
    into.cost = (usageCostTotal(into) ?? 0) + deltaCost;
  }
  addCostComponents(into, delta);
  mergeCostMetadata(into, delta);
}

/**
 * A pi `Usage`.  This is deliberately the SDK shape: attribution metadata
 * stays in LifetimeUsage/ledger records, while SDK consumers continue to get
 * the same object they have always received.
 */
export type ReportedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

/**
 * Render an accumulator as a pi `Usage`, or undefined when nothing was spent.
 * `cacheRead` is included here because pi sums it across assistant messages.
 * Detailed components are copied into the SDK's existing cost fields; no new
 * SDK shape is introduced.
 */
export function toReportedUsage(u: LifetimeUsage): ReportedUsage | undefined {
  const { input, output, cacheWrite, cacheRead = 0 } = u;
  const components = u.costComponents;
  const costInput = components?.input ?? 0;
  const costOutput = components?.output ?? 0;
  const costCacheRead = components?.cacheRead ?? 0;
  const costCacheWrite = components?.cacheWrite ?? 0;
  const cost = usageCostTotal(u) ?? 0;
  if (input === 0 && output === 0 && cacheWrite === 0 && cacheRead === 0 && cost === 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: cost,
    },
  };
}

/**
 * Subagent spend that the parent session has not been told about yet.  Drain
 * empties it, so each message is reported exactly once.
 */
export class PendingUsagePool {
  private pending: LifetimeUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
  private dirty = false;

  add(delta: LifetimeUsage): void {
    addUsage(this.pending, delta);
    this.dirty = true;
  }

  /** Take everything accumulated so far as a pi `Usage`, resetting the pool. */
  drain(): ReportedUsage | undefined {
    if (!this.dirty) return undefined;
    const drained = toReportedUsage(this.pending);
    this.pending = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
    this.dirty = false;
    return drained;
  }
}

/** A stable message identity used for exactly-once attribution. */
export type UsageMessageIdentity = {
  attemptId: string | null;
  messageId: string | null;
};

/**
 * One message's direct contribution.  Flat identity fields are convenient for
 * event adapters; `identity` is accepted as a serialisation-friendly alias.
 * Missing provider/model/identity values are kept as null in the ledger, not
 * silently converted into an invented name.
 */
export type UsageMessageContribution = {
  provider?: string | null;
  model?: string | null;
  attemptId?: string | null;
  messageId?: string | null;
  identity?: Partial<UsageMessageIdentity>;
  usage: LifetimeUsage;
};

export type UsageAttributionGapDetails = {
  unknownIdentity: number;
  evictedIdentities: number;
  unknownProviderOrModel: number;
  unknownPricing: number;
  partialPricing: number;
  overflowBuckets: number;
};

export type UsageLedgerContinuation = {
  version: 1;
  maxRememberedIdentities: number;
  recentContributionIds: readonly string[];
  evictedIdentities: number;
};

export type UsageProviderModelTotal = {
  provider: string | null;
  model: string | null;
  usage: LifetimeUsage;
  contributionCount: number;
};

export type UsageLedgerOptions = {
  /** Maximum identities retained for duplicate detection. */
  maxRememberedIdentities?: number;
  /** Maximum exact provider/model buckets retained in the bounded summary. */
  maxProviderModelBuckets?: number;
};

/** Version for persisted/continued ledger summaries. */
export const USAGE_LEDGER_VERSION = 1 as const;

/**
 * A bounded, serialisable direct-usage ledger.  `directTotals` contains only
 * direct message usage.  It intentionally has no descendant totals: callers
 * must opt into those through `aggregateUsageIncludingDescendants`.
 */
export type UsageLedgerSummary = {
  version: typeof USAGE_LEDGER_VERSION;
  maxRememberedIdentities: number;
  maxProviderModelBuckets: number;
  directTotals: readonly UsageProviderModelTotal[];
  overflowTotal?: LifetimeUsage;
  contributionCount: number;
  duplicateCount: number;
  attributionGaps: number;
  gapDetails: UsageAttributionGapDetails;
  continuation: UsageLedgerContinuation;
};

/** Alias emphasizing that a summary is the ledger's complete state. */
export type UsageLedger = UsageLedgerSummary;

export type UsageContributionResult = {
  ledger: UsageLedger;
  accepted: boolean;
  duplicate: boolean;
  attributionGap: boolean;
};

const DEFAULT_MAX_REMEMBERED_IDENTITIES = 512;
const DEFAULT_MAX_PROVIDER_MODEL_BUCKETS = 256;

function boundedOption(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(1, Math.floor(value));
}

function emptyGapDetails(): UsageAttributionGapDetails {
  return {
    unknownIdentity: 0,
    evictedIdentities: 0,
    unknownProviderOrModel: 0,
    unknownPricing: 0,
    partialPricing: 0,
    overflowBuckets: 0,
  };
}

function emptyLedger(options: UsageLedgerOptions = {}): UsageLedger {
  const maxRememberedIdentities = boundedOption(options.maxRememberedIdentities, DEFAULT_MAX_REMEMBERED_IDENTITIES);
  const maxProviderModelBuckets = boundedOption(options.maxProviderModelBuckets, DEFAULT_MAX_PROVIDER_MODEL_BUCKETS);
  return {
    version: USAGE_LEDGER_VERSION,
    maxRememberedIdentities,
    maxProviderModelBuckets,
    directTotals: [],
    contributionCount: 0,
    duplicateCount: 0,
    attributionGaps: 0,
    gapDetails: emptyGapDetails(),
    continuation: {
      version: USAGE_LEDGER_VERSION,
      maxRememberedIdentities,
      recentContributionIds: [],
      evictedIdentities: 0,
    },
  };
}

/** Create an empty versioned ledger with bounded continuation state. */
export function createUsageLedger(options: UsageLedgerOptions = {}): UsageLedger {
  return emptyLedger(options);
}

function normaliseIdentifier(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function contributionIdentity(contribution: UsageMessageContribution): UsageMessageIdentity {
  return {
    attemptId: contribution.attemptId ?? contribution.identity?.attemptId ?? null,
    messageId: contribution.messageId ?? contribution.identity?.messageId ?? null,
  };
}

function stableContributionId(identity: UsageMessageIdentity): string | undefined {
  if (!identity.attemptId || !identity.messageId) return undefined;
  // Length-prefixing avoids delimiter collisions while keeping the key
  // deterministic and independent of transcript contents.
  return `${identity.attemptId.length}:${identity.attemptId}${identity.messageId.length}:${identity.messageId}`;
}

function cloneGapDetails(details: UsageAttributionGapDetails): UsageAttributionGapDetails {
  return { ...details };
}

function cloneLedger(ledger: UsageLedger): UsageLedger {
  return {
    ...ledger,
    directTotals: ledger.directTotals.map(total => ({
      ...total,
      usage: copyUsage(total.usage),
    })),
    ...(ledger.overflowTotal ? { overflowTotal: copyUsage(ledger.overflowTotal) } : {}),
    gapDetails: cloneGapDetails(ledger.gapDetails),
    continuation: {
      ...ledger.continuation,
      recentContributionIds: [...ledger.continuation.recentContributionIds],
    },
  };
}

function sameProviderModel(a: UsageProviderModelTotal, provider: string | null, model: string | null): boolean {
  return a.provider === provider && a.model === model;
}

function mergeUsageCopy(target: LifetimeUsage, delta: LifetimeUsage): void {
  addUsage(target, delta);
  // Ledger entries always carry an explicit state, including unavailable.
  target.costStatus = mergeCostStatuses(
    target.costStatus ?? getUsageCostStatus(target),
    delta.costStatus ?? getUsageCostStatus(delta),
  );
  target.costProvenance = mergeCostProvenance(
    target.costProvenance ?? getUsageCostProvenance(target),
    delta.costProvenance ?? getUsageCostProvenance(delta),
    target.costStatus,
  );
}

function addToOverflow(ledger: UsageLedger, usage: LifetimeUsage): void {
  const overflow = ledger.overflowTotal ?? { input: 0, output: 0, cacheWrite: 0 };
  mergeUsageCopy(overflow, usage);
  ledger.overflowTotal = overflow;
}

function addDirectBucket(
  ledger: UsageLedger,
  provider: string | null,
  model: string | null,
  usage: LifetimeUsage,
): boolean {
  const existing = ledger.directTotals.find(total => sameProviderModel(total, provider, model));
  if (existing) {
    mergeUsageCopy(existing.usage, usage);
    existing.contributionCount += 1;
    return false;
  }
  if (ledger.directTotals.length >= ledger.maxProviderModelBuckets) {
    addToOverflow(ledger, usage);
    return true;
  }
  (ledger.directTotals as UsageProviderModelTotal[]).push({
    provider,
    model,
    usage: copyUsage(usage),
    contributionCount: 1,
  });
  return false;
}

function incrementGap(ledger: UsageLedger, key: keyof UsageAttributionGapDetails): void {
  ledger.gapDetails[key] += 1;
  ledger.attributionGaps += 1;
}

/**
 * Apply one message contribution without mutating the input ledger.  A known
 * attempt+message pair is counted once.  Unknown identities are accepted but
 * are explicitly recorded as attribution gaps, since they cannot be deduped.
 */
export function recordUsageContribution(
  ledger: UsageLedger,
  contribution: UsageMessageContribution,
): UsageContributionResult {
  const next = cloneLedger(ledger);
  const identity = contributionIdentity(contribution);
  const id = stableContributionId(identity);
  let attributionGap = false;

  if (id !== undefined && next.continuation.recentContributionIds.includes(id)) {
    next.duplicateCount += 1;
    return { ledger: next, accepted: false, duplicate: true, attributionGap: false };
  }

  if (id === undefined) {
    incrementGap(next, "unknownIdentity");
    attributionGap = true;
  } else {
    const recent = [...next.continuation.recentContributionIds, id];
    if (recent.length > next.maxRememberedIdentities) {
      recent.shift();
      next.continuation.evictedIdentities += 1;
      incrementGap(next, "evictedIdentities");
      attributionGap = true;
    }
    next.continuation.recentContributionIds = recent;
  }

  const provider = normaliseIdentifier(contribution.provider);
  const model = normaliseIdentifier(contribution.model);
  const usage = copyUsage(contribution.usage);
  usage.costStatus = usage.costStatus ?? getUsageCostStatus(usage);
  usage.costProvenance = usage.costProvenance ?? getUsageCostProvenance(usage);

  next.contributionCount += 1;
  if (provider === null || model === null) {
    incrementGap(next, "unknownProviderOrModel");
    attributionGap = true;
  }
  if (usage.costStatus === "unavailable") {
    incrementGap(next, "unknownPricing");
    attributionGap = true;
  } else if (usage.costStatus === "partial") {
    incrementGap(next, "partialPricing");
    attributionGap = true;
  }
  if (usage.costProvenance === "unknown" && usage.costStatus !== "unavailable") {
    incrementGap(next, "unknownPricing");
    attributionGap = true;
  }
  if (addDirectBucket(next, provider, model, usage)) {
    incrementGap(next, "overflowBuckets");
    attributionGap = true;
  }

  return { ledger: next, accepted: true, duplicate: false, attributionGap };
}

/** Pure state-only spelling for callers that do not need the acceptance flag. */
export function addUsageContribution(ledger: UsageLedger, contribution: UsageMessageContribution): UsageLedger {
  return recordUsageContribution(ledger, contribution).ledger;
}

/** Direct per-provider/model totals; descendant usage is intentionally absent. */
export function getDirectUsageTotals(ledger: UsageLedger): readonly UsageProviderModelTotal[] {
  return ledger.directTotals.map(total => ({ ...total, usage: copyUsage(total.usage) }));
}

export type UsageLedgerNode = {
  agentId?: string;
  id?: string;
  parentAgentId?: string | null;
  parentId?: string | null;
  ledger: UsageLedger;
};

function nodeId(node: UsageLedgerNode): string | undefined {
  return node.agentId ?? node.id;
}

function nodeParentId(node: UsageLedgerNode): string | null {
  return node.parentAgentId ?? node.parentId ?? null;
}

function mergeGapDetailsInto(target: UsageAttributionGapDetails, source: UsageAttributionGapDetails): void {
  for (const key of Object.keys(target) as (keyof UsageAttributionGapDetails)[]) target[key] += source[key];
}

function mergeLedgerSummaryInto(target: UsageLedger, source: UsageLedger): void {
  target.contributionCount += source.contributionCount;
  target.duplicateCount += source.duplicateCount;
  target.attributionGaps += source.attributionGaps;
  mergeGapDetailsInto(target.gapDetails, source.gapDetails);
  target.continuation.evictedIdentities += source.continuation.evictedIdentities;

  for (const total of source.directTotals) {
    const overflowed = addDirectBucket(target, total.provider, total.model, total.usage);
    if (overflowed) incrementGap(target, "overflowBuckets");
    // A bucket represents many contributions, not one contribution.
    const targetTotal = target.directTotals.find(candidate => sameProviderModel(candidate, total.provider, total.model));
    if (targetTotal && targetTotal !== total) targetTotal.contributionCount += total.contributionCount - 1;
  }
  if (source.overflowTotal) addToOverflow(target, source.overflowTotal);
}

/**
 * Aggregate direct totals from independent ledgers.  This helper does not
 * traverse a hierarchy and does not add descendants implicitly.
 */
export function aggregateDirectUsage(ledgers: readonly UsageLedger[]): UsageLedgerSummary {
  const first = ledgers[0];
  const result = emptyLedger(first ? {
    maxRememberedIdentities: first.maxRememberedIdentities,
    maxProviderModelBuckets: first.maxProviderModelBuckets,
  } : undefined);
  for (const ledger of ledgers) mergeLedgerSummaryInto(result, ledger);
  return result;
}

/** Alias useful when a caller only wants the direct bucket array. */
export function aggregateDirectUsageTotals(ledgers: readonly UsageLedger[]): readonly UsageProviderModelTotal[] {
  return aggregateDirectUsage(ledgers).directTotals;
}

/**
 * Aggregate a root's direct usage and all reachable descendant ledgers.  The
 * direct ledger and this inclusive view are separate values, so displaying a
 * parent never changes what its own direct total means.
 */
export function aggregateUsageIncludingDescendants(
  nodes: readonly UsageLedgerNode[],
  rootAgentId: string,
): UsageLedgerSummary {
  const byId = new Map<string, UsageLedgerNode>();
  for (const node of nodes) {
    const id = nodeId(node);
    if (id !== undefined) byId.set(id, node);
  }

  const root = byId.get(rootAgentId);
  if (!root) {
    const missing = emptyLedger();
    incrementGap(missing, "unknownIdentity");
    return missing;
  }

  const selected: UsageLedger[] = [];
  const queue = [rootAgentId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) continue;
    selected.push(node.ledger);
    for (const candidate of nodes) {
      const candidateId = nodeId(candidate);
      if (candidateId !== undefined && nodeParentId(candidate) === id) queue.push(candidateId);
    }
  }
  return aggregateDirectUsage(selected);
}

/** Descendant-inclusive bucket helper, kept separate from direct totals. */
export function getDescendantInclusiveUsageTotals(
  nodes: readonly UsageLedgerNode[],
  rootAgentId: string,
): readonly UsageProviderModelTotal[] {
  return aggregateUsageIncludingDescendants(nodes, rootAgentId).directTotals;
}

/** Descriptive alias for callers that prefer the longer aggregation name. */
export const aggregateDescendantInclusiveUsage = aggregateUsageIncludingDescendants;

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/** Session-scoped token count: input + output + cacheWrite. */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

/** Context-window utilization (0–100), or null when unavailable. */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}
