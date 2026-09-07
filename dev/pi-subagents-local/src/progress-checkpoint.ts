import { createHash } from "node:crypto";

/** The snapshot schema is intentionally small and can be bumped independently. */
export const PROGRESS_CHECKPOINT_SNAPSHOT_VERSION = 1 as const;
export const DEFAULT_DISPLAY_TOKEN_INTERVAL = 150_000;
export const DEFAULT_REPEATED_REPORT_THRESHOLD = 2;
export const MAX_PROGRESS_CHECKPOINT_STRING_LENGTH = 1_024;
export const MAX_PROGRESS_CHECKPOINT_FINGERPRINT_LENGTH = 256;
export const MAX_PROGRESS_CHECKPOINT_IDS = 128;

export type ProgressCheckpointLifecycle = "queued" | "alive" | "canceled" | "settled";

export interface ProgressCheckpointActivation {
  /** The caller explicitly opted the invocation into this policy. */
  readonly explicit?: boolean;
  /** Either this flag or owner=orchestrator must be true. */
  readonly orchestratorOwned?: boolean;
  readonly owner?: "orchestrator" | "native" | "other";
  /** Native goal execution is deliberately never activated by this policy. */
  readonly nativeGoal?: boolean;
  /** Permit the controller to be made alive by a later alive observation. */
  readonly queued?: boolean;
}

export interface ProgressCheckpointOverrideContext {
  readonly provider?: string;
  readonly model?: string;
  readonly activation: ProgressCheckpointActivation;
}

export interface ProgressCheckpointConfigOverride {
  readonly enabled?: boolean;
  readonly displayTokenInterval?: number;
  readonly elapsedIntervalMs?: number;
  /** Threshold for repeated reports, independent of tool fingerprint repetition. */
  readonly repeatedReportThreshold?: number;
  readonly repeatedFingerprintThreshold?: number;
}

/** Pure provider/model-specific settings lookup. */
export type ProgressCheckpointOverrideResolver = (
  context: ProgressCheckpointOverrideContext,
) => ProgressCheckpointConfigOverride | undefined;

export interface ProgressCheckpointConfig extends ProgressCheckpointConfigOverride {
  readonly provider?: string;
  readonly model?: string;
  readonly overrideResolver?: ProgressCheckpointOverrideResolver;
  readonly activation?: ProgressCheckpointActivation;
  /** Equivalent to activation.queued, useful when activation is assembled elsewhere. */
  readonly initialLifecycle?: "queued" | "alive";
  readonly queuedActivation?: boolean;
}

export interface EffectiveProgressCheckpointConfig {
  readonly enabled: boolean;
  readonly displayTokenInterval: number;
  readonly elapsedIntervalMs?: number;
  readonly repeatedReportThreshold: number;
  readonly repeatedFingerprintThreshold?: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface ProgressCheckpointObservation {
  /** Cumulative display tokens. Values are not treated as raw model output. */
  readonly displayTokens?: number;
  /** Cumulative elapsed milliseconds. */
  readonly elapsedMs?: number;
  /** Aliases accepted for runners that call the cumulative clock time/timeMs. */
  readonly timeMs?: number;
  readonly time?: number;
  readonly actionFingerprint?: string;
  readonly resultFingerprint?: string;
  readonly errorFingerprint?: string;
  /** Compaction bookkeeping; it does not establish progress or continuation baselines. */
  readonly compaction?: boolean | { readonly completed?: boolean };
  readonly safeBoundary?: boolean;
  readonly lifecycle?: "alive" | "canceled" | "settled";
}

export interface ProgressCheckpointReport {
  readonly checkpointId: string;
  readonly progress: string;
  readonly evidence: string;
  readonly blocker: string;
  readonly nextAction: string;
  readonly scopeExpansion?: string;
}

export interface ProgressCheckpointReportOptions {
  readonly safeBoundary?: boolean;
}

export type ProgressCheckpointRequestReason =
  | "display-token-interval"
  | "elapsed-interval"
  | "repeated-fingerprint"
  | "manual";

export type ProgressCheckpointAttentionReason =
  | "repeated-no-progress"
  | "blocker"
  | "scope-expansion";

export interface ProgressCheckpointRequestEffect {
  readonly type: "checkpoint-request";
  readonly checkpointId: string;
  readonly reason: ProgressCheckpointRequestReason;
}

export interface ProgressCheckpointAttentionEffect {
  readonly type: "parent-attention-request";
  readonly request: "handoff";
  readonly checkpointId: string;
  readonly reason: ProgressCheckpointAttentionReason;
  readonly report: ProgressCheckpointReport;
}

export type ProgressCheckpointEffect =
  | ProgressCheckpointRequestEffect
  | ProgressCheckpointAttentionEffect;

interface PendingCheckpoint {
  readonly checkpointId: string;
  readonly reason: ProgressCheckpointRequestReason;
  delivered: boolean;
}

interface SnapshotPendingCheckpoint {
  readonly checkpointId: string;
  readonly reason: ProgressCheckpointRequestReason;
  readonly delivered: boolean;
}

export interface ProgressCheckpointSnapshot {
  readonly version: typeof PROGRESS_CHECKPOINT_SNAPSHOT_VERSION;
  readonly lifecycle: ProgressCheckpointLifecycle;
  readonly displayTokens: number;
  readonly elapsedMs: number;
  readonly displayTokenBaseline: number;
  readonly elapsedBaseline: number;
  readonly lastFingerprint?: string;
  readonly fingerprintCount: number;
  readonly lastReportFingerprint?: string;
  readonly reportRepeatCount: number;
  readonly attentionIssued: boolean;
  readonly continuationEpoch: number;
  readonly nextCheckpointSequence: number;
  readonly pendingCheckpoint?: SnapshotPendingCheckpoint;
  readonly queuedEffects: readonly ProgressCheckpointEffect[];
  readonly handledCheckpointIds: readonly string[];
}

export interface ProgressCheckpointController {
  readonly config: EffectiveProgressCheckpointConfig;
  readonly lifecycle: ProgressCheckpointLifecycle;
  readonly isEnabled: boolean;
  observe(observation: ProgressCheckpointObservation): readonly ProgressCheckpointEffect[];
  report(
    report: ProgressCheckpointReport,
    options?: ProgressCheckpointReportOptions,
  ): readonly ProgressCheckpointEffect[];
  /** Mark an explicit runner-safe point and deliver queued effects there. */
  onSafeBoundary(): readonly ProgressCheckpointEffect[];
  /** Queue a request without steering work in flight. */
  requestCheckpoint(reason?: ProgressCheckpointRequestReason): readonly ProgressCheckpointEffect[];
  /** Activate a controller created with initialLifecycle=queued. */
  activate(): readonly ProgressCheckpointEffect[];
  /** Explicit parent reentry; retains cumulative metric baselines and clears attention. */
  continueFromParent(): readonly ProgressCheckpointEffect[];
  cancel(): void;
  settle(): void;
  snapshot(): ProgressCheckpointSnapshot;
  restore(snapshot: ProgressCheckpointSnapshot): void;
}

const MAX_QUEUED_EFFECTS = 8;

function boundedString(value: string | undefined, limit = MAX_PROGRESS_CHECKPOINT_STRING_LENGTH): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

function boundedFingerprint(value: string | undefined): string {
  return boundedString(value, MAX_PROGRESS_CHECKPOINT_FINGERPRINT_LENGTH);
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

function optionalPositiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number`);
  return value;
}

function optionalThreshold(value: number | undefined, name = "threshold"): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 1) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.ceil(value);
}

function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function observationFingerprint(observation: ProgressCheckpointObservation): string | undefined {
  const action = boundedFingerprint(observation.actionFingerprint);
  const result = boundedFingerprint(observation.resultFingerprint);
  const error = boundedFingerprint(observation.errorFingerprint);
  if (!action && !result && !error) return undefined;
  // Only the digest is retained, so a result body accidentally supplied as a
  // fingerprint cannot become durable controller state.
  return hash(JSON.stringify([action, result, error]));
}

function reportEvidenceFingerprint(report: ProgressCheckpointReport): string | undefined {
  const evidence = boundedString(report.evidence);
  // Progress narration, nextAction, blockers, and scope wording are not proof
  // of new work. Only nonempty changed evidence starts a productive epoch.
  return evidence ? hash(evidence) : undefined;
}

function cloneReport(report: ProgressCheckpointReport): ProgressCheckpointReport {
  const scopeExpansion = boundedString(report.scopeExpansion);
  return {
    checkpointId: boundedString(report.checkpointId, 128),
    progress: boundedString(report.progress),
    evidence: boundedString(report.evidence),
    blocker: boundedString(report.blocker),
    nextAction: boundedString(report.nextAction),
    ...(scopeExpansion ? { scopeExpansion } : {}),
  };
}

function activationAllowsPolicy(activation: ProgressCheckpointActivation | undefined): boolean {
  if (activation?.explicit !== true || activation.nativeGoal === true) return false;
  return activation.orchestratorOwned === true || activation.owner === "orchestrator";
}

function freezeEffect(effect: ProgressCheckpointEffect): ProgressCheckpointEffect {
  return Object.freeze(effect);
}

function freezeEffects(effects: readonly ProgressCheckpointEffect[]): readonly ProgressCheckpointEffect[] {
  return Object.freeze(effects.slice());
}

/**
 * Create a pure, bounded progress checkpoint controller.
 *
 * The policy only emits requests. It never aborts, respawns, escalates, or
 * steers an in-flight agent. Effects are held until an explicit safe boundary.
 */
export function createProgressCheckpointController(
  input: ProgressCheckpointConfig = {},
  restoredSnapshot?: ProgressCheckpointSnapshot,
): ProgressCheckpointController {
  const activation = input.activation ?? {};
  const override = input.overrideResolver?.({
    provider: input.provider,
    model: input.model,
    activation,
  });
  const settings: ProgressCheckpointConfigOverride = { ...input, ...override };
  const eligible = activationAllowsPolicy(activation);
  const enabled = eligible && settings.enabled !== false;
  const config: EffectiveProgressCheckpointConfig = Object.freeze({
    enabled,
    displayTokenInterval: positiveNumber(
      settings.displayTokenInterval,
      DEFAULT_DISPLAY_TOKEN_INTERVAL,
      "displayTokenInterval",
    ),
    elapsedIntervalMs: optionalPositiveNumber(settings.elapsedIntervalMs, "elapsedIntervalMs"),
    repeatedReportThreshold: optionalThreshold(settings.repeatedReportThreshold, "repeatedReportThreshold")
      ?? DEFAULT_REPEATED_REPORT_THRESHOLD,
    repeatedFingerprintThreshold: optionalThreshold(
      settings.repeatedFingerprintThreshold,
      "repeatedFingerprintThreshold",
    ),
    provider: input.provider,
    model: input.model,
  });

  let lifecycle: ProgressCheckpointLifecycle = !enabled
    ? "settled"
    : input.initialLifecycle === "queued" || input.queuedActivation === true || activation.queued === true
      ? "queued"
      : "alive";
  let safeBoundary = false;
  let displayTokens = 0;
  let elapsedMs = 0;
  let displayTokenBaseline = 0;
  let elapsedBaseline = 0;
  let lastFingerprint: string | undefined;
  let fingerprintCount = 0;
  let lastReportFingerprint: string | undefined;
  let reportRepeatCount = 0;
  let attentionIssued = false;
  let continuationEpoch = 1;
  let nextCheckpointSequence = 1;
  let pendingCheckpoint: PendingCheckpoint | undefined;
  let queuedEffects: ProgressCheckpointEffect[] = [];
  let handledCheckpointIds: string[] = [];

  const canRun = (): boolean => lifecycle === "alive" && enabled;

  const queueEffect = (effect: ProgressCheckpointEffect): void => {
    if (!canRun() || queuedEffects.length >= MAX_QUEUED_EFFECTS) return;
    if (queuedEffects.some((existing) => (
      existing.type === effect.type && existing.checkpointId === effect.checkpointId
    ))) return;
    queuedEffects.push(freezeEffect(effect));
  };

  const drain = (): readonly ProgressCheckpointEffect[] => {
    if (!safeBoundary || !canRun() || queuedEffects.length === 0) {
      return Object.freeze([]);
    }
    const delivered = queuedEffects;
    queuedEffects = [];
    for (const effect of delivered) {
      if (effect.type === "checkpoint-request" && pendingCheckpoint?.checkpointId === effect.checkpointId) {
        pendingCheckpoint.delivered = true;
      }
    }
    safeBoundary = false;
    return freezeEffects(delivered);
  };

  const newCheckpointId = (): string => `progress-checkpoint-${nextCheckpointSequence++}`;

  const queueCheckpoint = (reason: ProgressCheckpointRequestReason): void => {
    if (!canRun() || pendingCheckpoint) return;
    const checkpointId = newCheckpointId();
    pendingCheckpoint = { checkpointId, reason, delivered: false };
    queueEffect({ type: "checkpoint-request", checkpointId, reason });
  };

  const removePendingEffect = (checkpointId: string): void => {
    queuedEffects = queuedEffects.filter((effect) => effect.checkpointId !== checkpointId);
  };

  const rememberHandled = (checkpointId: string): void => {
    handledCheckpointIds = handledCheckpointIds.filter((id) => id !== checkpointId);
    handledCheckpointIds.push(checkpointId);
    if (handledCheckpointIds.length > MAX_PROGRESS_CHECKPOINT_IDS) handledCheckpointIds.shift();
  };

  const resetFingerprintBaseline = (): void => {
    lastFingerprint = undefined;
    fingerprintCount = 0;
  };

  const continueFromParent = (): readonly ProgressCheckpointEffect[] => {
    if (!canRun()) return Object.freeze([]);
    continuationEpoch += 1;
    attentionIssued = false;
    lastReportFingerprint = undefined;
    reportRepeatCount = 0;
    resetFingerprintBaseline();
    queuedEffects = queuedEffects.filter((effect) => effect.type !== "parent-attention-request");
    return drain();
  };

  const updateMetrics = (observation: ProgressCheckpointObservation): void => {
    if (observation.displayTokens !== undefined && Number.isFinite(observation.displayTokens)) {
      const next = Math.max(0, observation.displayTokens);
      // displayTokens and elapsedMs are lifetime cumulative metrics. Compaction
      // never moves their baselines or makes an old checkpoint disappear.
      displayTokens = Math.max(displayTokens, next);
    }
    const suppliedElapsed = observation.elapsedMs ?? observation.timeMs ?? observation.time;
    if (suppliedElapsed !== undefined && Number.isFinite(suppliedElapsed)) {
      elapsedMs = Math.max(elapsedMs, Math.max(0, suppliedElapsed));
    }
  };

  const isCompactionComplete = (compaction: ProgressCheckpointObservation["compaction"]): boolean => (
    compaction === true || (typeof compaction === "object" && compaction?.completed !== false)
  );

  const triggerFromObservation = (
    observation: ProgressCheckpointObservation,
    includeFingerprint = true,
  ): void => {
    if (!canRun() || pendingCheckpoint) return;
    if (config.displayTokenInterval > 0 && displayTokens - displayTokenBaseline >= config.displayTokenInterval) {
      queueCheckpoint("display-token-interval");
      return;
    }
    if (config.elapsedIntervalMs !== undefined && elapsedMs - elapsedBaseline >= config.elapsedIntervalMs) {
      queueCheckpoint("elapsed-interval");
      return;
    }
    if (!includeFingerprint) return;

    if (config.repeatedFingerprintThreshold !== undefined) {
      const fingerprint = observationFingerprint(observation);
      if (fingerprint === undefined) {
        resetFingerprintBaseline();
      } else if (fingerprint === lastFingerprint) {
        fingerprintCount += 1;
        if (fingerprintCount >= config.repeatedFingerprintThreshold) queueCheckpoint("repeated-fingerprint");
      } else {
        lastFingerprint = fingerprint;
        fingerprintCount = 1;
      }
    }
  };

  const activate = (): readonly ProgressCheckpointEffect[] => {
    if (lifecycle !== "queued") return Object.freeze([]);
    lifecycle = "alive";
    displayTokenBaseline = displayTokens;
    elapsedBaseline = elapsedMs;
    resetFingerprintBaseline();
    return Object.freeze([]);
  };

  const report = (
    inputReport: ProgressCheckpointReport,
    options: ProgressCheckpointReportOptions = {},
  ): readonly ProgressCheckpointEffect[] => {
    if (!canRun()) return Object.freeze([]);
    if (options.safeBoundary === true) safeBoundary = true;
    const nextReport = cloneReport(inputReport);
    const checkpointId = nextReport.checkpointId;
    if (!checkpointId || handledCheckpointIds.includes(checkpointId)) return drain();
    if (!pendingCheckpoint || pendingCheckpoint.checkpointId !== checkpointId) return drain();

    pendingCheckpoint = undefined;
    removePendingEffect(checkpointId);
    rememberHandled(checkpointId);
    displayTokenBaseline = displayTokens;
    elapsedBaseline = elapsedMs;
    resetFingerprintBaseline();

    const fingerprint = reportEvidenceFingerprint(nextReport);
    const isNewEvidence = fingerprint !== undefined && fingerprint !== lastReportFingerprint;
    if (isNewEvidence) {
      lastReportFingerprint = fingerprint;
      reportRepeatCount = 1;
    } else {
      reportRepeatCount += 1;
    }

    const blocker = nextReport.blocker.length > 0;
    const scopeExpansion = Boolean(nextReport.scopeExpansion);
    const repeatedNoProgress = !isNewEvidence
      && reportRepeatCount >= config.repeatedReportThreshold;
    const reason: ProgressCheckpointAttentionReason | undefined = blocker
      ? "blocker"
      : scopeExpansion
        ? "scope-expansion"
        : repeatedNoProgress
          ? "repeated-no-progress"
          : undefined;
    if (reason && !attentionIssued) {
      attentionIssued = true;
      queueEffect({
        type: "parent-attention-request",
        request: "handoff",
        checkpointId,
        reason,
        report: nextReport,
      });
    }
    return drain();
  };

  const observe = (observation: ProgressCheckpointObservation): readonly ProgressCheckpointEffect[] => {
    if (observation.safeBoundary === true) safeBoundary = true;
    else if (observation.safeBoundary === false) safeBoundary = false;

    if (observation.lifecycle === "canceled" || observation.lifecycle === "settled") {
      lifecycle = observation.lifecycle;
      queuedEffects = [];
      pendingCheckpoint = undefined;
      return Object.freeze([]);
    }
    const wasQueued = lifecycle === "queued";
    if (observation.lifecycle === "alive" && wasQueued) lifecycle = "alive";
    if (!canRun()) return drain();

    const compaction = isCompactionComplete(observation.compaction);
    updateMetrics(observation);
    if (wasQueued) {
      // Observations collected before explicit activation become the new baseline.
      displayTokenBaseline = displayTokens;
      elapsedBaseline = elapsedMs;
      resetFingerprintBaseline();
      return drain();
    }
    // Compaction is bookkeeping, not evidence or an explicit parent
    // continuation. It may still expose a due lifetime interval, but it does
    // not reset report/fingerprint state or the attention latch.
    triggerFromObservation(observation, !compaction);
    return drain();
  };

  const requestCheckpoint = (reason: ProgressCheckpointRequestReason = "manual") => {
    if (!canRun()) return Object.freeze([]);
    queueCheckpoint(reason);
    return drain();
  };

  const onSafeBoundary = (): readonly ProgressCheckpointEffect[] => {
    safeBoundary = true;
    return drain();
  };

  const cancel = (): void => {
    lifecycle = "canceled";
    queuedEffects = [];
    pendingCheckpoint = undefined;
  };

  const settle = (): void => {
    lifecycle = "settled";
    queuedEffects = [];
    pendingCheckpoint = undefined;
  };

  const snapshot = (): ProgressCheckpointSnapshot => {
    const pending: SnapshotPendingCheckpoint | undefined = pendingCheckpoint && {
      checkpointId: pendingCheckpoint.checkpointId,
      reason: pendingCheckpoint.reason,
      delivered: pendingCheckpoint.delivered,
    };
    return Object.freeze({
      version: PROGRESS_CHECKPOINT_SNAPSHOT_VERSION,
      lifecycle,
      displayTokens,
      elapsedMs,
      displayTokenBaseline,
      elapsedBaseline,
      ...(lastFingerprint ? { lastFingerprint } : {}),
      fingerprintCount,
      ...(lastReportFingerprint ? { lastReportFingerprint } : {}),
      reportRepeatCount,
      attentionIssued,
      continuationEpoch,
      nextCheckpointSequence,
      ...(pending ? { pendingCheckpoint: pending } : {}),
      queuedEffects: freezeEffects(queuedEffects),
      handledCheckpointIds: Object.freeze(handledCheckpointIds.slice()),
    });
  };

  const restore = (saved: ProgressCheckpointSnapshot): void => {
    if (saved.version !== PROGRESS_CHECKPOINT_SNAPSHOT_VERSION) {
      throw new RangeError(`Unsupported progress checkpoint snapshot version: ${saved.version}`);
    }
    if (!Number.isFinite(saved.nextCheckpointSequence) || saved.nextCheckpointSequence < 1) {
      throw new RangeError("Invalid progress checkpoint snapshot sequence");
    }
    lifecycle = enabled ? saved.lifecycle : "settled";
    displayTokens = nonNegative(saved.displayTokens, 0);
    elapsedMs = nonNegative(saved.elapsedMs, 0);
    displayTokenBaseline = nonNegative(saved.displayTokenBaseline, displayTokens);
    elapsedBaseline = nonNegative(saved.elapsedBaseline, elapsedMs);
    lastFingerprint = saved.lastFingerprint ? boundedFingerprint(saved.lastFingerprint) : undefined;
    fingerprintCount = Math.max(0, Math.floor(saved.fingerprintCount || 0));
    lastReportFingerprint = saved.lastReportFingerprint ? boundedFingerprint(saved.lastReportFingerprint) : undefined;
    reportRepeatCount = Math.max(0, Math.floor(saved.reportRepeatCount || 0));
    attentionIssued = saved.attentionIssued === true;
    continuationEpoch = Math.max(1, Math.floor(saved.continuationEpoch || 1));
    nextCheckpointSequence = Math.floor(saved.nextCheckpointSequence);
    pendingCheckpoint = saved.pendingCheckpoint && {
      checkpointId: boundedString(saved.pendingCheckpoint.checkpointId, 128),
      reason: saved.pendingCheckpoint.reason,
      delivered: saved.pendingCheckpoint.delivered === true,
    };
    queuedEffects = saved.queuedEffects.slice(0, MAX_QUEUED_EFFECTS).map((effect) => {
      if (effect.type === "checkpoint-request") {
        return freezeEffect({
          type: effect.type,
          checkpointId: boundedString(effect.checkpointId, 128),
          reason: effect.reason,
        });
      }
      return freezeEffect({
        type: effect.type,
        request: "handoff",
        checkpointId: boundedString(effect.checkpointId, 128),
        reason: effect.reason,
        report: cloneReport(effect.report),
      });
    });
    handledCheckpointIds = saved.handledCheckpointIds
      .slice(0, MAX_PROGRESS_CHECKPOINT_IDS)
      .map((id) => boundedString(id, 128))
      .filter(Boolean);
    // Restores never deliver effects in the middle of work. A runner must mark
    // its next safe boundary explicitly.
    safeBoundary = false;
  };

  const controller: ProgressCheckpointController = {
    config,
    get lifecycle() {
      return lifecycle;
    },
    get isEnabled() {
      return enabled;
    },
    observe,
    report,
    onSafeBoundary,
    requestCheckpoint,
    activate,
    continueFromParent,
    cancel,
    settle,
    snapshot,
    restore,
  };

  if (restoredSnapshot) restore(restoredSnapshot);
  return controller;
}

/** Policy terminology alias retained for callers that name the factory after the feature. */
export const createProgressCheckpointPolicy = createProgressCheckpointController;
