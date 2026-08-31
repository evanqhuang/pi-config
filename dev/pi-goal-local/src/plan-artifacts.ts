import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GoalPlanProvenance, GoalPlanSourceKind } from "./types.js";

/** The private root below the Pi agent directory for loop-owned artifacts. */
export const GOAL_LOOP_ARTIFACT_ROOT = "goal-loops";
export const ORIGINAL_PLAN_FILENAME = "original-plan.md";
export const CORRECTION_PLAN_FILENAME = (cycle: number): string => `cycle-${cycle}-plan.md`;

/** A conservative hard ceiling, even when a caller supplies an unsafe limit. */
export const MAX_PLAN_ARTIFACT_BYTES = 512 * 1024;

const SAFE_LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_CYCLE = Number.MAX_SAFE_INTEGER;
const READ_FLAGS = constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

type ArtifactSourceKind = Exclude<GoalPlanSourceKind, "objective">;

export type PlanArtifactErrorCode =
  | "INVALID_INPUT"
  | "INVALID_LOOP_ID"
  | "INVALID_CYCLE"
  | "INVALID_PATH"
  | "SOURCE_UNREADABLE"
  | "SOURCE_NOT_REGULAR"
  | "SYMLINK_NOT_ALLOWED"
  | "SIZE_LIMIT"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_NOT_REGULAR"
  | "HASH_MISMATCH"
  | "ARTIFACT_EXISTS"
  | "STORAGE_ERROR";

/** Errors from this module have a stable code for fail-closed controller paths. */
export class PlanArtifactError extends Error {
  readonly code: PlanArtifactErrorCode;

  constructor(code: PlanArtifactErrorCode, message: string) {
    super(message);
    this.name = "PlanArtifactError";
    this.code = code;
  }
}

export interface PlanArtifactStorageOptions {
  /** Test-friendly override; production callers should leave this unset. */
  agentDir?: string;
}

export interface OriginalPlanSnapshotOptions extends PlanArtifactStorageOptions {
  cwd: string;
  loopId: string;
  /** Canonical source kind from GoalStateV2. Defaults to explicit. */
  sourceKind?: ArtifactSourceKind;
  /** The explicit/approved source path. */
  sourcePath?: string;
  /** Alias accepted for callers that name the CLI field planPath. */
  planPath?: string;
  /** Required bounded limit in bytes. maxPlanBytes is an accepted alias. */
  maxBytes?: number;
  maxPlanBytes?: number;
}

export interface PlanArtifactBase {
  path: string;
  hash: string;
  content: string;
  sizeBytes: number;
}

export interface OriginalPlanSnapshot extends PlanArtifactBase {
  sourcePath: string;
  sourceKind: ArtifactSourceKind;
  provenance: GoalPlanProvenance;
}

export interface LoadOriginalPlanOptions extends PlanArtifactStorageOptions {
  loopId: string;
  provenance: GoalPlanProvenance;
  /** Required bounded limit in bytes. maxPlanBytes is an accepted alias. */
  maxBytes?: number;
  maxPlanBytes?: number;
}

export interface CorrectionPlanMetadata {
  cycle: number;
  path: string;
  hash: string;
  sizeBytes: number;
}

export interface PersistCorrectionPlanOptions extends PlanArtifactStorageOptions {
  loopId: string;
  cycle: number;
  /** Optional controller safety bound for this correction cycle. */
  maxCycles?: number;
  /** Corrective plan text. plan/content are accepted aliases for integration convenience. */
  content?: string;
  plan?: string;
  correction?: string;
  /** Required bounded limit in bytes. maxCorrectionBytes is an accepted alias. */
  maxBytes?: number;
  maxCorrectionBytes?: number;
}

export interface CorrectionPlanArtifact extends PlanArtifactBase {
  cycle: number;
  metadata: CorrectionPlanMetadata;
}

export interface LoadCorrectionPlanOptions extends PlanArtifactStorageOptions {
  loopId: string;
  cycle: number;
  /** Optional controller safety bound for this correction cycle. */
  maxCycles?: number;
  /** The state-recorded path may be supplied, but is checked against the derived safe path. */
  path?: string;
  hash?: string;
  expectedHash?: string;
  correctionHash?: string;
  /** Required bounded limit in bytes. maxCorrectionBytes is an accepted alias. */
  maxBytes?: number;
  maxCorrectionBytes?: number;
}

function fail(code: PlanArtifactErrorCode, message: string): never {
  throw new PlanArtifactError(code, message);
}

function validateLoopId(loopId: unknown): asserts loopId is string {
  if (typeof loopId !== "string" || !SAFE_LOOP_ID.test(loopId) || loopId === "." || loopId === "..") {
    fail("INVALID_LOOP_ID", "Loop ID must be a safe, single path component.");
  }
}

function validateCycle(cycle: unknown, maxCycles?: unknown): asserts cycle is number {
  if (typeof cycle !== "number" || !Number.isSafeInteger(cycle) || cycle < 1 || cycle > MAX_CYCLE) {
    fail("INVALID_CYCLE", "Correction cycle must be a positive safe integer.");
  }
  if (maxCycles !== undefined
    && (typeof maxCycles !== "number" || !Number.isSafeInteger(maxCycles) || maxCycles < 1 || maxCycles > MAX_CYCLE)) {
    fail("INVALID_CYCLE", "Maximum correction cycle must be a positive safe integer.");
  }
  if (maxCycles !== undefined && cycle > maxCycles) {
    fail("INVALID_CYCLE", "Correction cycle exceeds the maximum cycle bound.");
  }
}

function validateTextPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    fail("INVALID_PATH", `${label} must be a non-empty path without NUL bytes.`);
  }
  return value;
}

function resolveLimit(values: readonly [string, number | undefined][], label: string): number {
  const supplied = values.filter((entry): entry is [string, number] => entry[1] !== undefined);
  if (supplied.length === 0) fail("INVALID_INPUT", `${label} is required.`);
  const first = supplied[0][1];
  if (supplied.some(([, value]) => value !== first)
    || !Number.isSafeInteger(first)
    || first < 1
    || first > MAX_PLAN_ARTIFACT_BYTES) {
    fail("INVALID_INPUT", `${label} must be a positive bounded byte limit (at most ${MAX_PLAN_ARTIFACT_BYTES}).`);
  }
  return first;
}

function validateHash(hash: unknown, label: string): asserts hash is string {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash)) {
    fail("INVALID_INPUT", `${label} must be a lowercase SHA-256 hash.`);
  }
}

function validateSourceKind(sourceKind: unknown): asserts sourceKind is ArtifactSourceKind {
  if (sourceKind !== "explicit" && sourceKind !== "approved") {
    fail("INVALID_INPUT", "An original artifact source kind must be explicit or approved.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function storageAgentDir(options: PlanArtifactStorageOptions): string {
  const value = options.agentDir ?? getAgentDir();
  if (typeof value !== "string" || value.trim() === "" || value.includes("\u0000")) {
    fail("INVALID_PATH", "Agent directory must be a non-empty path without NUL bytes.");
  }
  return resolve(value);
}

/** Return the lexical artifact directory for display or test setup. */
export function getGoalLoopArtifactDirectory(loopId: string, agentDir = getAgentDir()): string {
  validateLoopId(loopId);
  const root = resolve(agentDir);
  const directory = resolve(root, GOAL_LOOP_ARTIFACT_ROOT, loopId);
  if (!isWithin(root, directory)) fail("INVALID_PATH", "Loop artifact directory escapes the agent directory.");
  return directory;
}

async function ensureDirectory(path: string, mode: number, chmodExisting: boolean): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", `Symbolic-link directory is not allowed: ${path}`);
    if (!current.isDirectory()) fail("STORAGE_ERROR", `Artifact path is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await mkdir(path, { recursive: true, mode });
    } catch (mkdirError) {
      throw new PlanArtifactError("STORAGE_ERROR", `Unable to create artifact directory ${path}: ${String(mkdirError)}`);
    }
    const created = await lstat(path);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      fail("SYMLINK_NOT_ALLOWED", `Artifact directory was not created as a regular directory: ${path}`);
    }
  }
  if (chmodExisting) await chmod(path, mode);
}

async function prepareWritableStorage(options: PlanArtifactStorageOptions, loopId: string): Promise<string> {
  validateLoopId(loopId);
  const agentDir = storageAgentDir(options);
  await ensureDirectory(agentDir, 0o700, false);
  const root = resolve(agentDir, GOAL_LOOP_ARTIFACT_ROOT);
  if (!isWithin(agentDir, root)) fail("INVALID_PATH", "Artifact root escapes the agent directory.");
  await ensureDirectory(root, 0o700, true);
  const directory = resolve(root, loopId);
  if (!isWithin(root, directory)) fail("INVALID_PATH", "Loop artifact directory escapes the artifact root.");
  await ensureDirectory(directory, 0o700, true);
  return directory;
}

async function prepareExistingStorage(options: PlanArtifactStorageOptions, loopId: string): Promise<string> {
  validateLoopId(loopId);
  const agentDir = storageAgentDir(options);
  const agentStat = await lstat(agentDir).catch(() => undefined);
  if (!agentStat || !agentStat.isDirectory() || agentStat.isSymbolicLink()) {
    fail("ARTIFACT_NOT_FOUND", `Agent artifact directory is unavailable: ${agentDir}`);
  }
  const root = resolve(agentDir, GOAL_LOOP_ARTIFACT_ROOT);
  const rootStat = await lstat(root).catch(() => undefined);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("ARTIFACT_NOT_FOUND", `Goal-loop artifact root is unavailable: ${root}`);
  }
  const directory = resolve(root, loopId);
  if (!isWithin(root, directory)) fail("INVALID_PATH", "Loop artifact directory escapes the artifact root.");
  const directoryStat = await lstat(directory).catch(() => undefined);
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    fail("ARTIFACT_NOT_FOUND", `Loop artifact directory is unavailable: ${directory}`);
  }
  return realpath(directory);
}

async function readHandleBounded(handle: Awaited<ReturnType<typeof open>>, maxBytes: number, label: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total + 1));
    const result = await handle.read(chunk, 0, chunk.length, null);
    if (result.bytesRead === 0) break;
    total += result.bytesRead;
    chunks.push(chunk.subarray(0, result.bytesRead));
    if (total > maxBytes) fail("SIZE_LIMIT", `${label} exceeds the ${maxBytes}-byte limit.`);
  }
  return Buffer.concat(chunks, total);
}

async function readRegularFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  let entry;
  try {
    entry = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") fail("ARTIFACT_NOT_FOUND", `${label} does not exist: ${path}`);
    if (code === "EACCES" || code === "EPERM") fail("SOURCE_UNREADABLE", `${label} is not readable: ${path}`);
    throw new PlanArtifactError("STORAGE_ERROR", `Unable to inspect ${label}: ${String(error)}`);
  }
  if (entry.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", `Symbolic links are not allowed: ${path}`);
  if (!entry.isFile()) fail("ARTIFACT_NOT_REGULAR", `${label} is not a regular file: ${path}`);

  let file;
  try {
    file = await open(path, READ_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") fail("ARTIFACT_NOT_FOUND", `${label} does not exist: ${path}`);
    if (code === "EACCES" || code === "EPERM") fail("SOURCE_UNREADABLE", `${label} is not readable: ${path}`);
    if (code === "ELOOP") fail("SYMLINK_NOT_ALLOWED", `Symbolic links are not allowed: ${path}`);
    throw new PlanArtifactError("STORAGE_ERROR", `Unable to open ${label}: ${String(error)}`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) fail("ARTIFACT_NOT_REGULAR", `${label} is not a regular file: ${path}`);
    if (info.size > maxBytes) fail("SIZE_LIMIT", `${label} exceeds the ${maxBytes}-byte limit.`);
    return await readHandleBounded(file, maxBytes, label);
  } finally {
    await file.close();
  }
}

async function readSourceFile(path: string, maxBytes: number): Promise<{ path: string; bytes: Buffer }> {
  let sourceStat;
  try {
    sourceStat = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") {
      fail("SOURCE_UNREADABLE", `Plan source is not readable: ${path}`);
    }
    throw error;
  }
  if (sourceStat.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", `Plan source may not be a symbolic link: ${path}`);
  if (!sourceStat.isFile()) fail("SOURCE_NOT_REGULAR", `Plan source is not a regular file: ${path}`);

  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch (error) {
    fail("SOURCE_UNREADABLE", `Unable to canonicalize plan source ${path}: ${String(error)}`);
  }
  const canonicalStat = await lstat(canonical);
  if (canonicalStat.isSymbolicLink()) fail("SYMLINK_NOT_ALLOWED", `Plan source may not be a symbolic link: ${path}`);
  if (!canonicalStat.isFile()) fail("SOURCE_NOT_REGULAR", `Plan source is not a regular file: ${path}`);

  // Read through the caller's path with O_NOFOLLOW as well as recording its
  // canonical path. This closes the replacement race between lstat/realpath
  // and the actual copy while still allowing harmless parent-path aliases.
  const bytes = await readRegularFile(path, maxBytes, "Plan source");
  return { path: canonical, bytes };
}

async function writeExclusive(path: string, bytes: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temporary, 0o600);
    try {
      // link(2) is an atomic no-replace publication on the supported Unix
      // filesystems. Unlike rename(), it can never clobber an existing plan.
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PlanArtifactError("ARTIFACT_EXISTS", `Artifact already exists: ${path}`);
      }
      throw new PlanArtifactError("STORAGE_ERROR", `Unable to publish artifact ${path}: ${String(error)}`);
    }
    await rm(temporary, { force: true });
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function publishArtifact(directory: string, filename: string, bytes: Buffer): Promise<PlanArtifactBase> {
  const path = resolve(directory, filename);
  if (!isWithin(directory, path) || path !== join(directory, filename)) {
    fail("INVALID_PATH", "Artifact path escapes its loop directory.");
  }
  await writeExclusive(path, bytes);
  const canonical = await realpath(path);
  return {
    path: canonical,
    hash: createHash("sha256").update(bytes).digest("hex"),
    content: bytes.toString("utf8"),
    sizeBytes: bytes.byteLength,
  };
}

async function expectedArtifactPath(
  directory: string,
  filename: string,
  suppliedPath: string | undefined,
): Promise<string> {
  const expected = join(directory, filename);
  if (suppliedPath !== undefined) {
    validateTextPath(suppliedPath, "Artifact path");
    const candidate = resolve(suppliedPath);
    if (!isWithin(directory, candidate) || candidate !== expected) {
      fail("INVALID_PATH", "Artifact path does not match the loop-owned artifact.");
    }
  }
  return expected;
}

/**
 * Copy and hash an explicit or approved source exactly once into the private
 * loop directory. The source is never used again for verification.
 */
export async function snapshotOriginalPlan(options: OriginalPlanSnapshotOptions): Promise<OriginalPlanSnapshot> {
  const sourcePathInput = options.sourcePath ?? options.planPath;
  if (options.sourcePath !== undefined && options.planPath !== undefined && options.sourcePath !== options.planPath) {
    fail("INVALID_INPUT", "sourcePath and planPath must not disagree.");
  }
  const sourceInput = validateTextPath(sourcePathInput, "Plan source path");
  if (typeof options.cwd !== "string" || options.cwd.trim() === "" || options.cwd.includes("\u0000")) {
    fail("INVALID_PATH", "Working directory must be a non-empty path without NUL bytes.");
  }
  const sourceKind = options.sourceKind ?? "explicit";
  validateSourceKind(sourceKind);
  const maxBytes = resolveLimit([
    ["maxBytes", options.maxBytes],
    ["maxPlanBytes", options.maxPlanBytes],
  ], "maxBytes");

  const sourcePath = await readSourceFile(
    isAbsolute(sourceInput) ? resolve(sourceInput) : resolve(options.cwd, sourceInput),
    maxBytes,
  );
  const directory = await prepareWritableStorage(options, options.loopId);
  const artifact = await publishArtifact(directory, ORIGINAL_PLAN_FILENAME, sourcePath.bytes);
  const provenance: GoalPlanProvenance = {
    sourceKind,
    sourcePath: sourcePath.path,
    snapshotPath: artifact.path,
    snapshotHash: artifact.hash,
  };
  return {
    ...artifact,
    sourcePath: sourcePath.path,
    sourceKind,
    provenance,
  };
}

/** Verify the immutable original without consulting its mutable source path. */
export async function loadVerifiedOriginalPlan(options: LoadOriginalPlanOptions): Promise<OriginalPlanSnapshot> {
  const maxBytes = resolveLimit([
    ["maxBytes", options.maxBytes],
    ["maxPlanBytes", options.maxPlanBytes],
  ], "maxBytes");
  const provenance = options.provenance;
  if (!provenance || typeof provenance !== "object") fail("INVALID_INPUT", "Original plan provenance is required.");
  validateSourceKind(provenance.sourceKind);
  const sourcePath = validateTextPath(provenance.sourcePath, "Provenance source path");
  const snapshotPath = validateTextPath(provenance.snapshotPath, "Provenance snapshot path");
  validateHash(provenance.snapshotHash, "Provenance snapshot hash");

  const directory = await prepareExistingStorage(options, options.loopId);
  const path = await expectedArtifactPath(directory, ORIGINAL_PLAN_FILENAME, snapshotPath);
  const bytes = await readRegularFile(path, maxBytes, "Immutable original plan");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== provenance.snapshotHash) {
    fail("HASH_MISMATCH", `Immutable original plan hash mismatch: ${path}`);
  }
  const artifact: PlanArtifactBase = {
    path: await realpath(path),
    hash,
    content: bytes.toString("utf8"),
    sizeBytes: bytes.byteLength,
  };
  return {
    ...artifact,
    sourcePath,
    sourceKind: provenance.sourceKind,
    provenance: { ...provenance, snapshotPath: artifact.path, snapshotHash: hash },
  };
}

/** Store one non-empty corrective plan under its safe cycle-specific filename. */
export async function persistCorrectionPlan(options: PersistCorrectionPlanOptions): Promise<CorrectionPlanArtifact> {
  validateCycle(options.cycle, options.maxCycles);
  const contentAliases = [options.content, options.plan, options.correction].filter(
    (value): value is string => value !== undefined,
  );
  if (contentAliases.some((value) => value !== contentAliases[0])) {
    fail("INVALID_INPUT", "Correction content aliases must not disagree.");
  }
  const content = contentAliases[0];
  if (typeof content !== "string" || content.trim() === "") {
    fail("INVALID_INPUT", "Corrective plan content must be non-empty.");
  }
  const maxBytes = resolveLimit([
    ["maxBytes", options.maxBytes],
    ["maxCorrectionBytes", options.maxCorrectionBytes],
  ], "maxBytes");
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength > maxBytes) fail("SIZE_LIMIT", `Corrective plan exceeds the ${maxBytes}-byte limit.`);

  const directory = await prepareWritableStorage(options, options.loopId);
  const artifact = await publishArtifact(directory, CORRECTION_PLAN_FILENAME(options.cycle), bytes);
  const metadata: CorrectionPlanMetadata = {
    cycle: options.cycle,
    path: artifact.path,
    hash: artifact.hash,
    sizeBytes: artifact.sizeBytes,
  };
  return { ...artifact, cycle: options.cycle, metadata };
}

/** Load and hash-check a corrective plan without trusting a caller path. */
export async function loadVerifiedCorrectionPlan(options: LoadCorrectionPlanOptions): Promise<CorrectionPlanArtifact> {
  validateCycle(options.cycle, options.maxCycles);
  const maxBytes = resolveLimit([
    ["maxBytes", options.maxBytes],
    ["maxCorrectionBytes", options.maxCorrectionBytes],
  ], "maxBytes");
  const hashes = [options.hash, options.expectedHash, options.correctionHash].filter((value): value is string => value !== undefined);
  if (hashes.length === 0) fail("INVALID_INPUT", "A corrective plan hash is required.");
  if (hashes.some((hash) => hash !== hashes[0])) fail("INVALID_INPUT", "Corrective plan hash aliases must not disagree.");
  validateHash(hashes[0], "Corrective plan hash");

  const directory = await prepareExistingStorage(options, options.loopId);
  const path = await expectedArtifactPath(directory, CORRECTION_PLAN_FILENAME(options.cycle), options.path);
  const bytes = await readRegularFile(path, maxBytes, "Corrective plan");
  if (bytes.byteLength === 0 || bytes.toString("utf8").trim() === "") {
    fail("INVALID_INPUT", "Corrective plan content must be non-empty.");
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== hashes[0]) fail("HASH_MISMATCH", `Corrective plan hash mismatch: ${path}`);
  const artifactPath = await realpath(path);
  const metadata: CorrectionPlanMetadata = {
    cycle: options.cycle,
    path: artifactPath,
    hash,
    sizeBytes: bytes.byteLength,
  };
  return {
    path: artifactPath,
    hash,
    content: bytes.toString("utf8"),
    sizeBytes: bytes.byteLength,
    cycle: options.cycle,
    metadata,
  };
}

// Descriptive aliases keep the small API convenient for controller call sites.
export const createOriginalPlanSnapshot = snapshotOriginalPlan;
export const createPlanSnapshot = snapshotOriginalPlan;
export const loadOriginalPlan = loadVerifiedOriginalPlan;
export const verifyOriginalPlan = loadVerifiedOriginalPlan;
export const storeCorrectionPlan = persistCorrectionPlan;
export const saveCorrectionPlan = persistCorrectionPlan;
export const loadCorrectionPlan = loadVerifiedCorrectionPlan;
export const verifyCorrectionPlan = loadVerifiedCorrectionPlan;
