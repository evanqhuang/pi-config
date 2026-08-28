/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * A normal worktree is finalized by committing its changes to a branch.  A
 * disposable worktree is a throw-away view: it can be overlaid with the
 * source checkout's uncommitted state, but is never staged, committed, or
 * branched when it is cleaned up.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorktreeReport } from "./types.js";

const GIT_TIMEOUT = 30_000;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** How a worktree is finalized after the agent exits. */
export type WorktreeFinalization = "commit" | "discard";

/** Options for creating a worktree. */
export interface WorktreeOptions {
  /** Defaults to `"commit"`, preserving the original worktree behavior. */
  finalization?: WorktreeFinalization;
  /** Overlay HEAD with the source checkout's tracked and untracked changes. */
  snapshotSource?: boolean;
}

export interface WorktreeSourceMetadata {
  /** The source cwd supplied to createWorktree, resolved through symlinks. */
  cwd: string;
  /** The source repository root. */
  root: string;
  /** Alias for `root`, useful to consumers that call this the source path. */
  path: string;
  /** HEAD from which both worktrees were created. */
  baseSha: string;
}

export interface WorktreeSnapshotMetadata {
  /** Source cwd whose state was overlaid. */
  sourcePath: string;
  /** Source repository root whose state was overlaid. */
  sourceRoot: string;
  /** Disposable or worktree target receiving the overlay. */
  targetPath: string;
  baseSha: string;
  /** SHA-256 of the raw `git diff --binary HEAD` payload. */
  trackedDiffSha256: string;
  trackedDiffBytes: number;
  trackedPaths: string[];
  untrackedPaths: string[];
  untrackedBytes: number;
  /** True only after all paths were copied and verified. */
  complete: boolean;
}

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /**
   * Candidate branch name for ordinary finalization. Disposable worktrees
   * retain this legacy field for structural compatibility, but never create it.
   */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper.
   */
  workPath: string;
  /** Finalization requested for this worktree. Omitted on legacy hand-built values. */
  finalization?: WorktreeFinalization;
  /** Source metadata captured at creation time. */
  source?: WorktreeSourceMetadata;
  /** Overlay metadata, when source snapshotting was requested. */
  snapshot?: WorktreeSnapshotMetadata;
}

export type WorktreeCreationErrorCode =
  | "not-git-repository"
  | "no-commit"
  | "invalid-source"
  | "worktree-add-failed"
  | "snapshot-failed";

/** A creation failure that a manager can report instead of falling back to cwd. */
export class WorktreeCreationError extends Error {
  readonly code: WorktreeCreationErrorCode;
  readonly cwd: string;
  readonly finalization: WorktreeFinalization;
  readonly worktreePath?: string;

  constructor(
    code: WorktreeCreationErrorCode,
    message: string,
    details: {
      cwd: string;
      finalization: WorktreeFinalization;
      worktreePath?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: details.cause });
    this.name = "WorktreeCreationError";
    this.code = code;
    this.cwd = details.cwd;
    this.finalization = details.finalization;
    this.worktreePath = details.worktreePath;
  }
}

export class WorktreeCleanupError extends Error {
  readonly cwd: string;
  readonly worktreePath: string;

  constructor(message: string, cwd: string, worktreePath: string, cause?: unknown) {
    super(message, { cause });
    this.name = "WorktreeCleanupError";
    this.cwd = cwd;
    this.worktreePath = worktreePath;
  }
}

/**
 * Project-wide switch for worktree isolation (`worktreeIsolation` in
 * subagents.json). Default `true` — unchanged behavior.
 */
let worktreeIsolationEnabled = true;

export function setWorktreeIsolationEnabled(enabled: boolean): void {
  worktreeIsolationEnabled = enabled;
}

export function isWorktreeIsolationEnabled(): boolean {
  return worktreeIsolationEnabled;
}

export interface WorktreeCleanupResult {
  /** Finalization strategy actually used for this cleanup. */
  finalization?: WorktreeFinalization;
  /** Whether changes were found in the worktree. */
  hasChanges: boolean;
  /** Branch name if changes were committed. */
  branch?: string;
  /** Worktree path if it was kept. */
  path?: string;
  /** Present for disposable cleanup; no branch was created. */
  discarded?: boolean;
  source?: WorktreeSourceMetadata;
  snapshot?: WorktreeSnapshotMetadata;
}

/** Compatibility spelling for consumers that refer to this as CleanupResult. */
export type CleanupResult = WorktreeCleanupResult;

const MAX_REPORTED_PATHS = 128;
const MAX_REPORTED_PATH_LENGTH = 512;

function boundedReportPath(pathName: string): string {
  return pathName.length <= MAX_REPORTED_PATH_LENGTH
    ? pathName
    : `${pathName.slice(0, MAX_REPORTED_PATH_LENGTH - 1)}…`;
}

function boundedReportPaths(paths: string[]): { paths: string[]; truncated: boolean } {
  const truncated = paths.length > MAX_REPORTED_PATHS
    || paths.some(pathName => pathName.length > MAX_REPORTED_PATH_LENGTH);
  return {
    paths: paths.slice(0, MAX_REPORTED_PATHS).map(boundedReportPath),
    truncated,
  };
}

/**
 * Project full in-memory worktree metadata into a bounded, safe report. The
 * live AgentRecord keeps the actual WorktreeInfo/CleanupResult, while emitted
 * and persisted records use this projection so a patch or copied content can
 * never leak into lifecycle/history data.
 */
export function toWorktreeReport(
  worktree?: WorktreeInfo,
  result?: WorktreeCleanupResult,
): WorktreeReport | undefined {
  if (!worktree && !result) return undefined;
  const source = worktree?.source ?? result?.source;
  const snapshot = worktree?.snapshot ?? result?.snapshot;
  const tracked = snapshot ? boundedReportPaths(snapshot.trackedPaths) : undefined;
  const untracked = snapshot ? boundedReportPaths(snapshot.untrackedPaths) : undefined;
  const report: WorktreeReport = {};
  const path = worktree?.path ?? result?.path;
  const baseSha = worktree?.baseSha ?? source?.baseSha ?? snapshot?.baseSha;
  const finalization = worktree?.finalization
    ?? result?.finalization
    ?? (result?.discarded ? "discard" : result?.branch ? "commit" : undefined);
  const branch = result?.branch ?? worktree?.branch;
  if (path !== undefined) report.path = boundedReportPath(path);
  if (worktree?.workPath !== undefined) report.workPath = boundedReportPath(worktree.workPath);
  if (branch !== undefined) report.branch = boundedReportPath(branch);
  if (baseSha !== undefined) report.baseSha = baseSha;
  if (finalization !== undefined) report.finalization = finalization;
  if (result?.hasChanges !== undefined) report.hasChanges = result.hasChanges;
  if (result?.discarded !== undefined) report.discarded = result.discarded;
  if (source) {
    report.source = {
      cwd: boundedReportPath(source.cwd),
      root: boundedReportPath(source.root),
      path: boundedReportPath(source.path),
      baseSha: source.baseSha,
    };
  }
  if (snapshot && tracked && untracked) {
    report.snapshot = {
      sourcePath: boundedReportPath(snapshot.sourcePath),
      sourceRoot: boundedReportPath(snapshot.sourceRoot),
      targetPath: boundedReportPath(snapshot.targetPath),
      baseSha: snapshot.baseSha,
      trackedDiffSha256: snapshot.trackedDiffSha256,
      trackedDiffBytes: snapshot.trackedDiffBytes,
      trackedPaths: tracked.paths,
      untrackedPaths: untracked.paths,
      trackedPathCount: snapshot.trackedPaths.length,
      untrackedPathCount: snapshot.untrackedPaths.length,
      untrackedBytes: snapshot.untrackedBytes,
      truncatedPaths: tracked.truncated || untracked.truncated,
      complete: snapshot.complete,
    };
  }
  return report;
}

interface RepositoryInfo {
  baseSha: string;
  root: string;
  subdir: string;
  sourceCwd: string;
}

interface SourceEntryState {
  kind: "file" | "symlink";
  size: number;
  mode: number;
  mtimeNs: string;
  dev: string;
  ino: string;
  /** Content identity is required in addition to stat metadata: a same-inode
   * overwrite can preserve size, mode, and even timestamps. */
  contentSha256?: string;
  linkTarget?: string;
}

interface SourceSnapshotCapture {
  patch: Buffer;
  trackedPaths: string[];
  untrackedPaths: string[];
  untrackedStates: Map<string, SourceEntryState>;
  untrackedBytes: number;
}

function gitOutput(cwd: string, args: string[], timeout = GIT_TIMEOUT): Buffer {
  return execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    timeout,
    maxBuffer: GIT_MAX_BUFFER,
  }) as Buffer;
}

function normalizeOptions(options: WorktreeOptions | undefined): {
  finalization: WorktreeFinalization;
  snapshotSource: boolean;
} {
  const finalization = options?.finalization ?? "commit";
  const snapshotSource = options?.snapshotSource ?? finalization === "discard";
  return { finalization, snapshotSource };
}

function creationFailure(
  finalization: WorktreeFinalization,
  cwd: string,
  code: WorktreeCreationErrorCode,
  message: string,
  cause?: unknown,
  worktreePath?: string,
): undefined {
  if (finalization === "discard") {
    throw new WorktreeCreationError(code, message, { cwd, finalization, worktreePath, cause });
  }
  return undefined;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function decodeGitPath(raw: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch (error) {
    throw new Error("Git returned a path that is not valid UTF-8", { cause: error });
  }
  if (!decoded || decoded.includes("\0")) throw new Error("Git returned an empty or NUL-containing path");
  // Git uses / in path names on every platform. Reject backslashes too so a
  // snapshot made on POSIX cannot become an escaping path on Windows.
  if (decoded.startsWith("/") || decoded.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(decoded)) {
    throw new Error(`Unsafe absolute snapshot path: ${JSON.stringify(decoded)}`);
  }
  const pieces = decoded.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === ".." || piece.includes("\\"))) {
    throw new Error(`Unsafe snapshot path: ${JSON.stringify(decoded)}`);
  }
  return decoded;
}

function parseNulPaths(output: Buffer): string[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) throw new Error("Incomplete NUL-delimited Git path output");
  const paths: string[] = [];
  let start = 0;
  for (let end = 0; end < output.length; end += 1) {
    if (output[end] !== 0) continue;
    const path = decodeGitPath(output.subarray(start, end));
    paths.push(path);
    start = end + 1;
  }
  return paths;
}

function lexicalPath(root: string, pathName: string): string {
  const absolute = resolve(root, ...pathName.split("/"));
  if (!isWithin(root, absolute)) throw new Error(`Snapshot path escapes repository: ${pathName}`);
  return absolute;
}

function safeRealpath(root: string, absolute: string, label: string): string {
  // /var is commonly a symlink to /private/var on macOS. Resolve the root
  // independently so a harmless spelling difference is not mistaken for an
  // escape.
  const rootResolved = realpathSync(root);
  const resolved = realpathSync(absolute);
  if (!isWithin(rootResolved, resolved)) throw new Error(`Symlink escape in ${label}`);
  return resolved;
}

function inspectSourceEntry(root: string, pathName: string, allowMissing: boolean): SourceEntryState | undefined {
  const absolute = lexicalPath(root, pathName);
  let stat;
  try {
    stat = lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      // A deleted tracked path is valid. Validate its parent so `a/../b` or
      // a symlinked parent cannot turn a deletion into an outside path.
      safeRealpath(root, dirname(absolute), pathName);
      return undefined;
    }
    throw error;
  }

  if (stat.isSymbolicLink()) {
    const linkTarget = readlinkSync(absolute);
    if (isAbsolute(linkTarget) || /^[A-Za-z]:[\\/]/.test(linkTarget) || linkTarget.startsWith("\\")) {
      throw new Error(`Absolute symlink in snapshot path: ${pathName}`);
    }
    safeRealpath(root, absolute, pathName);
    return {
      kind: "symlink",
      size: 0,
      mode: Number(stat.mode),
      mtimeNs: stat.mtimeNs.toString(),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      linkTarget,
    };
  }

  if (!stat.isFile()) throw new Error(`Unsupported non-file snapshot entry: ${pathName}`);
  safeRealpath(root, absolute, pathName);
  const contentSha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
  return {
    kind: "file",
    size: Number(stat.size),
    mode: Number(stat.mode),
    mtimeNs: stat.mtimeNs.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    contentSha256,
  };
}

function entrySignature(entry: SourceEntryState): string {
  return [
    entry.kind,
    entry.size,
    entry.mode,
    entry.mtimeNs,
    entry.dev,
    entry.ino,
    entry.contentSha256 ?? "",
    entry.linkTarget ?? "",
  ].join(":");
}

function sameUntrackedStates(
  left: Map<string, SourceEntryState>,
  right: Map<string, SourceEntryState>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [pathName, state] of left) {
    const other = right.get(pathName);
    if (!other || entrySignature(state) !== entrySignature(other)) return false;
  }
  return true;
}

function samePathList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((pathName, index) => pathName === right[index]);
}

function captureSourceSnapshot(root: string, baseSha: string): SourceSnapshotCapture {
  const patch = gitOutput(root, ["diff", "--binary", "--full-index", baseSha, "--"], 60_000);
  const trackedPaths = parseNulPaths(gitOutput(root, ["diff", "--name-only", "-z", baseSha, "--"]));
  const untrackedPaths = parseNulPaths(gitOutput(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const allPaths = [...trackedPaths, ...untrackedPaths];
  if (new Set(allPaths).size !== allPaths.length) throw new Error("Duplicate path in source snapshot");

  // Validate every path before creating the target. This includes deleted
  // tracked paths (whose parent still has to remain inside the source root).
  for (const pathName of trackedPaths) inspectSourceEntry(root, pathName, true);
  const untrackedStates = new Map<string, SourceEntryState>();
  let untrackedBytes = 0;
  for (const pathName of untrackedPaths) {
    const state = inspectSourceEntry(root, pathName, false);
    if (!state) throw new Error(`Untracked snapshot entry disappeared: ${pathName}`);
    untrackedStates.set(pathName, state);
    untrackedBytes += state.size;
  }
  return { patch, trackedPaths, untrackedPaths, untrackedStates, untrackedBytes };
}

function assertSafeTargetParent(root: string, parent: string): void {
  const rootLexical = resolve(root);
  const rootResolved = realpathSync(root);
  const parentLexical = resolve(parent);
  if (!isWithin(rootLexical, parentLexical)) throw new Error(`Snapshot parent escapes worktree: ${parent}`);
  const pieces = relative(rootLexical, parentLexical).split(sep).filter(Boolean);
  let current = rootLexical;
  for (const piece of pieces) {
    current = join(current, piece);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        safeRealpath(rootResolved, current, current);
      } else if (!stat.isDirectory()) {
        throw new Error(`Snapshot parent is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current);
    }
  }
}

function copyUntrackedEntry(
  sourceRoot: string,
  targetRoot: string,
  pathName: string,
  expected: SourceEntryState,
): void {
  const sourcePath = lexicalPath(sourceRoot, pathName);
  const targetPath = lexicalPath(targetRoot, pathName);
  const sourceBefore = inspectSourceEntry(sourceRoot, pathName, false);
  if (!sourceBefore || entrySignature(sourceBefore) !== entrySignature(expected)) {
    throw new Error(`Source changed while snapshotting: ${pathName}`);
  }
  assertSafeTargetParent(targetRoot, dirname(targetPath));
  try {
    lstatSync(targetPath);
    throw new Error(`Snapshot target already contains untracked path: ${pathName}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (expected.kind === "symlink") {
    symlinkSync(expected.linkTarget!, targetPath);
  } else {
    const bytes = readFileSync(sourcePath);
    writeFileSync(targetPath, bytes, { flag: "wx", mode: expected.mode & 0o7777 });
    chmodSync(targetPath, expected.mode & 0o7777);
  }

  const sourceAfter = inspectSourceEntry(sourceRoot, pathName, false);
  if (!sourceAfter || entrySignature(sourceAfter) !== entrySignature(expected)) {
    throw new Error(`Source changed while snapshotting: ${pathName}`);
  }
}

function validateTargetTree(root: string): void {
  const rootResolved = realpathSync(root);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // A worktree's .git is an administrative file. It is not part of the
      // source snapshot and may contain paths outside the worktree by design.
      if (directory === rootResolved && entry.name === ".git") continue;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith("\\")) {
          throw new Error(`Absolute target symlink in worktree: ${absolute}`);
        }
        safeRealpath(rootResolved, absolute, absolute);
      } else if (entry.isDirectory()) {
        visit(absolute);
      }
    }
  };
  visit(rootResolved);
}

function assertEntriesMatch(sourceRoot: string, targetRoot: string, pathName: string): void {
  const source = inspectSourceEntry(sourceRoot, pathName, true);
  const targetPath = lexicalPath(targetRoot, pathName);
  let target: SourceEntryState | undefined;
  try {
    // The target has the same path rules as the source; this also validates a
    // target-side symlink before its contents are compared.
    target = inspectSourceEntry(targetRoot, pathName, true);
  } catch (error) {
    throw new Error(`Unsafe target snapshot path: ${pathName}`, { cause: error });
  }
  if (!source) {
    if (target) throw new Error(`Deleted source path remains in snapshot: ${pathName}`);
    return;
  }
  if (!target || source.kind !== target.kind) throw new Error(`Incomplete snapshot at ${pathName}`);
  if (source.kind === "symlink") {
    if (source.linkTarget !== target.linkTarget) throw new Error(`Symlink snapshot mismatch at ${pathName}`);
    return;
  }
  if ((source.mode & 0o7777) !== (target.mode & 0o7777)) {
    throw new Error(`File mode snapshot mismatch at ${pathName}`);
  }
  if (!readFileSync(lexicalPath(sourceRoot, pathName)).equals(readFileSync(targetPath))) {
    throw new Error(`Binary or text snapshot mismatch at ${pathName}`);
  }
}

function verifySnapshotOverlay(
  sourceRoot: string,
  targetRoot: string,
  capture: SourceSnapshotCapture,
): void {
  for (const pathName of capture.trackedPaths) assertEntriesMatch(sourceRoot, targetRoot, pathName);
  for (const pathName of capture.untrackedPaths) assertEntriesMatch(sourceRoot, targetRoot, pathName);
  validateTargetTree(targetRoot);
}

function snapshotMetadata(
  source: WorktreeSourceMetadata,
  targetPath: string,
  capture: SourceSnapshotCapture,
): WorktreeSnapshotMetadata {
  return {
    sourcePath: source.cwd,
    sourceRoot: source.root,
    targetPath,
    baseSha: source.baseSha,
    trackedDiffSha256: createHash("sha256").update(capture.patch).digest("hex"),
    trackedDiffBytes: capture.patch.length,
    trackedPaths: [...capture.trackedPaths],
    untrackedPaths: [...capture.untrackedPaths],
    untrackedBytes: capture.untrackedBytes,
    complete: true,
  };
}

function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch {
    // Git may refuse an already partially removed worktree. Do not leave its
    // files around, but only use the filesystem fallback for paths generated
    // below tmpdir; cleanupWorktree accepts public data structures too.
    if (isWithin(resolve(tmpdir()), resolve(worktreePath))) {
      try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  } finally {
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5_000 });
    } catch { /* best effort */ }
  }
}

/**
 * Create a temporary git worktree for an agent.
 *
 * Ordinary creation retains the historical `undefined` failure result. A
 * disposable request is explicit and required, so every failure throws
 * WorktreeCreationError instead of allowing a caller to run in the source cwd.
 */
export function createWorktree(
  cwd: string,
  agentId: string,
  options?: WorktreeOptions,
): WorktreeInfo | undefined {
  const { finalization, snapshotSource } = normalizeOptions(options);
  let repository: RepositoryInfo;
  try {
    const inside = gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"], 5_000).toString().trim();
    if (inside !== "true") throw new Error("Not inside a Git worktree");
  } catch (error) {
    return creationFailure(finalization, cwd, "not-git-repository", "Cannot create worktree: cwd is not a Git repository", error);
  }

  try {
    const baseSha = gitOutput(cwd, ["rev-parse", "HEAD"], 5_000).toString().trim();
    const root = realpathSync(gitOutput(cwd, ["rev-parse", "--show-toplevel"], 5_000).toString().trim());
    const sourceCwd = realpathSync(cwd);
    const subdir = relative(root, sourceCwd);
    if (!isWithin(root, sourceCwd)) throw new Error("cwd is outside the Git repository root");
    repository = { baseSha, root, subdir, sourceCwd };
  } catch (error) {
    const code = (error instanceof Error && /HEAD|ambiguous|unknown revision/i.test(error.message)) ? "no-commit" : "invalid-source";
    return creationFailure(finalization, cwd, code, "Cannot create worktree: source repository has no usable HEAD or path", error);
  }

  const source: WorktreeSourceMetadata = {
    cwd: repository.sourceCwd,
    root: repository.root,
    path: repository.sourceCwd,
    baseSha: repository.baseSha,
  };
  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);
  let capture: SourceSnapshotCapture | undefined;
  let worktreeAdded = false;

  try {
    if (snapshotSource) capture = captureSourceSnapshot(repository.root, repository.baseSha);

    // Always start at detached HEAD. Disposable cleanup never creates a
    // branch, and ordinary cleanup creates one only after a change is found.
    gitOutput(cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    worktreeAdded = true;

    // Disposable worktrees must not expose a source-escaping tracked symlink,
    // even when a caller explicitly disables source-change overlay.
    if (finalization === "discard") validateTargetTree(worktreePath);

    if (capture) {
      if (capture.patch.length > 0) {
        execFileSync("git", ["apply", "--binary", "--whitespace=nowarn"], {
          cwd: worktreePath,
          input: capture.patch,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60_000,
          maxBuffer: GIT_MAX_BUFFER,
        });
      }
      for (const pathName of capture.untrackedPaths) {
        copyUntrackedEntry(repository.root, worktreePath, pathName, capture.untrackedStates.get(pathName)!);
      }
      verifySnapshotOverlay(repository.root, worktreePath, capture);

      // Re-read the source after applying/copying. A changed source means the
      // target is not a coherent snapshot, so fail rather than hand an agent
      // an incomplete view.
      const after = captureSourceSnapshot(repository.root, repository.baseSha);
      if (!after.patch.equals(capture.patch)
        || !samePathList(after.trackedPaths, capture.trackedPaths)
        || !samePathList(after.untrackedPaths, capture.untrackedPaths)
        || !sameUntrackedStates(after.untrackedStates, capture.untrackedStates)) {
        throw new Error("Source changed while creating snapshot; snapshot is incomplete");
      }
    }

    const info: WorktreeInfo = {
      path: worktreePath,
      branch,
      baseSha: repository.baseSha,
      workPath: repository.subdir ? join(worktreePath, repository.subdir) : worktreePath,
      finalization,
      source,
      snapshot: capture ? snapshotMetadata(source, worktreePath, capture) : undefined,
    };
    return info;
  } catch (error) {
    removeWorktree(cwd, worktreePath);
    const snapshotFailed = snapshotSource || (worktreeAdded && finalization === "discard");
    const code: WorktreeCreationErrorCode = snapshotFailed ? "snapshot-failed" : "worktree-add-failed";
    return creationFailure(
      finalization,
      cwd,
      code,
      snapshotFailed
        ? "Cannot create disposable worktree: source snapshot overlay or validation failed"
        : "Cannot create worktree: git worktree add failed",
      error,
      worktreePath,
    );
  }
}

interface WorktreeState {
  dirty: boolean;
  headChanged: boolean;
  hasChanges: boolean;
}

function inspectWorktree(worktreePath: string, baseSha: string): WorktreeState {
  const status = gitOutput(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"], 10_000);
  const dirty = status.length > 0;
  const currentSha = gitOutput(worktreePath, ["rev-parse", "HEAD"], 5_000).toString().trim();
  const headChanged = currentSha !== baseSha;
  return { dirty, headChanged, hasChanges: dirty || headChanged };
}

/**
 * Clean up a worktree after agent completion.
 *
 * Disposable worktrees are observed, then always force-removed and pruned.
 * They are never staged, committed, or branched, including when the agent
 * made an internal commit.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
  options?: Pick<WorktreeOptions, "finalization">,
): WorktreeCleanupResult {
  // The explicit override lets a manager carry lifecycle policy beside its
  // WorktreeInfo. Normally creation stores it on the info.
  const finalization = options?.finalization ?? worktree.finalization ?? "commit";
  if (finalization === "discard") {
    let hasChanges = false;
    let observationError: unknown;
    try {
      if (existsSync(worktree.path)) hasChanges = inspectWorktree(worktree.path, worktree.baseSha).hasChanges;
    } catch (error) {
      observationError = error;
    } finally {
      // This is deliberately unconditional: no status/commit outcome may
      // strand a disposable worktree or its Git administrative record.
      removeWorktree(cwd, worktree.path);
    }
    if (observationError) {
      throw new WorktreeCleanupError(
        "Could not inspect disposable worktree before cleanup",
        cwd,
        worktree.path,
        observationError,
      );
    }
    return {
      finalization,
      hasChanges,
      discarded: true,
      source: worktree.source,
      snapshot: worktree.snapshot,
    };
  }

  if (!existsSync(worktree.path)) return { hasChanges: false };

  try {
    const state = inspectWorktree(worktree.path, worktree.baseSha);
    if (state.dirty) {
      // Ordinary finalization must run repository hooks and other commit checks.
      // Do not add --no-verify: a failed hook must leave the worktree available
      // for the caller to fix and retry.
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10_000 });
      const safeDesc = agentDescription.slice(0, 200);
      execFileSync("git", ["commit", "-m", `pi-agent: ${safeDesc}`], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10_000,
      });
    } else if (!state.headChanged) {
      removeWorktree(cwd, worktree.path);
      return { hasChanges: false };
    }

    let branchName = worktree.branch;
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5_000,
      });
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5_000,
      });
    }
    worktree.branch = branchName;
    removeWorktree(cwd, worktree.path);
    return { hasChanges: true, branch: worktree.branch, path: worktree.path };
  } catch (error) {
    // Never remove an ordinary worktree after a failed commit, hook, or branch
    // operation. Its path is part of the error so the caller can recover the
    // dirty worktree instead of being told that no changes existed.
    const detail = error instanceof Error ? `: ${error.message}` : `: ${String(error)}`;
    throw new WorktreeCleanupError(
      `Could not finalize ordinary worktree${detail}; changes preserved at ${worktree.path}`,
      cwd,
      worktree.path,
      error,
    );
  }
}

/** Prune any orphaned worktrees (crash recovery). */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5_000 });
  } catch { /* ignore */ }
}
