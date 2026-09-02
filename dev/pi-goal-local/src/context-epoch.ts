import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { parseGoalStateV2 } from "./state.js";
import { GOAL_CONTEXT_EPOCH_TYPE, type GoalStateV2 } from "./types.js";

/** AgentMessage as supplied to Pi's `context` hook. */
export type GoalContextMessage = ContextEvent["messages"][number];

export const CONTEXT_EPOCH_SCHEMA_VERSION = 1 as const;
export const MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES = 256 * 1024;
export const DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES = 64 * 1024;
export const MAX_CONTEXT_EPOCH_TEXT_LENGTH = 16 * 1024;
export const MAX_CONTEXT_EPOCH_PLAN_BYTES = 512 * 1024;
export const MAX_CONTEXT_EPOCH_LIST_ITEMS = 32;
export const DEFAULT_CONTEXT_EPOCH_FALLBACK_MESSAGES = 64;
export const DEFAULT_CONTEXT_EPOCH_FALLBACK_BYTES = 256 * 1024;

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PATH_LENGTH = 4096;

export interface ContextEpochPlanContent {
  /** This must be the private immutable snapshot path, never a mutable source path. */
  path: string;
  hash: string;
  content: string;
}

export interface ContextEpochVerifierContext {
  discrepancies: readonly string[];
  requiredValidation: readonly string[];
}

/** The complete, self-contained prompt payload for one context epoch. */
export interface ContextEpochBootstrap {
  schemaVersion: typeof CONTEXT_EPOCH_SCHEMA_VERSION;
  loopId: string;
  generation: number;
  contextEpoch: number;
  cycle: number;
  pendingVerificationEntry?: true;
  objective: string;
  criteria: string[];
  originalPlan: ContextEpochPlanContent;
  correction?: ContextEpochPlanContent;
  verifier: ContextEpochVerifierContext;
  capabilityGuidance: string[];
  continuationInstruction: string;
}

export interface ContextEpochBootstrapInput {
  originalPlan: ContextEpochPlanContent;
  correction?: ContextEpochPlanContent;
  verifier?: ContextEpochVerifierContext;
  capabilityGuidance: readonly string[] | string;
  continuationInstruction: string;
}

export interface ContextEpochBootstrapOptions extends ContextEpochBootstrapInput {
  state: GoalStateV2;
  maxBootstrapBytes?: number;
}

export interface ContextEpochMarkerDetails {
  schemaVersion: typeof CONTEXT_EPOCH_SCHEMA_VERSION;
  id: string;
  hash: string;
}

/** The hidden message written to the session and later consumed by `context`. */
export interface ContextEpochMarkerMessage {
  role: "custom";
  customType: typeof GOAL_CONTEXT_EPOCH_TYPE;
  content: string;
  display: false;
  details: ContextEpochMarkerDetails;
  timestamp: number;
}

export interface ParsedContextEpochMarker {
  message: ContextEpochMarkerMessage;
  bootstrap: ContextEpochBootstrap;
  id: string;
  hash: string;
}

export type ContextFilterDisposition =
  | "matched"
  | "fallback-safe"
  | "fallback-unsafe"
  | "rejected";

export interface ContextFilterResult {
  messages: GoalContextMessage[];
  disposition: ContextFilterDisposition;
  reason?: string;
  marker?: ParsedContextEpochMarker;
  safeSuffixIncluded: boolean;
}

export interface ContextFilterOptions {
  /** Required when a matching marker is absent: state intentionally stores no plan text. */
  bootstrap?: ContextEpochBootstrap | ContextEpochBootstrapInput;
  maxBootstrapBytes?: number;
  maxFallbackMessages?: number;
  maxFallbackBytes?: number;
  timestamp?: number;
}

type ContextFilterArgument = ContextFilterOptions | ContextEpochBootstrap | ContextEpochBootstrapInput;

export type ContextEpochErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "SIZE_LIMIT"
  | "HASH_MISMATCH"
  | "STATE_MISMATCH"
  | "MALFORMED_MARKER"
  | "STALE_MARKER"
  | "FOREIGN_MARKER"
  | "CONFLICTING_MARKERS"
  | "UNSAFE_FALLBACK";

export class ContextEpochError extends Error {
  readonly code: ContextEpochErrorCode;

  constructor(code: ContextEpochErrorCode, message: string) {
    super(message);
    this.name = "ContextEpochError";
    this.code = code;
  }
}

function fail(code: ContextEpochErrorCode, message: string): never {
  throw new ContextEpochError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every(key => allowed.has(key));
}

function boundedText(value: unknown, label: string, max = MAX_CONTEXT_EPOCH_TEXT_LENGTH): string {
  if (typeof value !== "string") fail("INVALID_INPUT", `${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > max || text.includes("\u0000")) {
    fail("INVALID_INPUT", `${label} must be non-empty and bounded.`);
  }
  return text;
}

function boundedContent(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > MAX_CONTEXT_EPOCH_PLAN_BYTES || value.includes("\u0000")) {
    fail("INVALID_INPUT", `${label} must be bounded UTF-8 text without NUL bytes.`);
  }
  if (!value.trim()) fail("INVALID_INPUT", `${label} must not be empty.`);
  return value;
}

function boundedPath(value: unknown, label: string): string {
  if (typeof value !== "string") fail("INVALID_INPUT", `${label} must be a path.`);
  const path = value.trim();
  if (!path || path.length > MAX_PATH_LENGTH || /[\u0000\r\n]/u.test(path)) {
    fail("INVALID_INPUT", `${label} must be a bounded path without control characters.`);
  }
  return path;
}

function boundedInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("INVALID_INPUT", `${label} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail("INVALID_INPUT", `${label} must be a lowercase SHA-256 hash.`);
  }
  return value;
}

function validateLimit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    fail("INVALID_INPUT", `${label} must be a positive bounded integer.`);
  }
  return limit;
}

function validateTimestamp(value: number | undefined): number {
  const timestamp = value ?? 0;
  if (!Number.isFinite(timestamp) || timestamp < 0) fail("INVALID_INPUT", "Marker timestamp must be finite and non-negative.");
  return timestamp;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

/**
 * Serialize JSON with lexicographically sorted object keys. This prevents a
 * marker's hash from depending on object construction order or parser details.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_INPUT", "Canonical JSON cannot contain a non-finite number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  fail("INVALID_INPUT", "Canonical JSON cannot contain unsupported values.");
}

function parseCanonicalJson(content: unknown, maxBytes: number): unknown {
  if (typeof content !== "string") fail("MALFORMED_MARKER", "Epoch marker content must be JSON text.");
  if (Buffer.byteLength(content, "utf8") > maxBytes) fail("SIZE_LIMIT", "Epoch marker exceeds the bootstrap size bound.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    fail("MALFORMED_MARKER", "Epoch marker content is not valid JSON.");
  }
  if (canonicalJson(parsed) !== content) fail("MALFORMED_MARKER", "Epoch marker JSON is not canonical.");
  return parsed;
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_EPOCH_LIST_ITEMS) {
    fail("INVALID_INPUT", `${label} must be a bounded list.`);
  }
  const result = value.map((item, index) => boundedText(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) fail("INVALID_INPUT", `${label} must not contain duplicates.`);
  return result;
}

function normalizePlan(value: unknown, label: string): ContextEpochPlanContent {
  if (!isRecord(value) || !hasOnlyKeys(value, ["path", "hash", "content"])) {
    fail("INVALID_INPUT", `${label} must contain only path, hash, and content.`);
  }
  const path = boundedPath(value.path, `${label}.path`);
  const hash = validateHash(value.hash, `${label}.hash`);
  const content = boundedContent(value.content, `${label}.content`);
  if (sha256Text(content) !== hash) fail("HASH_MISMATCH", `${label}.content does not match its hash.`);
  return { path, hash, content };
}

function normalizeVerifier(value: unknown): ContextEpochVerifierContext {
  if (!isRecord(value) || !hasOnlyKeys(value, ["discrepancies", "requiredValidation"])) {
    fail("INVALID_INPUT", "verifier must contain discrepancies and requiredValidation only.");
  }
  return {
    discrepancies: validateStringList(value.discrepancies, "verifier.discrepancies"),
    requiredValidation: validateStringList(value.requiredValidation, "verifier.requiredValidation"),
  };
}

function validatedState(state: GoalStateV2): GoalStateV2 {
  const parsed = parseGoalStateV2(state);
  if (!parsed) fail("INVALID_STATE", "The supplied GoalStateV2 is not strictly valid.");
  return parsed;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateBootstrapAgainstState(bootstrap: ContextEpochBootstrap, stateInput: GoalStateV2): GoalStateV2 {
  const state = validatedState(stateInput);
  if (bootstrap.loopId !== state.loopId
    || bootstrap.generation !== state.generation
    || bootstrap.contextEpoch !== state.contextEpoch
    || bootstrap.cycle !== state.cycle
    || (bootstrap.pendingVerificationEntry === true) !== (state.pendingVerificationEntry === true)
    || bootstrap.objective !== state.objective
    || !sameStrings(bootstrap.criteria, state.criteria)) {
    fail("STATE_MISMATCH", "Epoch bootstrap identity does not match GoalStateV2.");
  }
  if (!state.plan.snapshotPath || !state.plan.snapshotHash) {
    fail("STATE_MISMATCH", "GoalStateV2 has no immutable original plan snapshot.");
  }
  if (bootstrap.originalPlan.path !== state.plan.snapshotPath || bootstrap.originalPlan.hash !== state.plan.snapshotHash) {
    fail("STATE_MISMATCH", "Epoch bootstrap must reference the immutable original plan snapshot.");
  }

  const expectedCorrectionPath = state.verifier?.correctionPath;
  const expectedCorrectionHash = state.verifier?.correctionHash;
  if ((expectedCorrectionPath === undefined) !== (expectedCorrectionHash === undefined)) {
    fail("INVALID_STATE", "GoalStateV2 has an incomplete correction provenance pair.");
  }
  if (expectedCorrectionPath !== undefined && expectedCorrectionHash !== undefined) {
    if (!bootstrap.correction
      || bootstrap.correction.path !== expectedCorrectionPath
      || bootstrap.correction.hash !== expectedCorrectionHash) {
      fail("STATE_MISMATCH", "Epoch bootstrap correction does not match GoalStateV2.");
    }
  } else if (bootstrap.correction !== undefined) {
    fail("STATE_MISMATCH", "Epoch bootstrap contains a correction absent from GoalStateV2.");
  }
  return state;
}

function normalizeBootstrap(value: unknown, maxBootstrapBytes: number): ContextEpochBootstrap {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "schemaVersion", "loopId", "generation", "contextEpoch", "cycle", "pendingVerificationEntry", "objective", "criteria",
    "originalPlan", "correction", "verifier", "capabilityGuidance", "continuationInstruction",
  ])) {
    fail("INVALID_INPUT", "Epoch bootstrap has an unknown or missing field.");
  }
  if (value.schemaVersion !== CONTEXT_EPOCH_SCHEMA_VERSION) fail("INVALID_INPUT", "Unsupported epoch bootstrap version.");
  const hasPendingVerificationEntry = Object.prototype.hasOwnProperty.call(value, "pendingVerificationEntry");
  if (hasPendingVerificationEntry && value.pendingVerificationEntry !== true) {
    fail("INVALID_INPUT", "pendingVerificationEntry must be true when present.");
  }
  const correction = value.correction === undefined ? undefined : normalizePlan(value.correction, "correction");
  const bootstrap: ContextEpochBootstrap = {
    schemaVersion: CONTEXT_EPOCH_SCHEMA_VERSION,
    loopId: boundedText(value.loopId, "loopId", 256),
    generation: boundedInteger(value.generation, "generation", 1),
    contextEpoch: boundedInteger(value.contextEpoch, "contextEpoch", 0),
    cycle: boundedInteger(value.cycle, "cycle", 0),
    objective: boundedText(value.objective, "objective"),
    criteria: validateStringList(value.criteria, "criteria"),
    originalPlan: normalizePlan(value.originalPlan, "originalPlan"),
    verifier: normalizeVerifier(value.verifier),
    capabilityGuidance: validateStringList(value.capabilityGuidance, "capabilityGuidance"),
    continuationInstruction: boundedText(value.continuationInstruction, "continuationInstruction"),
  };
  if (hasPendingVerificationEntry) bootstrap.pendingVerificationEntry = true;
  if (correction !== undefined) bootstrap.correction = correction;

  const serialized = canonicalJson(bootstrap);
  if (Buffer.byteLength(serialized, "utf8") > maxBootstrapBytes) {
    fail("SIZE_LIMIT", "Epoch bootstrap exceeds the configured size bound.");
  }
  return bootstrap;
}

/** Validate and canonically construct one bootstrap from authoritative state. */
export function createContextEpochBootstrap(options: ContextEpochBootstrapOptions): ContextEpochBootstrap {
  if (!isRecord(options)) fail("INVALID_INPUT", "Bootstrap options must be an object.");
  const maxBytes = validateLimit(
    options.maxBootstrapBytes,
    DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
    MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
    "maxBootstrapBytes",
  );
  const state = validatedState(options.state);
  const verifier = options.verifier ?? { discrepancies: [], requiredValidation: [] };
  const candidate: ContextEpochBootstrap = {
    schemaVersion: CONTEXT_EPOCH_SCHEMA_VERSION,
    loopId: state.loopId,
    generation: state.generation,
    contextEpoch: state.contextEpoch,
    cycle: state.cycle,
    objective: state.objective,
    criteria: [...state.criteria],
    originalPlan: options.originalPlan,
    verifier,
    capabilityGuidance: typeof options.capabilityGuidance === "string"
      ? [options.capabilityGuidance]
      : [...options.capabilityGuidance],
    continuationInstruction: options.continuationInstruction,
  };
  if (state.pendingVerificationEntry === true) candidate.pendingVerificationEntry = true;
  if (options.correction !== undefined) candidate.correction = options.correction;
  const bootstrap = normalizeBootstrap(candidate, maxBytes);
  const normalizedState = validateBootstrapAgainstState(bootstrap, state);
  const hash = hashContextEpochBootstrap(bootstrap, maxBytes);
  if (normalizedState.epochMarker !== undefined && normalizedState.epochMarker.hash !== hash) {
    fail("STATE_MISMATCH", "Bootstrap does not match GoalStateV2's authoritative epoch marker hash.");
  }
  return bootstrap;
}

/** Parse and strictly validate a serialized or in-memory bootstrap. */
export function parseContextEpochBootstrap(
  value: unknown,
  maxBootstrapBytes = DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
): ContextEpochBootstrap {
  const limit = validateLimit(maxBootstrapBytes, DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES, MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES, "maxBootstrapBytes");
  if (typeof value === "string") return normalizeBootstrap(parseCanonicalJson(value, limit), limit);
  return normalizeBootstrap(value, limit);
}

/** Validate a bootstrap against the durable state and its recorded marker hash. */
export function validateContextEpochBootstrap(
  value: unknown,
  state: GoalStateV2,
  maxBootstrapBytes = DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
): ContextEpochBootstrap {
  const bootstrap = parseContextEpochBootstrap(value, maxBootstrapBytes);
  const validated = validateBootstrapAgainstState(bootstrap, state);
  const hash = hashContextEpochBootstrap(bootstrap, maxBootstrapBytes);
  if (validated.epochMarker !== undefined && validated.epochMarker.hash !== hash) {
    fail("STATE_MISMATCH", "Bootstrap does not match GoalStateV2's authoritative epoch marker hash.");
  }
  return bootstrap;
}

/** Compatibility-oriented name for callers that keep state separate from input. */
export function buildContextEpochBootstrap(
  state: GoalStateV2,
  input: ContextEpochBootstrapInput,
  options: { maxBootstrapBytes?: number } = {},
): ContextEpochBootstrap {
  return createContextEpochBootstrap({ ...input, state, ...options });
}

export const createEpochBootstrap = createContextEpochBootstrap;

export function serializeContextEpochBootstrap(
  bootstrap: ContextEpochBootstrap,
  maxBootstrapBytes = DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
): string {
  const limit = validateLimit(maxBootstrapBytes, DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES, MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES, "maxBootstrapBytes");
  const normalized = normalizeBootstrap(bootstrap, limit);
  return canonicalJson(normalized);
}

export function hashContextEpochBootstrap(
  bootstrap: ContextEpochBootstrap,
  maxBootstrapBytes = DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
): string {
  return sha256Text(serializeContextEpochBootstrap(bootstrap, maxBootstrapBytes));
}

export function contextEpochMarkerId(bootstrap: ContextEpochBootstrap): string {
  return `goal-epoch-${sha256Text(`${bootstrap.loopId}\u0000${bootstrap.generation}\u0000${bootstrap.contextEpoch}`)}`;
}

/** Create the durable hidden custom message for a validated bootstrap. */
export function createContextEpochMarker(
  bootstrap: ContextEpochBootstrap,
  options: { maxBootstrapBytes?: number; timestamp?: number; id?: string } = {},
): ContextEpochMarkerMessage {
  const serialized = serializeContextEpochBootstrap(bootstrap, options.maxBootstrapBytes);
  const hash = sha256Text(serialized);
  const id = options.id === undefined ? contextEpochMarkerId(bootstrap) : boundedText(options.id, "marker id", 256);
  return {
    role: "custom",
    customType: GOAL_CONTEXT_EPOCH_TYPE,
    content: serialized,
    display: false,
    details: { schemaVersion: CONTEXT_EPOCH_SCHEMA_VERSION, id, hash },
    timestamp: validateTimestamp(options.timestamp),
  } as ContextEpochMarkerMessage;
}

export const createContextEpochMarkerMessage = createContextEpochMarker;
export const createEpochMarker = createContextEpochMarker;

function parseMarkerDetails(value: unknown): ContextEpochMarkerDetails {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "id", "hash"])
    || value.schemaVersion !== CONTEXT_EPOCH_SCHEMA_VERSION) {
    fail("MALFORMED_MARKER", "Epoch marker details are malformed.");
  }
  const id = boundedText(value.id, "marker id", 256);
  const hash = validateHash(value.hash, "marker hash");
  return { schemaVersion: CONTEXT_EPOCH_SCHEMA_VERSION, id, hash };
}

function parseMarkerUnknown(value: unknown, maxBootstrapBytes: number): ParsedContextEpochMarker {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["role", "customType", "content", "display", "details", "timestamp"])
    || value.role !== "custom"
    || value.customType !== GOAL_CONTEXT_EPOCH_TYPE
    || value.display !== false
    || typeof value.timestamp !== "number"
    || !Number.isFinite(value.timestamp)
    || value.timestamp < 0) {
    fail("MALFORMED_MARKER", "Epoch marker message is malformed.");
  }
  const details = parseMarkerDetails(value.details);
  const parsed = parseCanonicalJson(value.content, maxBootstrapBytes);
  const bootstrap = normalizeBootstrap(parsed, maxBootstrapBytes);
  const serialized = canonicalJson(bootstrap);
  if (serialized !== value.content) fail("MALFORMED_MARKER", "Epoch marker bootstrap is not canonically normalized.");
  const hash = sha256Text(serialized);
  const id = details.id;
  if (details.hash !== hash) fail("HASH_MISMATCH", "Epoch marker hash does not match its bootstrap.");
  return {
    message: {
      role: "custom",
      customType: GOAL_CONTEXT_EPOCH_TYPE,
      content: serialized,
      display: false,
      details,
      timestamp: value.timestamp,
    },
    bootstrap,
    id,
    hash,
  };
}

/** Parse a marker, throwing a stable error rather than silently accepting it. */
export function parseContextEpochMarker(
  value: unknown,
  state?: GoalStateV2,
  maxBootstrapBytes = DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
): ParsedContextEpochMarker {
  const limit = validateLimit(maxBootstrapBytes, DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES, MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES, "maxBootstrapBytes");
  const parsed = parseMarkerUnknown(value, limit);
  if (state !== undefined) {
    const authoritative = validatedState(state);
    if (parsed.bootstrap.loopId !== authoritative.loopId || parsed.bootstrap.generation !== authoritative.generation) {
      fail("FOREIGN_MARKER", "Epoch marker belongs to a different loop or goal generation.");
    }
    if (parsed.bootstrap.contextEpoch !== authoritative.contextEpoch || parsed.bootstrap.cycle !== authoritative.cycle) {
      fail("STALE_MARKER", "Epoch marker belongs to a different context epoch or correction cycle.");
    }
    const validated = validateBootstrapAgainstState(parsed.bootstrap, authoritative);
    if (validated.epochMarker !== undefined
      && (validated.epochMarker.id !== parsed.id || validated.epochMarker.hash !== parsed.hash)) {
      fail("STATE_MISMATCH", "Epoch marker does not match GoalStateV2's authoritative marker.");
    }
  }
  return parsed;
}

export function tryParseContextEpochMarker(
  value: unknown,
  state?: GoalStateV2,
  maxBootstrapBytes = DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
): ParsedContextEpochMarker | undefined {
  try {
    return parseContextEpochMarker(value, state, maxBootstrapBytes);
  } catch {
    return undefined;
  }
}

function isEpochMarkerCandidate(value: unknown): boolean {
  return isRecord(value) && value.role === "custom" && value.customType === GOAL_CONTEXT_EPOCH_TYPE;
}

function sameCurrentIdentity(bootstrap: ContextEpochBootstrap, state: GoalStateV2): boolean {
  return bootstrap.loopId === state.loopId
    && bootstrap.generation === state.generation
    && bootstrap.contextEpoch === state.contextEpoch;
}

function isSummaryMessage(message: GoalContextMessage): boolean {
  if (!isRecord(message)) return false;
  return message.role === "compactionSummary" || message.role === "branchSummary";
}

function toolCallIds(message: GoalContextMessage): string[] {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string" || !block.id) continue;
    ids.push(block.id);
  }
  return ids;
}

/** Check that no tool result is orphaned and every current call is completed. */
function hasCompleteToolTraffic(messages: readonly GoalContextMessage[]): boolean {
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message)) return false;
    if (message.role === "assistant") {
      for (const id of toolCallIds(message)) {
        if (outstanding.has(id)) return false;
        outstanding.add(id);
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !outstanding.delete(message.toolCallId)) return false;
    }
  }
  return outstanding.size === 0;
}

function safeSuffix(
  messages: readonly GoalContextMessage[],
  maxMessages: number,
  maxBytes: number,
): GoalContextMessage[] | undefined {
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isRecord(message) && message.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return undefined;
  const suffix = messages.slice(userIndex);
  if (suffix.length > maxMessages) return undefined;
  const filtered = suffix.filter(message => !isSummaryMessage(message) && isRecord(message)
    && (message.role === "user" || message.role === "assistant" || message.role === "toolResult"));
  if (filtered.length !== suffix.length) return undefined;
  try {
    if (Buffer.byteLength(canonicalJson(filtered), "utf8") > maxBytes) return undefined;
  } catch {
    return undefined;
  }
  return hasCompleteToolTraffic(filtered) ? filtered : undefined;
}

function safeAutonomousSuffix(
  messages: readonly GoalContextMessage[],
  maxMessages: number,
  maxBytes: number,
): GoalContextMessage[] | undefined {
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isSummaryMessage(messages[index])) {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return undefined;
  const suffix = messages.slice(boundary + 1);
  if (suffix.length === 0 || suffix.length > maxMessages) return undefined;
  const allowed = suffix.every(message => isRecord(message)
    && (message.role === "assistant" || message.role === "toolResult"));
  if (!allowed || !hasCompleteToolTraffic(suffix)) return undefined;
  try {
    return Buffer.byteLength(canonicalJson(suffix), "utf8") <= maxBytes ? [...suffix] : undefined;
  } catch {
    return undefined;
  }
}

function normalizeFilterOptions(options: ContextFilterArgument | undefined): ContextFilterOptions | undefined {
  if (options === undefined) return undefined;
  if (isRecord(options) && "originalPlan" in options) {
    return { bootstrap: options as unknown as ContextEpochBootstrap | ContextEpochBootstrapInput };
  }
  return options as ContextFilterOptions;
}

function fallbackBootstrap(
  state: GoalStateV2,
  options: ContextFilterOptions | undefined,
): ContextEpochBootstrap | undefined {
  const supplied = options?.bootstrap;
  if (supplied === undefined) return undefined;
  const maxBytes = validateLimit(
    options?.maxBootstrapBytes,
    DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
    MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
    "maxBootstrapBytes",
  );
  try {
    if (isRecord(supplied) && supplied.schemaVersion === CONTEXT_EPOCH_SCHEMA_VERSION) {
      const parsed = normalizeBootstrap(supplied, maxBytes);
      validateBootstrapAgainstState(parsed, state);
      return parsed;
    }
    return createContextEpochBootstrap({ ...supplied as ContextEpochBootstrapInput, state, maxBootstrapBytes: maxBytes });
  } catch {
    return undefined;
  }
}

/**
 * Filter a context payload at the latest authoritative epoch marker. The
 * returned array is always newly allocated; this function never edits the
 * caller's array or any message object in it.
 */
export function filterContextWithDisposition(
  messages: readonly GoalContextMessage[],
  stateInput: GoalStateV2,
  options?: ContextFilterArgument,
): ContextFilterResult {
  if (!Array.isArray(messages)) fail("INVALID_INPUT", "Context messages must be an array.");
  const state = validatedState(stateInput);
  const filterOptions = normalizeFilterOptions(options);
  const maxBootstrapBytes = validateLimit(
    filterOptions?.maxBootstrapBytes,
    DEFAULT_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
    MAX_CONTEXT_EPOCH_BOOTSTRAP_BYTES,
    "maxBootstrapBytes",
  );
  const maxFallbackMessages = validateLimit(
    filterOptions?.maxFallbackMessages,
    DEFAULT_CONTEXT_EPOCH_FALLBACK_MESSAGES,
    256,
    "maxFallbackMessages",
  );
  const maxFallbackBytes = validateLimit(
    filterOptions?.maxFallbackBytes,
    DEFAULT_CONTEXT_EPOCH_FALLBACK_BYTES,
    1024 * 1024,
    "maxFallbackBytes",
  );
  const markerRecords: Array<{ index: number; parsed?: ParsedContextEpochMarker }> = [];
  let malformedMarker = false;
  for (let index = 0; index < messages.length; index += 1) {
    if (!isEpochMarkerCandidate(messages[index])) continue;
    try {
      markerRecords.push({ index, parsed: parseContextEpochMarker(messages[index], undefined, maxBootstrapBytes) });
    } catch {
      malformedMarker = true;
      markerRecords.push({ index });
    }
  }

  const current = markerRecords.filter(record => record.parsed && sameCurrentIdentity(record.parsed.bootstrap, state));
  const currentSignatures = new Set(current.map(record => `${record.parsed?.id}:${record.parsed?.hash}`));
  const currentStateValid = current.every(record => {
    try {
      parseContextEpochMarker(record.parsed?.message, state, maxBootstrapBytes);
      return true;
    } catch {
      return false;
    }
  });
  const currentConflict = currentSignatures.size > 1;
  const latestCurrent = current.length > 0 ? current[current.length - 1] : undefined;
  const postMarkerForeign = latestCurrent !== undefined && markerRecords.some(record => {
    if (record.index <= latestCurrent.index) return false;
    return !record.parsed || !sameCurrentIdentity(record.parsed.bootstrap, state);
  });
  const hasForeignOrStaleWithoutCurrent = latestCurrent === undefined && markerRecords.length > 0;
  const markerIssue = malformedMarker || currentConflict || !currentStateValid || postMarkerForeign;

  if (latestCurrent !== undefined && !markerIssue && latestCurrent.parsed) {
    // Everything after the authoritative cutoff belongs to this epoch. In
    // particular, a summary generated after the marker is current context and
    // must retain its original order; only pre-marker summaries are discarded.
    const post = messages.slice(latestCurrent.index + 1);
    if (hasCompleteToolTraffic(post)) {
      const retained = [latestCurrent.parsed.message, ...post];
      return {
        messages: retained,
        disposition: "matched",
        marker: latestCurrent.parsed,
        safeSuffixIncluded: post.length > 0,
      };
    }
    return {
      messages: [latestCurrent.parsed.message],
      disposition: "rejected",
      reason: "The current epoch contains an incomplete assistant tool-call/tool-result pair.",
      marker: latestCurrent.parsed,
      safeSuffixIncluded: false,
    };
  }

  const bootstrap = fallbackBootstrap(state, filterOptions);
  if (!bootstrap) {
    return {
      messages: [],
      disposition: "fallback-unsafe",
      reason: "No valid matching epoch marker or validated bootstrap is available; automatic continuation must pause.",
      safeSuffixIncluded: false,
    };
  }
  const marker = createContextEpochMarker(bootstrap, {
    maxBootstrapBytes,
    timestamp: filterOptions?.timestamp,
    id: state.epochMarker?.id,
  });
  const parsedMarker = parseContextEpochMarker(marker, state, maxBootstrapBytes);
  const suffix = !markerIssue && !hasForeignOrStaleWithoutCurrent
    ? safeSuffix(messages, maxFallbackMessages, maxFallbackBytes)
      ?? safeAutonomousSuffix(messages, maxFallbackMessages, maxFallbackBytes)
    : undefined;
  if (suffix) {
    return {
      messages: [marker, ...suffix],
      disposition: "fallback-safe",
      marker: parsedMarker,
      safeSuffixIncluded: true,
      reason: "Matching marker was absent; only the latest complete user-led turn was retained.",
    };
  }
  return {
    messages: [marker],
    disposition: markerIssue || hasForeignOrStaleWithoutCurrent ? "rejected" : "fallback-unsafe",
    marker: parsedMarker,
    safeSuffixIncluded: false,
    reason: markerIssue
      ? "Epoch marker integrity failed; only a synthesized authoritative bootstrap was retained."
      : "No safe complete user-led turn suffix was established; automatic continuation must pause.",
  };
}

/** Direct array-returning form suitable for a Pi `context` handler. */
export function filterContextMessages(
  messages: readonly GoalContextMessage[],
  state: GoalStateV2,
  options?: ContextFilterArgument,
): GoalContextMessage[] {
  return filterContextWithDisposition(messages, state, options).messages;
}

export const filterContext = filterContextMessages;
export const filterGoalContext = filterContextMessages;
export const filterGoalContextWithDisposition = filterContextWithDisposition;