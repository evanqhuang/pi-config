import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const NOTES_STATE_TYPE = "pi-notes-state";
export const NOTES_CHECKPOINT_TYPE = "pi-notes-checkpoint";
export const NOTES_REMINDER_TYPE = "pi-notes-reminder";
export const NOTES_VERSION = 1;

export const DEFAULT_CONFIG = Object.freeze({
  activationMode: "auto" as const,
  notesMaxBytes: 8192,
  autoActivation: {
    turns: 8,
    toolCalls: 32,
    readOnlyLongTaskTurns: 10,
    requireHighSignalActivity: true,
  },
  checkpointing: {
    dirtyTurns: 10,
    continuityRelevantToolResults: 32,
    readOnlyToolResults: 16,
  },
  integrations: {
    goal: true,
    subagentChildProbe: true,
  },
});

type ActivationMode = "off" | "manual" | "auto";
type VerificationOutcome = "success" | "error" | "unknown";

export interface CheckpointPayload {
  current: string;
  completed: string[];
  findings: string[];
  decisions: string[];
  failed_approaches: string[];
  blockers: string[];
  verification: string[];
  next_action: string;
}

export interface HarnessFacts {
  modifiedFiles: Set<string>;
  lastVerificationCommand?: string;
  lastVerificationOutcome?: VerificationOutcome;
  recentFailedCommandCount: number;
}

export interface NotesRuntime {
  activationMode: ActivationMode;
  active: boolean;
  notesId: string;
  notesPath: string;
  dirty: boolean;
  checkpointDue: boolean;
  /** Runtime-only latch: each due episode gets one ambient reminder. */
  checkpointReminderPending: boolean;
  turnsSinceCheckpoint: number;
  continuityRelevantToolResultsSinceCheckpoint: number;
  readOnlyToolResultsSinceCheckpoint: number;
  activationTurns: number;
  activationToolCalls: number;
  readOnlyTurns: number;
  sawHighSignalActivity: boolean;
  toolCallsThisTurn: number;
  highSignalThisTurn: boolean;
  checkpointGeneration: number;
  lastCheckpointHash?: string;
  lastCheckpointAt?: number;
  reentryRequired: boolean;
  harnessFacts: HarnessFacts;
  checkpointInFlight: boolean;
}

type StateRecord = {
  version: number;
  notesId: string;
  activationMode: ActivationMode;
  active: boolean;
  generation: number;
  dirty: boolean;
};

type CheckpointRecord = {
  version: number;
  notesId: string;
  activationMode: ActivationMode;
  active: boolean;
  generation: number;
  notesPath: string;
  hash: string;
  checkpointedAt: number;
  payload: CheckpointPayload;
  harnessFacts: {
    modifiedFiles: string[];
    lastVerificationCommand?: string;
    lastVerificationOutcome?: VerificationOutcome;
    recentFailedCommandCount: number;
  };
};

const CHECKPOINT_TEXT_MAX_LENGTH = 2048;
const CHECKPOINT_LIST_ITEM_MAX_LENGTH = 1024;
const CHECKPOINT_ARRAY_FIELDS = [
  "completed",
  "findings",
  "decisions",
  "failed_approaches",
  "blockers",
  "verification",
] as const;
type CheckpointArrayField = (typeof CHECKPOINT_ARRAY_FIELDS)[number];
const CHECKPOINT_MAX_ITEMS: Record<CheckpointArrayField, number> = {
  completed: 40,
  findings: 40,
  decisions: 40,
  failed_approaches: 30,
  blockers: 30,
  verification: 40,
};

const CHECKPOINT_SCHEMA = Type.Object({
  current: Type.String({
    minLength: 1,
    maxLength: CHECKPOINT_TEXT_MAX_LENGTH,
    description: "Present objective and status only; keep this compact.",
  }),
  completed: Type.Array(
    Type.String({ minLength: 1, maxLength: CHECKPOINT_LIST_ITEM_MAX_LENGTH }),
    { maxItems: CHECKPOINT_MAX_ITEMS.completed, description: "Finished work only." },
  ),
  findings: Type.Array(
    Type.String({ minLength: 1, maxLength: CHECKPOINT_LIST_ITEM_MAX_LENGTH }),
    { maxItems: CHECKPOINT_MAX_ITEMS.findings, description: "Observed facts and constraints." },
  ),
  decisions: Type.Array(
    Type.String({ minLength: 1, maxLength: CHECKPOINT_LIST_ITEM_MAX_LENGTH }),
    { maxItems: CHECKPOINT_MAX_ITEMS.decisions, description: "Chosen approaches and rationale." },
  ),
  failed_approaches: Type.Array(
    Type.String({ minLength: 1, maxLength: CHECKPOINT_LIST_ITEM_MAX_LENGTH }),
    { maxItems: CHECKPOINT_MAX_ITEMS.failed_approaches, description: "Failed attempts to avoid repeating." },
  ),
  blockers: Type.Array(
    Type.String({ minLength: 1, maxLength: CHECKPOINT_LIST_ITEM_MAX_LENGTH }),
    { maxItems: CHECKPOINT_MAX_ITEMS.blockers, description: "Unresolved impediments only." },
  ),
  verification: Type.Array(
    Type.String({ minLength: 1, maxLength: CHECKPOINT_LIST_ITEM_MAX_LENGTH }),
    { maxItems: CHECKPOINT_MAX_ITEMS.verification, description: "Commands and outcomes only." },
  ),
  next_action: Type.String({
    minLength: 1,
    maxLength: CHECKPOINT_TEXT_MAX_LENGTH,
    description: "One concrete next action only; keep this compact.",
  }),
}, { additionalProperties: false });
const CHECKPOINT_FIELDS = new Set<string>([
  "current",
  ...CHECKPOINT_ARRAY_FIELDS,
  "next_action",
]);
const MALFORMED_ARRAY_FIELD = new RegExp(
  `^(${CHECKPOINT_ARRAY_FIELDS.join("|")})\\]\\n([^\\r\\n]+)\\n</parameter$`,
);
const MALFORMED_ARROW_SPLIT_FIELD = new RegExp(
  `^(${CHECKPOINT_ARRAY_FIELDS.join("|")})\\]\\n([^\\r\\n]+)=$`,
);

/**
 * Repair the one observed model serialization artifact without changing the
 * public checkpoint schema. Invalid or ambiguous input is deliberately left
 * untouched so the normal strict validator remains authoritative.
 */
export function repairCheckpointArguments(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
  const input = args as Record<string, unknown>;
  const malformed: Array<{ key: string; field: (typeof CHECKPOINT_ARRAY_FIELDS)[number]; values: string[] }> = [];

  for (const key of Object.keys(input)) {
    if (CHECKPOINT_FIELDS.has(key)) continue;

    const closedFragment = MALFORMED_ARRAY_FIELD.exec(key);
    const arrowSplitFragment = MALFORMED_ARROW_SPLIT_FIELD.exec(key);
    let field: (typeof CHECKPOINT_ARRAY_FIELDS)[number];
    let serialized: string;
    if (closedFragment && input[key] === "") {
      field = closedFragment[1] as (typeof CHECKPOINT_ARRAY_FIELDS)[number];
      serialized = closedFragment[2];
    } else if (arrowSplitFragment && typeof input[key] === "string") {
      field = arrowSplitFragment[1] as (typeof CHECKPOINT_ARRAY_FIELDS)[number];
      serialized = `${arrowSplitFragment[2]}=>${input[key]}`;
    } else {
      return args;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return args;
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) return args;
    malformed.push({ key, field, values: parsed });
  }

  if (!malformed.length) return args;
  const seen = new Set<string>();
  for (const fragment of malformed) {
    if (Object.prototype.hasOwnProperty.call(input, fragment.field) || seen.has(fragment.field)) return args;
    seen.add(fragment.field);
  }

  const repaired: Record<string, unknown> = { ...input };
  for (const fragment of malformed) {
    delete repaired[fragment.key];
    repaired[fragment.field] = fragment.values;
  }
  return repaired;
}

const CHECKPOINT_RETRY_HINT =
  "Summarize only continuation state and retry; do not paste plans, logs, test output, or file lists.";
const INVALID_CHECKPOINT_MESSAGE = [
  "Invalid checkpoint payload.",
  "Limits: current and next_action 1-2048 characters; each list item 1-1024 characters;",
  "completed, findings, decisions, and verification at most 40 items;",
  "failed_approaches and blockers at most 30 items.",
  CHECKPOINT_RETRY_HINT,
].join(" ");

function checkpointLimitViolation(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const input = args as Record<string, unknown>;

  for (const field of ["current", "next_action"] as const) {
    const value = input[field];
    if (typeof value === "string" && value.length > CHECKPOINT_TEXT_MAX_LENGTH) {
      return `${field} is ${value.length} characters (maximum ${CHECKPOINT_TEXT_MAX_LENGTH}).`;
    }
  }

  for (const field of CHECKPOINT_ARRAY_FIELDS) {
    const value = input[field];
    if (!Array.isArray(value)) continue;
    const maxItems = CHECKPOINT_MAX_ITEMS[field];
    if (value.length > maxItems) {
      return `${field} has ${value.length} items (maximum ${maxItems}).`;
    }
    const oversizedIndex = value.findIndex(
      (item) => typeof item === "string" && item.length > CHECKPOINT_LIST_ITEM_MAX_LENGTH,
    );
    if (oversizedIndex !== -1) {
      const item = value[oversizedIndex] as string;
      return `${field}[${oversizedIndex}] is ${item.length} characters (maximum ${CHECKPOINT_LIST_ITEM_MAX_LENGTH}).`;
    }
  }

  return undefined;
}

export function prepareCheckpointArguments(args: unknown): CheckpointPayload {
  const repaired = repairCheckpointArguments(args);
  if (!Value.Check(CHECKPOINT_SCHEMA, repaired)) {
    const detail = checkpointLimitViolation(repaired);
    throw new Error(
      detail
        ? `Invalid checkpoint payload: ${detail} ${CHECKPOINT_RETRY_HINT}`
        : INVALID_CHECKPOINT_MESSAGE,
    );
  }
  return repaired as CheckpointPayload;
}

function freshHarnessFacts(): HarnessFacts {
  return { modifiedFiles: new Set(), recentFailedCommandCount: 0 };
}

function notesRoot(): string {
  return join(getAgentDir(), "notes");
}

export function notesPathFor(notesId: string): string {
  return join(notesRoot(), notesId, "NOTES.md");
}

export function createRuntime(mode: ActivationMode = DEFAULT_CONFIG.activationMode): NotesRuntime {
  const notesId = randomUUID();
  return {
    activationMode: mode,
    active: mode === "manual",
    notesId,
    notesPath: notesPathFor(notesId),
    dirty: false,
    checkpointDue: false,
    checkpointReminderPending: false,
    turnsSinceCheckpoint: 0,
    continuityRelevantToolResultsSinceCheckpoint: 0,
    readOnlyToolResultsSinceCheckpoint: 0,
    activationTurns: 0,
    activationToolCalls: 0,
    readOnlyTurns: 0,
    sawHighSignalActivity: false,
    toolCallsThisTurn: 0,
    highSignalThisTurn: false,
    checkpointGeneration: 0,
    reentryRequired: false,
    harnessFacts: freshHarnessFacts(),
    checkpointInFlight: false,
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizeList(values: readonly string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function bulletSection(title: string, values: readonly string[]): string {
  const items = normalizeList(values);
  return `## ${title}\n${items.length ? items.map((value) => `- ${value}`).join("\n") : "- None."}`;
}

function boundedWorkingSet(
  prefix: string,
  suffix: string,
  modifiedFiles: readonly string[],
): string {
  const pathLines = modifiedFiles.map((path) => `- \`${path}\``);
  const omissionLine = (omitted: number) => `- … ${omitted} more paths retained in checkpoint metadata.`;
  const render = (body: string) => `${prefix}${body}${suffix}`;
  const empty = render("- None.");
  if (Buffer.byteLength(empty, "utf8") > DEFAULT_CONFIG.notesMaxBytes) {
    return pathLines.length ? render(omissionLine(pathLines.length)) : empty;
  }
  if (!pathLines.length) return empty;

  const all = render(pathLines.join("\n"));
  if (Buffer.byteLength(all, "utf8") <= DEFAULT_CONFIG.notesMaxBytes) return all;

  for (let included = pathLines.length - 1; included >= 0; included -= 1) {
    const omitted = pathLines.length - included;
    const omission = omissionLine(omitted);
    const body = [...pathLines.slice(0, included), omission].join("\n");
    const candidate = render(body);
    if (Buffer.byteLength(candidate, "utf8") <= DEFAULT_CONFIG.notesMaxBytes) return candidate;
  }

  // No accurate omission marker fits; keep the non-empty working set truthful
  // and let the commit-time assertion preserve the hard failure.
  return render(omissionLine(pathLines.length));
}

export function renderNotes(payload: CheckpointPayload, runtime: NotesRuntime): string {
  const modifiedFiles = [...runtime.harnessFacts.modifiedFiles].sort();
  const authoredSections = [
    "# Task State",
    `## Current\n${payload.current.trim()}`,
    bulletSection("Completed", payload.completed),
    bulletSection("Findings", payload.findings),
    bulletSection("Decisions", payload.decisions),
    bulletSection("Failed Approaches", payload.failed_approaches),
    bulletSection("Verification", payload.verification),
    bulletSection("Blockers", payload.blockers),
    `## Next Action\n${payload.next_action.trim()}`,
  ];
  const prefix = `${authoredSections.join("\n\n")}\n\n## Working Set\n`;
  const suffix = `\n\n<!-- pi-notes:v1 notesId=${runtime.notesId} generation=${runtime.checkpointGeneration + 1} -->\n`;
  return boundedWorkingSet(prefix, suffix, modifiedFiles);
}

function customEntry<T>(entry: SessionEntry, customType: string): T | undefined {
  if (entry.type !== "custom" || entry.customType !== customType) return undefined;
  return entry.data as T | undefined;
}

function compatibleState(entry: SessionEntry): StateRecord | undefined {
  const data = customEntry<StateRecord>(entry, NOTES_STATE_TYPE);
  if (!data || data.version !== NOTES_VERSION || typeof data.notesId !== "string") return undefined;
  return data;
}

function compatibleCheckpoint(entry: SessionEntry): CheckpointRecord | undefined {
  const data = customEntry<CheckpointRecord>(entry, NOTES_CHECKPOINT_TYPE);
  if (!data || data.version !== NOTES_VERSION || typeof data.notesId !== "string" || typeof data.hash !== "string") return undefined;
  return data;
}

function latestRecord<T>(entries: readonly SessionEntry[], read: (entry: SessionEntry) => T | undefined): T | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const value = read(entries[index]);
    if (value) return value;
  }
  return undefined;
}

function latestStateForId(entries: readonly SessionEntry[], notesId: string): StateRecord | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const checkpoint = compatibleCheckpoint(entries[index]);
    if (checkpoint?.notesId === notesId) return undefined;
    const state = compatibleState(entries[index]);
    if (state?.notesId === notesId) return state;
  }
  return undefined;
}

function latestCheckpointForId(entries: readonly SessionEntry[], notesId: string): CheckpointRecord | undefined {
  return latestRecord(entries, (entry) => {
    const checkpoint = compatibleCheckpoint(entry);
    return checkpoint?.notesId === notesId ? checkpoint : undefined;
  });
}

function isChildSession(): boolean {
  const registry = globalThis as unknown as Record<PropertyKey, unknown>;
  const probe = registry[Symbol.for("pi-subagents:child-context:v1")];
  return typeof probe === "function" && (probe as () => boolean)() === true;
}

async function ensureSafeDestination(runtime: NotesRuntime): Promise<void> {
  const root = notesRoot();
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("Notes root must not be a symlink");
  const resolvedRoot = await realpath(root);
  const directory = dirname(runtime.notesPath);
  // Compare lexical paths before creation so symlinked ancestors such as macOS
  // /tmp -> /private/tmp do not look like an escape. The realpath check below
  // validates the created directory against the canonical root.
  const rel = relative(resolve(root), resolve(directory));
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Notes destination escapes the configured agent notes directory");
  }
  try {
    const dirStat = await lstat(directory);
    if (dirStat.isSymbolicLink()) throw new Error("Notes session directory must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: false });
  }
  const realDirectory = await realpath(directory);
  const afterRel = relative(resolvedRoot, realDirectory);
  if (afterRel === ".." || afterRel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("Validated Notes directory resolved outside the agent notes root");
  }
  try {
    const fileStat = await lstat(runtime.notesPath);
    if (fileStat.isSymbolicLink()) throw new Error("NOTES.md must not be a symlink");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readCurrentHash(path: string): Promise<string | undefined> {
  try {
    return hashText(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function hasUnexpectedMaterializedChange(runtime: NotesRuntime): Promise<boolean> {
  if (!runtime.lastCheckpointHash) return false;
  return await readCurrentHash(runtime.notesPath) !== runtime.lastCheckpointHash;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = join(dirname(path), `.NOTES.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

function persistentFacts(runtime: NotesRuntime): CheckpointRecord["harnessFacts"] {
  return {
    modifiedFiles: [...runtime.harnessFacts.modifiedFiles].sort(),
    lastVerificationCommand: runtime.harnessFacts.lastVerificationCommand,
    lastVerificationOutcome: runtime.harnessFacts.lastVerificationOutcome,
    recentFailedCommandCount: runtime.harnessFacts.recentFailedCommandCount,
  };
}

async function commitCheckpoint(pi: ExtensionAPI, runtime: NotesRuntime, payload: CheckpointPayload): Promise<{ hash: string; generation: number }> {
  if (!runtime.active) throw new Error("Durable Notes are not active; run /notes on or /notes auto first");
  if (isChildSession()) throw new Error("Child subagent sessions cannot write the parent session Notes file");
  if (runtime.checkpointInFlight) throw new Error("A Notes checkpoint is already in progress");
  runtime.checkpointInFlight = true;
  try {
    await ensureSafeDestination(runtime);
    if (await hasUnexpectedMaterializedChange(runtime)) {
      throw new Error("Session-local NOTES.md changed outside checkpoint_notes; run /notes restore before checkpointing");
    }
    const rendered = renderNotes(payload, runtime);
    const bytes = Buffer.byteLength(rendered, "utf8");
    if (bytes > DEFAULT_CONFIG.notesMaxBytes) {
      throw new Error(`Rendered Notes exceed ${DEFAULT_CONFIG.notesMaxBytes} bytes (${bytes}); keep only continuation-relevant state`);
    }
    await atomicWrite(runtime.notesPath, rendered);
    const hash = hashText(rendered);
    const generation = runtime.checkpointGeneration + 1;
    const checkpointedAt = Date.now();
    pi.appendEntry<CheckpointRecord>(NOTES_CHECKPOINT_TYPE, {
      version: NOTES_VERSION,
      notesId: runtime.notesId,
      activationMode: runtime.activationMode,
      active: true,
      generation,
      notesPath: runtime.notesPath,
      hash,
      checkpointedAt,
      payload,
      harnessFacts: persistentFacts(runtime),
    });
    runtime.checkpointGeneration = generation;
    runtime.lastCheckpointHash = hash;
    runtime.lastCheckpointAt = checkpointedAt;
    runtime.dirty = false;
    runtime.checkpointDue = false;
    runtime.checkpointReminderPending = false;
    runtime.turnsSinceCheckpoint = 0;
    runtime.continuityRelevantToolResultsSinceCheckpoint = 0;
    runtime.readOnlyToolResultsSinceCheckpoint = 0;
    runtime.readOnlyTurns = 0;
    runtime.reentryRequired = false;
    runtime.harnessFacts.recentFailedCommandCount = 0;
    return { hash, generation };
  } finally {
    runtime.checkpointInFlight = false;
  }
}

function resetIdentity(runtime: NotesRuntime): void {
  runtime.notesId = randomUUID();
  runtime.notesPath = notesPathFor(runtime.notesId);
  runtime.checkpointGeneration = 0;
  runtime.lastCheckpointHash = undefined;
  runtime.lastCheckpointAt = undefined;
  runtime.dirty = false;
  runtime.checkpointDue = false;
  runtime.checkpointReminderPending = false;
  runtime.reentryRequired = false;
  runtime.turnsSinceCheckpoint = 0;
  runtime.continuityRelevantToolResultsSinceCheckpoint = 0;
  runtime.readOnlyToolResultsSinceCheckpoint = 0;
  runtime.activationTurns = 0;
  runtime.activationToolCalls = 0;
  runtime.readOnlyTurns = 0;
  runtime.sawHighSignalActivity = false;
  runtime.toolCallsThisTurn = 0;
  runtime.highSignalThisTurn = false;
  runtime.harnessFacts = freshHarnessFacts();
}

function appendState(pi: ExtensionAPI, runtime: NotesRuntime): void {
  pi.appendEntry<StateRecord>(NOTES_STATE_TYPE, {
    version: NOTES_VERSION,
    notesId: runtime.notesId,
    activationMode: runtime.activationMode,
    active: runtime.active,
    generation: runtime.checkpointGeneration,
    dirty: runtime.dirty,
  });
}

async function materializeCheckpoint(runtime: NotesRuntime, checkpoint: CheckpointRecord): Promise<void> {
  runtime.checkpointGeneration = Math.max(0, checkpoint.generation - 1);
  runtime.harnessFacts.modifiedFiles = new Set(checkpoint.harnessFacts.modifiedFiles);
  runtime.harnessFacts.lastVerificationCommand = checkpoint.harnessFacts.lastVerificationCommand;
  runtime.harnessFacts.lastVerificationOutcome = checkpoint.harnessFacts.lastVerificationOutcome;
  runtime.harnessFacts.recentFailedCommandCount = checkpoint.harnessFacts.recentFailedCommandCount;
  const rendered = renderNotes(checkpoint.payload, runtime);
  runtime.checkpointGeneration = checkpoint.generation;
  if (hashText(rendered) !== checkpoint.hash) throw new Error("Persisted Notes checkpoint hash does not match its bounded payload");
  await ensureSafeDestination(runtime);
  if (await readCurrentHash(runtime.notesPath) !== checkpoint.hash) await atomicWrite(runtime.notesPath, rendered);
  runtime.lastCheckpointHash = checkpoint.hash;
  runtime.lastCheckpointAt = checkpoint.checkpointedAt;
}

async function clearMaterializedNotes(runtime: NotesRuntime): Promise<void> {
  await unlink(runtime.notesPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  runtime.checkpointGeneration = 0;
  runtime.lastCheckpointHash = undefined;
  runtime.lastCheckpointAt = undefined;
  runtime.harnessFacts = freshHarnessFacts();
}

function restoreRuntimeState(runtime: NotesRuntime, state: StateRecord | undefined, checkpoint: CheckpointRecord | undefined): void {
  if (state) {
    runtime.activationMode = state.activationMode;
    runtime.active = state.active;
    runtime.dirty = state.dirty;
    runtime.checkpointGeneration = state.generation;
  } else if (checkpoint) {
    runtime.activationMode = checkpoint.activationMode;
    runtime.active = checkpoint.active;
    runtime.dirty = false;
    runtime.checkpointGeneration = checkpoint.generation;
  } else {
    runtime.dirty = false;
    setCheckpointDue(runtime, false);
    runtime.checkpointGeneration = 0;
    runtime.lastCheckpointHash = undefined;
    runtime.lastCheckpointAt = undefined;
  }
  setCheckpointDue(runtime, runtime.dirty);
  runtime.turnsSinceCheckpoint = 0;
  runtime.continuityRelevantToolResultsSinceCheckpoint = 0;
  runtime.readOnlyToolResultsSinceCheckpoint = 0;
  runtime.reentryRequired = runtime.active;
}

async function restoreFromBranch(pi: ExtensionAPI, runtime: NotesRuntime, ctx: ExtensionContext, reason: string): Promise<void> {
  const entries = ctx.sessionManager.getBranch();
  if (reason === "new" || reason === "fork") {
    resetIdentity(runtime);
    runtime.active = runtime.activationMode === "manual";
    appendState(pi, runtime);
    return;
  }

  if (reason === "tree") {
    const state = latestStateForId(entries, runtime.notesId);
    const checkpoint = latestCheckpointForId(entries, runtime.notesId);
    restoreRuntimeState(runtime, state, checkpoint);
    if (checkpoint) await materializeCheckpoint(runtime, checkpoint);
    else await clearMaterializedNotes(runtime);
    runtime.reentryRequired = runtime.active;
    return;
  }

  const state = latestRecord(entries, compatibleState);
  const checkpoint = latestRecord(entries, compatibleCheckpoint);
  const identity = state?.notesId ?? checkpoint?.notesId;
  if (!identity) {
    resetIdentity(runtime);
    runtime.active = runtime.activationMode === "manual";
    appendState(pi, runtime);
    return;
  }
  runtime.notesId = identity;
  runtime.notesPath = notesPathFor(identity);
  const ownState = latestStateForId(entries, identity);
  const ownCheckpoint = latestCheckpointForId(entries, identity);
  restoreRuntimeState(runtime, ownState, ownCheckpoint);
  if (ownCheckpoint) await materializeCheckpoint(runtime, ownCheckpoint);
  else await clearMaterializedNotes(runtime);
}

function setCheckpointDue(runtime: NotesRuntime, due: boolean, options: { remind?: boolean } = {}): void {
  const changed = runtime.checkpointDue !== due;
  runtime.checkpointDue = due;
  if (!due) runtime.checkpointReminderPending = false;
  else if (changed || options.remind === true) runtime.checkpointReminderPending = options.remind ?? true;
}

function activateIfNeeded(pi: ExtensionAPI, runtime: NotesRuntime): void {
  if (runtime.activationMode !== "auto" || runtime.active) return;
  const cfg = DEFAULT_CONFIG.autoActivation;
  const highSignal = !cfg.requireHighSignalActivity || runtime.sawHighSignalActivity;
  const threshold = (highSignal && runtime.activationTurns >= cfg.turns)
    || (highSignal && runtime.activationToolCalls >= cfg.toolCalls)
    || runtime.readOnlyTurns >= cfg.readOnlyLongTaskTurns;
  if (!threshold) return;
  runtime.active = true;
  runtime.dirty = runtime.activationTurns > 0 || runtime.activationToolCalls > 0;
  setCheckpointDue(runtime, false);
  appendState(pi, runtime);
}

function markDirty(pi: ExtensionAPI, runtime: NotesRuntime): void {
  if (!runtime.active || runtime.dirty) return;
  runtime.dirty = true;
  appendState(pi, runtime);
}

const VERIFY_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|bun)?\s*(?:test|build|lint|typecheck|check)|\b(?:pytest|cargo test|go test|tsc|eslint|vitest|jest|ruff|mypy)\b/i;
const MUTATE_PATTERN = /(?:^|\s)(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove)|\b(?:git\s+(?:add|commit|checkout|switch|merge|rebase|reset|restore|clean)|sed\s+-i|mv\s|cp\s|rm\s|mkdir\s|touch\s|chmod\s|chown\s)\b/i;
const INSPECT_PATTERN = /\b(?:grep|rg|find|ls|cat|head|tail|git\s+(?:status|log|diff|show|branch|rev-parse)|gh\s+(?:pr|issue|repo|run|api)|jq)\b/i;
const READ_TOOL_PATTERN = /^(?:read|grep|find|ls|symbol_search|project_report|module_report|read_symbol|read_enclosing|lsp_diagnostics|lens_diagnostics|ast_grep_search|ast_grep_outline|lsp_navigation|ctx_execute_file)$/i;
const RESEARCH_TOOL_PATTERN = /^(?:web_search|source_check|fetch_content|get_search_content|resolve-library-id|query-docs|ctx_execute|ctx_batch_execute|ctx_search|ctx_fetch_and_index)$/i;
const SUBAGENT_RESULT_TOOL_PATTERN = /^(?:Agent|get_subagent_result)$/i;
const SUBAGENT_COMPLETION_TOOL_PATTERN = /^get_subagent_result$/i;

function commandFromInput(input: Record<string, unknown>): string | undefined {
  const command = input.command;
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}

function pathFromInput(input: Record<string, unknown>): string | undefined {
  const candidate = input.path ?? input.file_path ?? input.filePath;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export function classifyToolResult(toolName: string, input: Record<string, unknown>, isError: boolean): { continuityRelevant: boolean; highSignal: boolean; verification?: string; modifiedPath?: string } {
  if (toolName === "edit" || toolName === "write") {
    return { continuityRelevant: !isError, highSignal: true, modifiedPath: isError ? undefined : pathFromInput(input) };
  }
  if (toolName === "bash" || toolName === "powershell") {
    const command = commandFromInput(input);
    if (!command) return { continuityRelevant: false, highSignal: false };
    if (VERIFY_PATTERN.test(command)) return { continuityRelevant: true, highSignal: true, verification: command };
    if (MUTATE_PATTERN.test(command)) return { continuityRelevant: !isError, highSignal: true };
    if (INSPECT_PATTERN.test(command)) return { continuityRelevant: !isError, highSignal: false };
    if (isError) return { continuityRelevant: true, highSignal: true };
    return { continuityRelevant: false, highSignal: false };
  }
  if (/^(?:apply_patch|patch|create_file|update_file|delete_file|migration|format|codegen)$/i.test(toolName)) {
    return { continuityRelevant: !isError, highSignal: true, modifiedPath: isError ? undefined : pathFromInput(input) };
  }
  if (/^(?:test|build|lint|typecheck|verify|check)/i.test(toolName)) return { continuityRelevant: true, highSignal: true };
  if (READ_TOOL_PATTERN.test(toolName) || RESEARCH_TOOL_PATTERN.test(toolName) || SUBAGENT_RESULT_TOOL_PATTERN.test(toolName)) {
    return { continuityRelevant: !isError, highSignal: false };
  }
  return { continuityRelevant: false, highSignal: false };
}

function isDeferredReadOnlyActivity(
  classified: ReturnType<typeof classifyToolResult>,
  isError: boolean,
  meaningfulSubagentCompletion: boolean,
): boolean {
  return !isError
    && classified.continuityRelevant
    && !classified.highSignal
    && !meaningfulSubagentCompletion;
}

type ToolResultOutput = {
  content?: readonly unknown[];
  details?: unknown;
};

type SubagentResultStatus = "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
const SUBAGENT_RESULT_STATUSES = new Set<SubagentResultStatus>([
  "queued",
  "running",
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
]);

function subagentResultStatus(value: unknown): SubagentResultStatus | undefined {
  if (typeof value !== "string") return undefined;
  const status = value.trim().toLowerCase();
  return SUBAGENT_RESULT_STATUSES.has(status as SubagentResultStatus)
    ? status as SubagentResultStatus
    : undefined;
}

function statusFromSubagentResultText(content: readonly unknown[] | undefined): SubagentResultStatus | undefined {
  for (const block of content ?? []) {
    if (typeof block !== "object" || block === null) continue;
    const text = (block as { type?: unknown; text?: unknown }).type === "text"
      ? (block as { text?: unknown }).text
      : undefined;
    if (typeof text !== "string") continue;
    const match = /\bStatus\s*:\s*(queued|running|completed|steered|aborted|stopped|error)\b/i.exec(text);
    const status = subagentResultStatus(match?.[1]);
    if (status) return status;
  }
  return undefined;
}

function indicatesCompletedSubagentResult(output: ToolResultOutput | undefined): boolean {
  const details = output?.details;
  const detailRecord = typeof details === "object" && details !== null && !Array.isArray(details)
    ? details as Record<string, unknown>
    : undefined;
  const detailHasStatus = detailRecord !== undefined && Object.prototype.hasOwnProperty.call(detailRecord, "status");
  const detailStatus = subagentResultStatus(detailRecord?.status);
  const contentStatus = statusFromSubagentResultText(output?.content);

  // Details are structured and therefore authoritative when present. If they
  // disagree with the text, or contain an unrecognized status, fail closed.
  if (detailHasStatus) {
    return detailStatus !== undefined
      && (contentStatus === undefined || contentStatus === detailStatus)
      && (detailStatus === "completed" || detailStatus === "steered");
  }
  return contentStatus === "completed" || contentStatus === "steered";
}

function recordActivity(
  pi: ExtensionAPI,
  runtime: NotesRuntime,
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean,
  output?: ToolResultOutput,
): void {
  runtime.activationToolCalls += 1;
  runtime.toolCallsThisTurn += 1;
  const classified = classifyToolResult(toolName, input, isError);
  const meaningfulSubagentCompletion = !isError
    && SUBAGENT_COMPLETION_TOOL_PATTERN.test(toolName)
    && indicatesCompletedSubagentResult(output);
  if (classified.highSignal || isError || meaningfulSubagentCompletion) {
    runtime.sawHighSignalActivity = true;
    runtime.highSignalThisTurn = true;
  }
  if (classified.modifiedPath) runtime.harnessFacts.modifiedFiles.add(classified.modifiedPath);
  if (classified.verification) {
    runtime.harnessFacts.lastVerificationCommand = classified.verification;
    runtime.harnessFacts.lastVerificationOutcome = isError ? "error" : "success";
  }
  if (classified.continuityRelevant && isError) runtime.harnessFacts.recentFailedCommandCount += 1;
  const deferredReadOnly = isDeferredReadOnlyActivity(classified, isError, meaningfulSubagentCompletion);
  const readOnlyInvestigation = deferredReadOnly
    && (READ_TOOL_PATTERN.test(toolName) || RESEARCH_TOOL_PATTERN.test(toolName));
  if (runtime.active && readOnlyInvestigation) {
    runtime.readOnlyToolResultsSinceCheckpoint += 1;
    if (runtime.readOnlyToolResultsSinceCheckpoint >= DEFAULT_CONFIG.checkpointing.readOnlyToolResults) {
      markDirty(pi, runtime);
      setCheckpointDue(runtime, true);
    }
  }
  if (runtime.active && !deferredReadOnly && (classified.continuityRelevant || classified.highSignal || isError || meaningfulSubagentCompletion)) {
    if (classified.continuityRelevant) {
      runtime.continuityRelevantToolResultsSinceCheckpoint += 1;
      if (runtime.continuityRelevantToolResultsSinceCheckpoint >= DEFAULT_CONFIG.checkpointing.continuityRelevantToolResults) {
        setCheckpointDue(runtime, true);
      }
    }
    markDirty(pi, runtime);
  }
  activateIfNeeded(pi, runtime);
}

const CHECKPOINT_FIELD_GUIDANCE = [
  "Every checkpoint payload field has a mutually exclusive role; keep each fact in exactly one field.",
  "current = the present objective and status.",
  "completed = finished work only.",
  "findings = observed facts, constraints, and discoveries.",
  "decisions = chosen approaches and their rationale.",
  "failed_approaches = attempts that failed and should not be repeated.",
  "blockers = unresolved impediments.",
  "verification = verification commands and outcomes only.",
  "next_action = the one next concrete action.",
  "Do not put verification in completed, repeat current in next_action, or copy deterministic working-set facts such as modified files into authored sections; the extension supplies those facts separately.",
  "Use a compact budget well below the hard limits: current <=400 characters, next_action <=250 characters, at most 3 items per list, and each item <=180 characters.",
  "Never paste plans, logs, raw test output, or file lists. Keep only facts needed to resume; the extension adds the deterministic working set automatically.",
  "Checkpoint limits: current and next_action are 1-2048 characters; every list item is 1-1024 characters; completed, findings, decisions, and verification allow at most 40 items; failed_approaches and blockers allow at most 30. Summarize before calling checkpoint_notes rather than exceeding these limits.",
].join(" ");

function notesPolicy(): string {
  return [
    "DURABLE TASK-STATE HANDOFF IS ACTIVE.",
    "NOTES.md is a compact durable continuation/task-state handoff, not general notes, a diary, or proof. Live worktree/tool/test state is authoritative. Only the current top-level session writes its session-local file.",
    CHECKPOINT_FIELD_GUIDANCE,
    "Use checkpoint_notes after meaningful milestones, important findings/decisions, significant verification results, blockers, harness requests, and before reporting completion when the handoff is dirty.",
  ].join("\n");
}

function reminderMessage(text: string) {
  return { role: "custom" as const, customType: NOTES_REMINDER_TYPE, content: text, display: false, timestamp: Date.now() };
}

export function stripNotesReminders(messages: readonly any[]): any[] {
  return messages.filter((message) => message?.customType !== NOTES_REMINDER_TYPE);
}

export function selectReminder(pi: Pick<ExtensionAPI, "getActiveTools">, runtime: NotesRuntime): string | undefined {
  if (!runtime.active || !pi.getActiveTools().includes("checkpoint_notes")) return undefined;
  if (runtime.reentryRequired) {
    runtime.reentryRequired = false;
    if (runtime.lastCheckpointHash) {
      return `[TASK NOTES RE-ENTRY]\nReread the compact durable continuation/task-state handoff at ${runtime.notesPath} and inspect live worktree/tool state before continuing. It is not general notes or proof.`;
    }
  }
  if (runtime.checkpointDue && runtime.checkpointReminderPending) {
    runtime.checkpointReminderPending = false;
    return "[TASK NOTES CHECKPOINT DUE]\nExecution state changed materially since the last durable checkpoint or a checkpoint was explicitly requested. Before doing substantially more work, call checkpoint_notes once with only the current NOTES.md compact durable continuation/task-state handoff, not general notes, then continue.";
  }
  return undefined;
}

function displayStatus(ctx: ExtensionContext, runtime: NotesRuntime, pi: ExtensionAPI): void {
  const paused = runtime.active && !pi.getActiveTools().includes("checkpoint_notes");
  ctx.ui.notify([
    `Notes mode: ${runtime.activationMode}`,
    `active: ${runtime.active}`,
    `dirty: ${runtime.dirty}`,
    `checkpoint due: ${runtime.checkpointDue}`,
    `generation: ${runtime.checkpointGeneration}`,
    `path: ${runtime.notesPath}`,
    `tool policy: ${paused ? "paused-by-tool-policy" : "available"}`,
    `last checkpoint: ${runtime.lastCheckpointAt ? new Date(runtime.lastCheckpointAt).toISOString() : "none"}`,
  ].join("\n"), "info");
}

async function restoreCommittedSnapshot(runtime: NotesRuntime, ctx: ExtensionContext): Promise<boolean> {
  const entries = ctx.sessionManager.getBranch();
  const checkpoint = latestCheckpointForId(entries, runtime.notesId);
  if (!checkpoint) return false;
  const state = latestStateForId(entries, runtime.notesId);
  restoreRuntimeState(runtime, state, checkpoint);
  await materializeCheckpoint(runtime, checkpoint);
  runtime.reentryRequired = runtime.active;
  return true;
}

function canonicalToolPath(ctx: ExtensionContext, input: Record<string, unknown>): string | undefined {
  const target = pathFromInput(input);
  if (!target) return undefined;
  return resolve(isAbsolute(target) ? target : join(ctx.cwd, target));
}

export default function notesExtension(pi: ExtensionAPI): void {
  const runtime = createRuntime();

  pi.registerTool({
    name: "checkpoint_notes",
    label: "Checkpoint Notes",
    description: "Atomically rewrite the current top-level session's private NOTES.md with a bounded compact durable continuation/task-state handoff, not general notes.",
    promptSnippet: "Checkpoint a compact durable continuation/task-state handoff to the session-local NOTES.md",
    promptGuidelines: [
      "Use checkpoint_notes only for the compact durable continuation/task-state handoff in NOTES.md; it is not general notes, a diary, or proof. Do not include secrets, large logs, or hidden reasoning.",
      CHECKPOINT_FIELD_GUIDANCE,
    ],
    parameters: CHECKPOINT_SCHEMA,
    prepareArguments(args) {
      return prepareCheckpointArguments(args);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const committed = await commitCheckpoint(pi, runtime, params as CheckpointPayload);
      return {
        content: [{ type: "text" as const, text: `Notes checkpoint committed: ${runtime.notesPath} (generation ${committed.generation}, sha256 ${committed.hash.slice(0, 12)})` }],
        details: { notesPath: runtime.notesPath, generation: committed.generation, hash: committed.hash },
      };
    },
  });

  pi.registerCommand("notes", {
    description: "Durable task Notes: status | on | off | auto | checkpoint | resume | restore",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "status";
      if (command === "status") return displayStatus(ctx, runtime, pi);
      if (command === "on") {
        runtime.activationMode = "manual";
        runtime.active = true;
        appendState(pi, runtime);
        return displayStatus(ctx, runtime, pi);
      }
      if (command === "off") {
        runtime.activationMode = "off";
        runtime.active = false;
        setCheckpointDue(runtime, false);
        appendState(pi, runtime);
        return displayStatus(ctx, runtime, pi);
      }
      if (command === "auto") {
        runtime.activationMode = "auto";
        activateIfNeeded(pi, runtime);
        appendState(pi, runtime);
        return displayStatus(ctx, runtime, pi);
      }
      if (command === "checkpoint") {
        if (!runtime.active) {
          ctx.ui.notify("Notes are inactive; run /notes on or /notes auto first.", "warning");
          return;
        }
        if (!pi.getActiveTools().includes("checkpoint_notes")) {
          ctx.ui.notify("checkpoint_notes is disabled by the current tool policy.", "warning");
          return;
        }
        setCheckpointDue(runtime, true, { remind: false });
        pi.sendMessage({
          customType: NOTES_REMINDER_TYPE,
          content: "[TASK NOTES CHECKPOINT REQUESTED]\nCall checkpoint_notes now with the current NOTES.md compact durable continuation/task-state handoff, not general notes, then continue.",
          display: false,
        }, { triggerTurn: true, deliverAs: "followUp" });
        return;
      }
      if (command === "restore") {
        const restored = await restoreCommittedSnapshot(runtime, ctx);
        ctx.ui.notify(restored ? `Restored committed Notes snapshot to ${runtime.notesPath}.` : "No compatible checkpoint exists on the active branch.", restored ? "info" : "warning");
        return;
      }
      if (command === "resume") {
        const inherited = latestRecord(ctx.sessionManager.getBranch(), compatibleCheckpoint);
        if (!inherited || inherited.notesId === runtime.notesId) {
          ctx.ui.notify(inherited ? "The current session already owns this checkpoint." : "No compatible inherited Notes checkpoint is visible on the active branch.", inherited ? "info" : "warning");
          return;
        }
        runtime.active = true;
        runtime.dirty = true;
        setCheckpointDue(runtime, true);
        runtime.reentryRequired = true;
        runtime.harnessFacts.modifiedFiles = new Set(inherited.harnessFacts.modifiedFiles);
        runtime.harnessFacts.lastVerificationCommand = inherited.harnessFacts.lastVerificationCommand;
        runtime.harnessFacts.lastVerificationOutcome = inherited.harnessFacts.lastVerificationOutcome;
        runtime.harnessFacts.recentFailedCommandCount = inherited.harnessFacts.recentFailedCommandCount;
        const rendered = renderNotes(inherited.payload, runtime);
        if (Buffer.byteLength(rendered, "utf8") > DEFAULT_CONFIG.notesMaxBytes) throw new Error("Inherited Notes exceed configured bound");
        await ensureSafeDestination(runtime);
        await atomicWrite(runtime.notesPath, rendered);
        runtime.lastCheckpointHash = hashText(rendered);
        runtime.lastCheckpointAt = undefined;
        appendState(pi, runtime);
        ctx.ui.notify(`Adopted inherited checkpoint content into fresh Notes identity ${runtime.notesId}; checkpoint it before relying on it.`, "info");
        return;
      }
      ctx.ui.notify("Use /notes status | on | off | auto | checkpoint | resume | restore.", "warning");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    await restoreFromBranch(pi, runtime, ctx, event.reason);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreFromBranch(pi, runtime, ctx, "tree");
  });
  pi.on("session_compact", () => {
    if (!runtime.active) return;
    runtime.reentryRequired = true;
    if (runtime.dirty) setCheckpointDue(runtime, true);
  });
  pi.on("session_compact_failed", () => {
    // Preserve state. A failed/aborted compaction is not a recovery boundary.
  });
  pi.on("before_agent_start", (event) => {
    if (!runtime.active) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${notesPolicy()}` };
  });
  pi.on("context", (event) => {
    const messages = stripNotesReminders(event.messages);
    const reminder = selectReminder(pi, runtime);
    return { messages: reminder ? [...messages, reminderMessage(reminder) as any] : messages };
  });
  pi.on("turn_end", () => {
    runtime.activationTurns += 1;
    if (runtime.toolCallsThisTurn > 0 && !runtime.highSignalThisTurn) runtime.readOnlyTurns += 1;
    else if (runtime.highSignalThisTurn) runtime.readOnlyTurns = 0;
    if (runtime.active && runtime.readOnlyTurns >= DEFAULT_CONFIG.autoActivation.readOnlyLongTaskTurns) {
      markDirty(pi, runtime);
    }
    runtime.toolCallsThisTurn = 0;
    runtime.highSignalThisTurn = false;
    if (runtime.active && runtime.dirty) {
      runtime.turnsSinceCheckpoint += 1;
      if (runtime.turnsSinceCheckpoint >= DEFAULT_CONFIG.checkpointing.dirtyTurns
        || runtime.continuityRelevantToolResultsSinceCheckpoint >= DEFAULT_CONFIG.checkpointing.continuityRelevantToolResults) {
        setCheckpointDue(runtime, true);
      }
    }
    activateIfNeeded(pi, runtime);
  });
  pi.on("tool_result", (event) => {
    if (event.toolName === "checkpoint_notes") return;
    recordActivity(pi, runtime, event.toolName, event.input, event.isError, {
      content: event.content,
      details: event.details,
    });
  });
  pi.on("tool_call", async (event, ctx) => {
    if (isChildSession() && event.toolName === "checkpoint_notes") {
      return { block: true, reason: "Child subagent sessions cannot write the parent session Notes file." };
    }
    if (runtime.active && (event.toolName === "edit" || event.toolName === "write")) {
      const target = canonicalToolPath(ctx, event.input);
      if (target === resolve(runtime.notesPath)) {
        return { block: true, reason: "Direct writes to the canonical session NOTES.md are blocked; use checkpoint_notes." };
      }
    }
    if (DEFAULT_CONFIG.integrations.goal && event.toolName === "goal_progress") {
      if ((event.input as Record<string, unknown>).status === "done" && runtime.active) {
        if (runtime.dirty) {
          return { block: true, reason: "Goal completion is blocked until dirty durable Notes are checkpointed with checkpoint_notes." };
        }
        if (await hasUnexpectedMaterializedChange(runtime)) {
          return { block: true, reason: "Goal completion is blocked because session-local NOTES.md changed outside checkpoint_notes; run /notes restore before completing the goal." };
        }
      }
    }
    return undefined;
  });
}
