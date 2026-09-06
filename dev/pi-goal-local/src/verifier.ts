import { createHash } from "node:crypto";
import type { GoalVerifierVerdict, GoalLoopStrategy } from "./types.js";

const MAX_REASON_LENGTH = 4000;
const MAX_DIAGNOSTIC_LENGTH = 500;
const MAX_DIAGNOSTIC_KEYS = 8;
const MAX_RETRY_SUFFIX_LENGTH = 4096;
const SAFE_FINGERPRINT = /^[A-Za-z0-9._:-]{1,256}$/u;
const MAX_EVIDENCE_ITEMS = 32;
const MAX_EVIDENCE_LENGTH = 2000;
const MAX_FINGERPRINT_LENGTH = 256;
const MAX_CORRECTION_LENGTH = 128 * 1024;

const V2_ALLOWED_KEYS = [
  "outcome", "reason", "evidence", "repositoryFingerprint", "evidenceFingerprint",
  "correction", "correctionPlan", "strategy", "prewalk", "snapshot",
] as const;
const V2_ALLOWED_KEY_SET = new Set<string>(V2_ALLOWED_KEYS);
const DIAGNOSTIC_TOP_LEVEL_KEYS = new Set<string>(["ok", ...V2_ALLOWED_KEYS]);

/** The fixed-point protocol used by a version-2 goal loop. */
export type GoalLoopVerifierOutcome = "pass" | "replan" | "blocked" | "inconclusive";

export interface GoalLoopVerifierSnapshot {
  /** Fingerprint of the repository state inspected by GoalVerifier. */
  repositoryFingerprint?: string;
  /** Fingerprint of the evidence supplied by the controller. */
  evidenceFingerprint?: string;
  /** The immutable original-plan snapshot hash. */
  originalPlanHash?: string;
  /** The immutable corrective-plan snapshot hash, when one is active. */
  correctionHash?: string;
}

export interface GoalLoopVerifierVerdict {
  outcome: GoalLoopVerifierOutcome;
  reason: string;
  evidence?: string[];
  repositoryFingerprint?: string;
  evidenceFingerprint?: string;
  correction?: string;
  strategy?: GoalLoopStrategy;
  prewalk?: { required: true };
  snapshot?: GoalLoopVerifierSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type GoalVerifierOutputDiagnosticCategory =
  | "no-object"
  | "invalid-json"
  | "legacy-v1-shape"
  | "invalid-v2-schema";

/** Structural, source-authored validation codes; raw field names and values are never retained. */
export const GOAL_VERIFIER_VALIDATION_ERRORS = Object.freeze([
  "invalid-outcome",
  "invalid-reason",
  "invalid-evidence",
  "invalid-fingerprint",
  "invalid-correction",
  "correction-not-allowed",
  "invalid-strategy",
  "invalid-prewalk",
  "invalid-snapshot",
  "unknown-fields",
] as const);
export type GoalVerifierValidationError = typeof GOAL_VERIFIER_VALIDATION_ERRORS[number];
const GOAL_VERIFIER_VALIDATION_ERROR_SET = new Set<string>(GOAL_VERIFIER_VALIDATION_ERRORS);

export interface GoalVerifierOutputDiagnostic {
  category: GoalVerifierOutputDiagnosticCategory;
  charLength: number;
  byteLength: number;
  /** SHA-256 of the complete ephemeral output; the output itself is never retained. */
  sha256: string;
  /** Alias for callers that refer to the SHA-256 as a fingerprint. */
  fingerprint: string;
  bracesFound: boolean;
  jsonObjectFound: boolean;
  /** Only recognized schema keys are retained; unknown/offending names are discarded. */
  topLevelKeys: string[];
  /** Structural schema errors from a finite source-authored allowlist. */
  validationErrors: GoalVerifierValidationError[];
  /** A bounded, sanitized rendering suitable for a persisted reason or prompt. */
  summary: string;
}

const DIAGNOSTIC_CATEGORIES = [
  "no-object", "invalid-json", "legacy-v1-shape", "invalid-v2-schema",
] as const;

function sanitizeDiagnosticCategory(value: unknown): GoalVerifierOutputDiagnosticCategory {
  return typeof value === "string" && (DIAGNOSTIC_CATEGORIES as readonly string[]).includes(value)
    ? value as GoalVerifierOutputDiagnosticCategory
    : "invalid-v2-schema";
}

function sanitizeValidationErrors(value: unknown): GoalVerifierValidationError[] {
  if (!Array.isArray(value)) return [];
  return GOAL_VERIFIER_VALIDATION_ERRORS.filter(code => value.includes(code));
}

function sanitizeDiagnosticKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((key): key is string => typeof key === "string" && DIAGNOSTIC_TOP_LEVEL_KEYS.has(key))
    .filter((key, index, keys) => keys.indexOf(key) === index)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, MAX_DIAGNOSTIC_KEYS);
}

type DiagnosticSummaryInput = Pick<GoalVerifierOutputDiagnostic, "category" | "charLength" | "byteLength" | "sha256" | "bracesFound" | "jsonObjectFound" | "topLevelKeys">
  & { validationErrors?: unknown };

function diagnosticSummary(diagnostic: DiagnosticSummaryInput): string {
  const category = sanitizeDiagnosticCategory(diagnostic.category);
  const charLength = Number.isSafeInteger(diagnostic.charLength) && diagnostic.charLength >= 0
    ? diagnostic.charLength
    : 0;
  const byteLength = Number.isSafeInteger(diagnostic.byteLength) && diagnostic.byteLength >= 0
    ? diagnostic.byteLength
    : 0;
  const sha256 = typeof diagnostic.sha256 === "string" && /^[a-f0-9]{64}$/u.test(diagnostic.sha256)
    ? diagnostic.sha256
    : "invalid";
  const validationErrors = sanitizeValidationErrors(diagnostic.validationErrors);
  const keys = sanitizeDiagnosticKeys(diagnostic.topLevelKeys).join(",") || "none";
  const summary = [
    `validationErrors=${validationErrors.length ? validationErrors.join(",") : "none"}`,
    `category=${category}`,
    `chars=${charLength}`,
    `bytes=${byteLength}`,
    `sha256=${sha256}`,
    `braces=${diagnostic.bracesFound === true ? "yes" : "no"}`,
    `jsonObject=${diagnostic.jsonObjectFound === true ? "yes" : "no"}`,
    `keys=${keys}`,
  ].join("; ");
  return summary.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

/**
 * Return only bounded structural metadata for an ephemeral GoalVerifier
 * response. This deliberately does not retain or excerpt the response.
 */
export function diagnoseVerifierOutput(raw: string): GoalVerifierOutputDiagnostic {
  const charLength = raw.length;
  const byteLength = Buffer.byteLength(raw, "utf8");
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const bracesFound = start >= 0 || end >= 0;
  let parsed: unknown;
  let jsonObjectFound = false;
  let category: GoalVerifierOutputDiagnosticCategory;

  if (start < 0 || end <= start) {
    category = "no-object";
  } else {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
      const object = isRecord(parsed) ? parsed : undefined;
      jsonObjectFound = object !== undefined;
      if (!object) category = "invalid-json";
      else if (Object.hasOwn(object, "outcome")) category = "invalid-v2-schema";
      else if (Object.hasOwn(object, "ok")) category = "legacy-v1-shape";
      else category = "invalid-v2-schema";
    } catch {
      category = "invalid-json";
    }
  }

  const object = jsonObjectFound && isRecord(parsed) ? parsed : undefined;
  const topLevelKeys = object
    ? Object.keys(object)
      .filter(key => DIAGNOSTIC_TOP_LEVEL_KEYS.has(key))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .slice(0, MAX_DIAGNOSTIC_KEYS)
    : [];
  const validationErrors = object && !Object.hasOwn(object, "ok")
    ? validateV2Shape(object)
    : [];
  const diagnostic = {
    category,
    charLength,
    byteLength,
    sha256,
    fingerprint: sha256,
    bracesFound,
    jsonObjectFound,
    topLevelKeys,
    validationErrors,
  } satisfies Omit<GoalVerifierOutputDiagnostic, "summary">;
  return { ...diagnostic, summary: diagnosticSummary(diagnostic) };
}

/** Alias matching the V2-specific helper naming used by integrations. */
export const diagnoseGoalVerifierOutput = diagnoseVerifierOutput;

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000\r\n]/u.test(text)) return undefined;
  return text;
}

function boundedMultilineText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length > max || value.includes("\u0000")) return undefined;
  return value.trim() ? value : undefined;
}

function evidence(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ITEMS) return undefined;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const text = item.trim();
    if (!text || text.length > MAX_EVIDENCE_LENGTH || /[\u0000\r\n]/u.test(text)) return undefined;
    result.push(text);
  }
  return result;
}

function strategy(value: unknown): GoalLoopStrategy | undefined {
  return value === "YOLO" || value === "ORCHESTRATOR" || value === "PREWALK" ? value : undefined;
}

function outcome(value: unknown): value is GoalLoopVerifierOutcome {
  return value === "pass" || value === "replan" || value === "blocked" || value === "inconclusive";
}

function snapshot(value: unknown): GoalLoopVerifierSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["repositoryFingerprint", "evidenceFingerprint", "originalPlanHash", "correctionHash"]);
  if (Object.keys(value).some(key => !allowed.has(key))) return undefined;
  const repositoryFingerprint = value.repositoryFingerprint === undefined
    ? undefined
    : boundedText(value.repositoryFingerprint, MAX_FINGERPRINT_LENGTH);
  const evidenceFingerprint = value.evidenceFingerprint === undefined
    ? undefined
    : boundedText(value.evidenceFingerprint, MAX_FINGERPRINT_LENGTH);
  const originalPlanHash = value.originalPlanHash === undefined
    ? undefined
    : boundedText(value.originalPlanHash, MAX_FINGERPRINT_LENGTH);
  const correctionHash = value.correctionHash === undefined
    ? undefined
    : boundedText(value.correctionHash, MAX_FINGERPRINT_LENGTH);
  if ((value.repositoryFingerprint !== undefined && !repositoryFingerprint)
    || (value.evidenceFingerprint !== undefined && !evidenceFingerprint)
    || (value.originalPlanHash !== undefined && !originalPlanHash)
    || (value.correctionHash !== undefined && !correctionHash)) return undefined;
  return { repositoryFingerprint, evidenceFingerprint, originalPlanHash, correctionHash };
}

function validateV2Shape(value: Record<string, unknown>): GoalVerifierValidationError[] {
  const errors = new Set<GoalVerifierValidationError>();
  const add = (error: GoalVerifierValidationError): void => {
    if (GOAL_VERIFIER_VALIDATION_ERROR_SET.has(error)) errors.add(error);
  };

  if (Object.keys(value).some(key => !V2_ALLOWED_KEY_SET.has(key))) add("unknown-fields");
  if (!outcome(value.outcome)) add("invalid-outcome");
  if (!boundedText(value.reason, MAX_REASON_LENGTH)) add("invalid-reason");
  if (value.evidence !== undefined && !evidence(value.evidence)) add("invalid-evidence");

  const parsedSnapshot = value.snapshot === undefined ? undefined : snapshot(value.snapshot);
  if (value.snapshot !== undefined && !parsedSnapshot) add("invalid-snapshot");
  if (value.snapshot !== undefined && isRecord(value.snapshot)) {
    for (const key of ["repositoryFingerprint", "evidenceFingerprint", "originalPlanHash", "correctionHash"] as const) {
      if (value.snapshot[key] !== undefined && !boundedText(value.snapshot[key], MAX_FINGERPRINT_LENGTH)) {
        add("invalid-fingerprint");
      }
    }
  }
  if (value.repositoryFingerprint !== undefined
    && !boundedText(value.repositoryFingerprint, MAX_FINGERPRINT_LENGTH)) add("invalid-fingerprint");
  if (value.evidenceFingerprint !== undefined
    && !boundedText(value.evidenceFingerprint, MAX_FINGERPRINT_LENGTH)) add("invalid-fingerprint");

  const correctionValue = value.correction ?? value.correctionPlan;
  const correctionContent = isRecord(correctionValue) ? correctionValue.content : correctionValue;
  const correction = correctionValue === undefined
    ? undefined
    : boundedMultilineText(correctionContent, MAX_CORRECTION_LENGTH);
  if (correctionValue !== undefined && !correction) add("invalid-correction");
  else if (correction !== undefined && value.outcome !== "replan") add("correction-not-allowed");

  if (value.strategy !== undefined && !strategy(value.strategy)) add("invalid-strategy");
  if (value.prewalk !== undefined) {
    const parsedPrewalk = isRecord(value.prewalk) && value.prewalk.required === true
      && Object.keys(value.prewalk).every(key => key === "required")
      ? { required: true as const }
      : undefined;
    if (!parsedPrewalk) add("invalid-prewalk");
  }

  return GOAL_VERIFIER_VALIDATION_ERRORS.filter(error => errors.has(error));
}

/**
 * Parse the legacy `{ok, reason}` verifier response and the strict fixed-point
 * `{outcome, reason}` response. Legacy responses intentionally retain their
 * old shape so V1 goals do not acquire loop semantics accidentally.
 */
export function parseVerifierVerdict(raw: string): GoalVerifierVerdict | GoalLoopVerifierVerdict | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;

  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
    if (!isRecord(parsed)) return undefined;
    value = parsed;
  } catch {
    return undefined;
  }

  // Do not infer a loop outcome from a legacy boolean response. This is what
  // preserves the GoalJudge -> independent GoalVerifier V1 contract.
  if (value.outcome === undefined) {
    if (typeof value.ok !== "boolean") return undefined;
    if (typeof value.reason !== "string" || !value.reason.trim()) return undefined;
    const parsedEvidence = Array.isArray(value.evidence)
      ? value.evidence.filter((v): v is string => typeof v === "string").map(v => v.trim()).filter(Boolean).slice(0, MAX_EVIDENCE_ITEMS)
      : undefined;
    const baseReason = value.reason.trim();
    const failureReason = value.ok || !parsedEvidence?.length
      ? baseReason
      : `${baseReason}\nEvidence: ${parsedEvidence.join(" | ")}`;
    return { ok: value.ok, reason: failureReason.slice(0, MAX_REASON_LENGTH), evidence: parsedEvidence };
  }

  if (validateV2Shape(value).length) return undefined;
  if (!outcome(value.outcome)) return undefined;
  const reason = boundedText(value.reason, MAX_REASON_LENGTH);
  if (!reason) return undefined;
  const parsedEvidence = value.evidence === undefined ? undefined : evidence(value.evidence);
  if (value.evidence !== undefined && !parsedEvidence) return undefined;
  const parsedSnapshot = value.snapshot === undefined ? undefined : snapshot(value.snapshot);
  if (value.snapshot !== undefined && !parsedSnapshot) return undefined;
  const repositoryFingerprint = value.repositoryFingerprint === undefined
    ? parsedSnapshot?.repositoryFingerprint
    : boundedText(value.repositoryFingerprint, MAX_FINGERPRINT_LENGTH);
  const evidenceFingerprint = value.evidenceFingerprint === undefined
    ? parsedSnapshot?.evidenceFingerprint
    : boundedText(value.evidenceFingerprint, MAX_FINGERPRINT_LENGTH);
  if ((value.repositoryFingerprint !== undefined && !repositoryFingerprint)
    || (value.evidenceFingerprint !== undefined && !evidenceFingerprint)) return undefined;

  const correctionValue = value.correction ?? value.correctionPlan;
  const correctionContent = isRecord(correctionValue) ? correctionValue.content : correctionValue;
  const correction = correctionValue === undefined ? undefined : boundedMultilineText(correctionContent, MAX_CORRECTION_LENGTH);
  if (correctionValue !== undefined && !correction) return undefined;
  if (value.outcome !== "replan" && correction !== undefined) return undefined;
  const parsedStrategy = value.strategy === undefined ? undefined : strategy(value.strategy);
  if (value.strategy !== undefined && !parsedStrategy) return undefined;
  const parsedPrewalk = value.prewalk === undefined
    ? undefined
    : isRecord(value.prewalk) && value.prewalk.required === true
      && Object.keys(value.prewalk).every(key => key === "required")
      ? { required: true as const }
      : undefined;
  if (value.prewalk !== undefined && !parsedPrewalk) return undefined;

  const result: GoalLoopVerifierVerdict = {
    outcome: value.outcome,
    reason,
    evidence: parsedEvidence,
  };
  if (repositoryFingerprint) result.repositoryFingerprint = repositoryFingerprint;
  if (evidenceFingerprint) result.evidenceFingerprint = evidenceFingerprint;
  if (correction) result.correction = correction;
  if (parsedStrategy) result.strategy = parsedStrategy;
  if (parsedPrewalk) result.prewalk = parsedPrewalk;
  if (parsedSnapshot) result.snapshot = parsedSnapshot;
  return result;
}

export interface VerifierPlanDetail {
  path: string;
  hash: string;
  content: string;
}

export interface VerifierPromptInput {
  objective: string;
  criteria: string[];
  judgeReason: string;
  judgeEvidence?: string[];
  /** V2 fixed-point mode. Omit for the legacy V1 verifier prompt. */
  loop?: {
    loopId: string;
    generation: number;
    contextEpoch: number;
    cycle: number;
    strategy?: GoalLoopStrategy;
    originalPlan: VerifierPlanDetail;
    correction?: VerifierPlanDetail;
    evidenceFingerprint: string;
    /** A prior repository fingerprint is a comparison hint, not acceptance evidence. */
    previousRepositoryFingerprint?: string;
  };
  /** Top-level aliases keep the prompt builder convenient for integrations. */
  mode?: "v1" | "loop";
  loopId?: string;
  generation?: number;
  contextEpoch?: number;
  cycle?: number;
  strategy?: GoalLoopStrategy;
  originalPlan?: VerifierPlanDetail;
  originalPlanSnapshot?: VerifierPlanDetail;
  correction?: VerifierPlanDetail;
  correctionPlan?: VerifierPlanDetail;
  snapshot?: GoalLoopVerifierSnapshot;
  evidenceFingerprint?: string;
  previousRepositoryFingerprint?: string;
}

const V2_SCHEMA_GUIDANCE = [
  "Fixed-point V2 JSON schema and bounds (apply exactly):",
  "Return exactly one JSON object with this schema: {\"outcome\":\"pass\"|\"replan\"|\"blocked\"|\"inconclusive\",\"reason\":string,\"evidence\"?:string[],\"repositoryFingerprint\":string,\"evidenceFingerprint\":string,\"correction\"?:string,\"strategy\"?:\"YOLO\"|\"ORCHESTRATOR\"|\"PREWALK\",\"prewalk\"?:{\"required\":true},\"snapshot\"?:object}.",
  "Canonical response shape: {\"outcome\":\"pass\"|\"replan\"|\"blocked\"|\"inconclusive\",\"reason\":string,\"evidence\"?:string[],\"repositoryFingerprint\":string,\"evidenceFingerprint\":string,\"correction\"?:string,\"strategy\"?:\"YOLO\"|\"ORCHESTRATOR\"|\"PREWALK\",\"prewalk\"?:{\"required\":true}}.",
  "Return one JSON object with no markdown and no unknown top-level fields. Allowed top-level fields are outcome, reason, evidence, repositoryFingerprint, evidenceFingerprint, correction (or compatibility alias correctionPlan), strategy, prewalk, and snapshot.",
  "outcome must be exactly pass, replan, blocked, or inconclusive.",
  "reason must be a non-empty trimmed single-line string of at most 4000 characters; it must not contain NUL, CR, or LF.",
  "evidence is optional; when present it is an array of at most 32 non-empty trimmed single-line strings, each at most 2000 characters, with no NUL, CR, or LF.",
  "repositoryFingerprint and evidenceFingerprint must be non-empty trimmed single-line strings of at most 256 characters, with no NUL, CR, or LF. Echo the controller evidence fingerprint exactly.",
  "correction is a non-empty multiline string of at most 131072 characters, with no NUL. It is permitted iff outcome is replan: include one concrete correction for replan and omit correction/correctionPlan for pass, blocked, and inconclusive.",
  "strategy, when present, must be exactly YOLO, ORCHESTRATOR, or PREWALK. prewalk, when present, must be exactly {\"required\":true}.",
  "snapshot, when present, may contain only repositoryFingerprint, evidenceFingerprint, originalPlanHash, and correctionHash; each present value has the same non-empty trimmed single-line 256-character bound.",
  "Omit every optional field that is absent; never emit null. Do not include raw excerpts or other fields.",
].join("\n");

/**
 * Build either the original V1 acceptance prompt or the self-contained V2
 * verifier prompt. V2 includes only immutable plan/correction contents and
 * explicit snapshot identity; mutable plan source paths are never presented as
 * authoritative evidence.
 */
export function buildVerifierPrompt(input: VerifierPromptInput): string {
  const originalPlan = input.originalPlan ?? input.originalPlanSnapshot;
  const controllerEvidenceFingerprint = input.evidenceFingerprint ?? input.snapshot?.evidenceFingerprint;
  const loop = input.loop ?? (originalPlan && input.loopId !== undefined
    && input.generation !== undefined && input.contextEpoch !== undefined && input.cycle !== undefined
    && controllerEvidenceFingerprint
    ? {
      loopId: input.loopId,
      generation: input.generation,
      contextEpoch: input.contextEpoch,
      cycle: input.cycle,
      strategy: input.strategy,
      originalPlan,
      correction: input.correction ?? input.correctionPlan,
      evidenceFingerprint: controllerEvidenceFingerprint,
      previousRepositoryFingerprint: input.previousRepositoryFingerprint ?? input.snapshot?.repositoryFingerprint,
    }
    : undefined);
  if (!loop || input.mode === "v1") {
    return [
      "Independently verify whether the resulting repository state satisfies this goal. This is acceptance verification, not code review.",
      `Objective: ${input.objective}`,
      `Acceptance criteria: ${input.criteria.length ? input.criteria.join(" | ") : "No explicit criteria; verify the objective literally."}`,
      `Judge candidate-completion reason: ${input.judgeReason}`,
      input.judgeEvidence?.length ? `Judge evidence hints (do not trust without checking): ${input.judgeEvidence.join(" | ")}` : "",
      "Inspect the actual repository state and run focused checks where useful. Do not edit source, delegate, start Pi, or invoke code_review.",
      "Return exactly JSON: {\"ok\":boolean,\"reason\":string,\"evidence\"?:string[]}.",
    ].filter(Boolean).join("\n\n");
  }

  const planText = (label: string, plan: VerifierPlanDetail): string => [
    `${label} (immutable snapshot; do not consult a mutable source path):`,
    `path: ${plan.path}`,
    `sha256: ${plan.hash}`,
    "content:",
    "--- BEGIN IMMUTABLE PLAN ---",
    plan.content,
    "--- END IMMUTABLE PLAN ---",
  ].join("\n");

  return [
    "Independently verify the fixed-point goal against the actual resulting repository state. This is acceptance verification, not code review.",
    `Loop identity: ${loop.loopId} / generation ${loop.generation} / context epoch ${loop.contextEpoch} / correction cycle ${loop.cycle}`,
    `Execution strategy: ${loop.strategy ?? "unspecified"}`,
    `Objective: ${input.objective}`,
    `Acceptance criteria: ${input.criteria.length ? input.criteria.join(" | ") : "No explicit criteria; verify the objective literally."}`,
    `GoalJudge candidate-completion reason: ${input.judgeReason}`,
    input.judgeEvidence?.length ? `GoalJudge evidence hints (do not trust without checking): ${input.judgeEvidence.join(" | ")}` : "",
    planText("Original plan", loop.originalPlan),
    loop.correction ? planText("Current corrective plan", loop.correction) : "No corrective plan is active for the initial cycle.",
    `Controller evidence snapshot fingerprint (must be echoed exactly): ${loop.evidenceFingerprint}`,
    loop.previousRepositoryFingerprint
      ? `Previous GoalVerifier repository fingerprint (comparison hint only): ${loop.previousRepositoryFingerprint}`
      : "No previous repository snapshot exists; establish one now.",
    "Inspect the repository yourself and run focused checks where useful. Do not edit source, delegate, start Pi, or invoke code_review.",
    "For PASS, all criteria must be independently observed. For REPLAN, provide one concrete corrective plan in `correction`. BLOCKED means the goal cannot safely continue. INCONCLUSIVE means required evidence is unavailable; it is not a pass.",
    V2_SCHEMA_GUIDANCE,
    "The repositoryFingerprint must identify the exact repository state you inspected. The evidenceFingerprint must exactly equal the controller fingerprint above. Keep correction bounded and actionable. Never claim PASS from GoalJudge's assertion alone.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Append one bounded schema-correction instruction to an already-built V2
 * prompt. The prior response is represented only by its sanitized diagnostic.
 */
export function buildVerifierRetryPrompt(
  basePrompt: string,
  diagnostic: GoalVerifierOutputDiagnostic,
  evidenceFingerprint: string,
): string {
  const safeFingerprint = typeof evidenceFingerprint === "string" && SAFE_FINGERPRINT.test(evidenceFingerprint)
    ? evidenceFingerprint
    : undefined;
  const evidenceInstruction = safeFingerprint
    ? `Echo the exact controller evidence fingerprint already present in the base prompt: ${safeFingerprint}.`
    : "Echo the exact controller evidence fingerprint already present in the base prompt; do not invent or alter it.";
  const retrySuffix = [
    "Schema correction (one retry only): the prior GoalVerifier response was rejected with this sanitized diagnostic:",
    V2_SCHEMA_GUIDANCE,
    diagnosticSummary(diagnostic),
    "Return exactly one JSON object using the existing V2 schema above. Do not return the legacy {\"ok\":...} shape.",
    evidenceInstruction,
  ].join("\n\n");
  // All variable retry inputs are independently bounded; retain the complete
  // corrective guidance and fingerprint instruction within a fixed suffix.
  const boundedSuffix = retrySuffix.length <= MAX_RETRY_SUFFIX_LENGTH
    ? retrySuffix
    : retrySuffix.slice(0, MAX_RETRY_SUFFIX_LENGTH);
  return `${basePrompt}\n\n${boundedSuffix}`;
}

export const buildGoalVerifierRetryPrompt = buildVerifierRetryPrompt;

export function parseGoalVerifierVerdict(raw: string): GoalLoopVerifierVerdict | undefined {
  const parsed = parseVerifierVerdict(raw);
  return parsed && "outcome" in parsed ? parsed : undefined;
}

export const parseGoalLoopVerifierVerdict = parseGoalVerifierVerdict;
export const buildGoalVerifierPrompt = buildVerifierPrompt;
export const buildGoalLoopVerifierPrompt = buildVerifierPrompt;
