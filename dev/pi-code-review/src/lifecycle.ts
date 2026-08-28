import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runCodeReview } from "./pipeline.js";
import { captureReviewSnapshot } from "./targets.js";
import type { ReviewEffort } from "./effort.js";
import type {
  CommandRunner,
  FindingLedgerEntry,
  FindingLedgerStatus,
  ReviewContract,
  ReviewDecision,
  ReviewDependencies,
  ReviewLedgerSummary,
  ReviewOptions,
  ReviewPhase,
  ReviewResult,
  ReviewSnapshot,
  ReviewTarget,
  VerifiedFinding,
} from "./types.js";

const VERSION = 1;
const MAX_PASSES = 3;
const MAX_REMEDIATIONS = 2;
const MAX_INCOMPLETE = 2;
const locks = new Set<string>();

export type FindingDisposition =
  | "confirmed-blocker"
  | "non-blocking"
  | "accepted-risk"
  | "product-decision"
  | "follow-up"
  | "not-reproducible"
  | "resolved";

const FINDING_DISPOSITIONS = new Set<FindingDisposition>([
  "confirmed-blocker",
  "non-blocking",
  "accepted-risk",
  "product-decision",
  "follow-up",
  "not-reproducible",
  "resolved",
]);

export interface FindingDispositionInput {
  readonly id: string;
  readonly disposition: FindingDisposition;
  readonly parentEvidence?: string;
  readonly deterministic?: boolean;
  readonly contractBasis?: string;
}

export interface ManagedReviewRunInput {
  readonly cwd: string;
  readonly target: ReviewTarget;
  readonly requestedPhase: "auto" | "initial" | "delta" | "final";
  readonly effort: ReviewEffort;
  readonly implementationId?: string;
  readonly sessionId?: string;
  readonly planPath?: string;
  readonly contract?: ReviewContract;
}

export interface RecordReviewInput {
  readonly cwd: string;
  readonly sessionId: string;
  readonly reviewedSnapshotHash: string;
  readonly dispositions: readonly FindingDispositionInput[];
}

export interface ReviewStatus extends ReviewLedgerSummary {
  readonly currentHead?: string;
  readonly stale: boolean;
  readonly nextAction: string;
}

type Phase = "initial" | "delta" | "final" | "approved" | "blocked";
type MutableFinding = { -readonly [K in keyof FindingLedgerEntry]: FindingLedgerEntry[K] };

interface Ledger {
  version: 1;
  policyVersion: 1;
  sessionId: string;
  implementationId?: string;
  repositoryRoot: string;
  targetIdentity: string;
  baseSha: string;
  planPath?: string;
  planHash?: string;
  contract: ReviewContract;
  phase: Phase;
  decision: ReviewDecision;
  initialReviewedHead?: string;
  lastReviewedHead?: string;
  lastReviewedSnapshotHash?: string;
  completedPasses: number;
  remediationBatches: number;
  incompleteAttemptsThisPhase: number;
  awaitingAdjudication: boolean;
  findings: MutableFinding[];
  createdAt: string;
  updatedAt: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max) : "";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function targetIdentity(target: ReviewTarget): string {
  switch (target.kind) {
    case "pull-request": return `pr:${target.value}`;
    case "branch": return `branch:${target.ref}`;
    case "worktree": return `worktree:${resolve(target.path)}`;
    case "path": return `path:${target.path}`;
    case "current-diff": return "current-diff";
  }
}

async function command(commands: CommandRunner, cwd: string, name: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  const result = await commands.run(name, args, { cwd, signal });
  if (result.canceled) throw new Error(`${name} ${args.join(" ")} was canceled`);
  if (result.truncated) throw new Error(`${name} ${args.join(" ")} output was truncated`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${name} ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout;
}

async function optionalCommand(commands: CommandRunner, cwd: string, name: string, args: readonly string[], signal?: AbortSignal): Promise<string | undefined> {
  const result = await commands.run(name, args, { cwd, signal });
  if (result.canceled) throw new Error(`${name} ${args.join(" ")} was canceled`);
  return result.exitCode === 0 && !result.truncated ? result.stdout : undefined;
}

async function repositoryRoot(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<string> {
  const root = await command(commands, cwd, "git", ["rev-parse", "--show-toplevel"], signal);
  return realpath(root.trim());
}

async function stateDirectory(cwd: string, commands: CommandRunner): Promise<string> {
  const common = await optionalCommand(commands, cwd, "git", ["rev-parse", "--git-common-dir"]);
  const directory = common?.trim()
    ? join(resolve(cwd, common.trim()), "pi-code-review")
    : join(homedir(), ".pi", "agent", "state", "pi-code-review");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function pathFor(directory: string, sessionId: string): string {
  if (!/^[a-f0-9-]{12,80}$/u.test(sessionId)) throw new Error("Invalid review session ID");
  return join(directory, `${sessionId}.json`);
}

function validateLedger(value: unknown): Ledger {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Review ledger is malformed");
  const ledger = value as Partial<Ledger>;
  if (ledger.version !== VERSION || ledger.policyVersion !== VERSION || typeof ledger.sessionId !== "string"
    || typeof ledger.repositoryRoot !== "string" || typeof ledger.targetIdentity !== "string"
    || typeof ledger.baseSha !== "string" || !Array.isArray(ledger.findings)) {
    throw new Error("Review ledger is incompatible or incomplete");
  }
  return ledger as Ledger;
}

async function readLedger(path: string): Promise<Ledger | undefined> {
  try {
    return validateLedger(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeLedger(path: string, ledger: Ledger): Promise<void> {
  ledger.updatedAt = new Date().toISOString();
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  if (locks.has(lockPath)) throw new Error("A review operation is already active for this session");
  locks.add(lockPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, "wx", 0o600);
    return await fn();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("A review operation is already active for this session");
    throw error;
  } finally {
    try { await handle?.close(); } catch {}
    try { await unlink(lockPath); } catch {}
    locks.delete(lockPath);
  }
}

function cleanItems(items: readonly string[]): string[] {
  return items.slice(0, 20).map((item) => text(item)).filter(Boolean);
}

function cleanContract(contract: ReviewContract): ReviewContract {
  return {
    guarantees: cleanItems(contract.guarantees),
    nonGoals: cleanItems(contract.nonGoals),
    riskAreas: cleanItems(contract.riskAreas),
    requiredChecks: cleanItems(contract.requiredChecks),
    ...(contract.source ? { source: text(contract.source) } : {}),
  };
}

function headingItems(body: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^###\\s+${escaped}\\s*$([\\s\\S]*?)(?=^###\\s+|^##\\s+|(?![\\s\\S]))`, "imu").exec(body);
  if (!match) return [];
  return (match[1] ?? "").split("\n")
    .map((line) => /^\s*[-*]\s+(.+)$/u.exec(line)?.[1] ?? "")
    .map((item) => text(item))
    .filter(Boolean)
    .slice(0, 20);
}

export function parseReviewContract(body: string, source?: string): ReviewContract {
  const contract = cleanContract({
    guarantees: headingItems(body, "Guarantees"),
    nonGoals: headingItems(body, "Non-goals"),
    riskAreas: headingItems(body, "Risk areas"),
    requiredChecks: headingItems(body, "Required checks"),
    ...(source ? { source } : {}),
  });
  if (Buffer.byteLength(JSON.stringify(contract), "utf8") > 24 * 1024) throw new Error("Review contract is too large");
  return contract;
}

async function planData(planPath: string | undefined, supplied?: ReviewContract): Promise<{ planPath?: string; planHash?: string; contract: ReviewContract }> {
  if (!planPath) return { contract: cleanContract(supplied ?? { guarantees: [], nonGoals: [], riskAreas: [], requiredChecks: [] }) };
  const canonical = await realpath(isAbsolute(planPath) ? planPath : resolve(planPath));
  const body = await readFile(canonical, "utf8");
  const extracted = parseReviewContract(body, canonical);
  return { planPath: canonical, planHash: hash(body), contract: cleanContract(supplied ?? extracted) };
}

export async function deriveImplementationId(cwd: string, planPath: string, commands: CommandRunner): Promise<string> {
  const root = await repositoryRoot(cwd, commands);
  const plan = await planData(planPath);
  return hash(`${root}|${plan.planPath}|${plan.planHash}`).slice(0, 32);
}

async function baseSha(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<string> {
  const main = await optionalCommand(commands, cwd, "git", ["rev-parse", "--verify", "main^{commit}"], signal)
    ?? await optionalCommand(commands, cwd, "git", ["rev-parse", "--verify", "origin/main^{commit}"], signal);
  if (!main?.trim()) throw new Error("Could not resolve main or origin/main for managed review");
  return (await command(commands, cwd, "git", ["merge-base", "HEAD", main.trim()], signal)).trim();
}

async function observedBaseSha(input: ManagedReviewRunInput, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<string> {
  if (input.target.kind !== "pull-request") return baseSha(input.cwd, dependencies.commands, signal);
  const snapshot = await captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal);
  if (!snapshot.baseSha) throw new Error("Pull-request review could not resolve the current base SHA");
  return snapshot.baseSha;
}

async function requireClean(cwd: string, commands: CommandRunner, signal?: AbortSignal): Promise<void> {
  if ((await command(commands, cwd, "git", ["status", "--porcelain"], signal)).trim()) {
    throw new Error("Managed review requires a clean committed worktree. Commit the intended implementation or remediation first.");
  }
}

function pathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (match?.[2]) paths.add(match[2]);
  }
  return [...paths].sort();
}

function reviewHash(target: ReviewTarget, diff: string, paths: readonly string[], base: string, head: string): string {
  return hash(JSON.stringify({ target, diff, paths, base, head }));
}

async function localSnapshot(target: ReviewTarget, cwd: string, commands: CommandRunner, phase: Exclude<ReviewPhase, "audit">, previousHead?: string, signal?: AbortSignal): Promise<ReviewSnapshot> {
  await requireClean(cwd, commands, signal);
  const head = (await command(commands, cwd, "git", ["rev-parse", "HEAD"], signal)).trim();
  const base = phase === "initial" ? await baseSha(cwd, commands, signal) : previousHead;
  if (!base) throw new Error(`${phase} review requires a previously reviewed head`);
  if (phase !== "initial") {
    const ancestor = await commands.run("git", ["merge-base", "--is-ancestor", base, head], { cwd, signal });
    if (ancestor.exitCode !== 0) throw new Error("The reviewed head is not an ancestor of the current head; reset is required");
    if (base === head) throw new Error("No committed remediation delta exists for the next review phase");
  }
  const range = `${base}...${head}`;
  const diff = await command(commands, cwd, "git", ["diff", "--find-renames", "--find-copies", range], signal);
  const paths = pathsFromDiff(diff);
  return { target, cwd, changedPaths: paths, diff, snapshotHash: reviewHash(target, diff, paths, base, head), baseSha: base, headSha: head };
}

async function managedSnapshot(input: ManagedReviewRunInput, phase: Exclude<ReviewPhase, "audit">, previousHead: string | undefined, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewSnapshot> {
  if (input.target.kind !== "pull-request") return localSnapshot(input.target, input.cwd, dependencies.commands, phase, previousHead, signal);
  if (phase === "initial") return captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal);
  const current = await captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal);
  const pr = current.pullRequest;
  if (!pr || !previousHead) throw new Error("Pull-request delta review requires prior review metadata");
  const compare = await command(dependencies.commands, current.cwd, "gh", [
    "api", `repos/${pr.repository}/compare/${previousHead}...${pr.headSha}`,
    "-H", "Accept: application/vnd.github.v3.diff",
  ], signal);
  const paths = pathsFromDiff(compare);
  return {
    ...current,
    changedPaths: paths,
    diff: compare,
    baseSha: previousHead,
    headSha: pr.headSha,
    snapshotHash: reviewHash(input.target, compare, paths, previousHead, pr.headSha),
  };
}

function summary(ledger: Ledger): ReviewLedgerSummary {
  return {
    sessionId: ledger.sessionId,
    ...(ledger.implementationId ? { implementationId: ledger.implementationId } : {}),
    targetIdentity: ledger.targetIdentity,
    phase: ledger.phase,
    decision: ledger.decision,
    baseSha: ledger.baseSha,
    ...(ledger.lastReviewedHead ? { lastReviewedHead: ledger.lastReviewedHead } : {}),
    ...(ledger.lastReviewedSnapshotHash ? { lastReviewedSnapshotHash: ledger.lastReviewedSnapshotHash } : {}),
    completedPasses: ledger.completedPasses,
    remediationBatches: ledger.remediationBatches,
    incompleteAttemptsThisPhase: ledger.incompleteAttemptsThisPhase,
    awaitingAdjudication: ledger.awaitingAdjudication,
    findings: ledger.findings,
  };
}

async function findLedger(directory: string, sessionId?: string, implementationId?: string): Promise<{ path: string; ledger: Ledger } | undefined> {
  if (sessionId) {
    const path = pathFor(directory, sessionId);
    const ledger = await readLedger(path);
    return ledger ? { path, ledger } : undefined;
  }
  for (const name of await (await import("node:fs/promises")).readdir(directory)) {
    if (!name.endsWith(".json")) continue;
    const path = join(directory, name);
    const ledger = await readLedger(path);
    if (ledger && implementationId && ledger.implementationId === implementationId) return { path, ledger };
  }
  return undefined;
}

function newLedger(root: string, target: ReviewTarget, base: string, implementationId: string | undefined, plan: Awaited<ReturnType<typeof planData>>): Ledger {
  const created = new Date().toISOString();
  const identity = targetIdentity(target);
  const sessionId = hash(`${root}|${identity}|${base}|${implementationId ?? ""}|${plan.planHash ?? ""}`).slice(0, 32);
  return {
    version: 1,
    policyVersion: 1,
    sessionId,
    ...(implementationId ? { implementationId } : {}),
    repositoryRoot: root,
    targetIdentity: identity,
    baseSha: base,
    ...(plan.planPath ? { planPath: plan.planPath } : {}),
    ...(plan.planHash ? { planHash: plan.planHash } : {}),
    contract: plan.contract,
    phase: "initial",
    decision: "incomplete",
    completedPasses: 0,
    remediationBatches: 0,
    incompleteAttemptsThisPhase: 0,
    awaitingAdjudication: false,
    findings: [],
    createdAt: created,
    updatedAt: created,
  };
}

function selectPhase(ledger: Ledger, requested: ManagedReviewRunInput["requestedPhase"]): Exclude<ReviewPhase, "audit"> {
  if (requested !== "auto") return requested;
  if (ledger.completedPasses === 0) return "initial";
  if (ledger.awaitingAdjudication) throw new Error("Record parent dispositions for the last review before running another pass");
  if (ledger.phase === "approved" || ledger.decision === "approve" || ledger.decision === "comment") {
    if (ledger.completedPasses >= MAX_PASSES) throw new Error("The approved head changed after the three-pass budget; reset requires explicit authorization");
    return ledger.completedPasses === 1 ? "delta" : "final";
  }
  if (ledger.decision === "request-changes") return ledger.completedPasses === 1 ? "delta" : "final";
  if (ledger.phase === "blocked" || ledger.decision === "blocked") throw new Error("This review session is blocked; do not run another pass");
  return ledger.completedPasses === 1 ? "delta" : "final";
}

function rootKey(finding: VerifiedFinding): string {
  const parts = finding.id.split(":");
  const stable = parts.length > 2 ? parts.slice(1, -1).join(":") : finding.id;
  return `root:${hash(`${finding.category}|${normalize(stable)}`).slice(0, 20)}`;
}

function mergeFindings(ledger: Ledger, findings: readonly VerifiedFinding[], head: string, phase: Exclude<ReviewPhase, "audit">): VerifiedFinding[] {
  const nextNumber = () => `REV-${String(ledger.findings.length + 1).padStart(3, "0")}`;
  const output: VerifiedFinding[] = [];
  for (const finding of findings.slice(0, 5)) {
    const key = rootKey(finding);
    let entry = ledger.findings.find((item) => item.rootCauseKey === key);
    if (!entry) {
      entry = {
        id: nextNumber(), rootCauseKey: key, severity: finding.severity, confidence: finding.confidence,
        status: "candidate", firstObservedHead: head, lastVerifiedHead: head, introducedByDelta: phase !== "initial",
        file: finding.file, line: finding.line, trigger: text(finding.failureScenario, 1_000),
        impact: text(finding.summary), evidence: text(finding.verification || finding.evidence, 2_000),
      };
      ledger.findings.push(entry);
    } else {
      entry.lastVerifiedHead = head;
      entry.file = finding.file;
      entry.line = finding.line;
      entry.confidence = finding.confidence;
      entry.evidence = text(finding.verification || finding.evidence, 2_000);
      if (entry.status === "resolved" || entry.status === "not-reproducible") entry.status = "candidate";
    }
    output.push({ ...finding, id: entry.id });
  }
  return output;
}

function managedReport(decision: ReviewDecision, ledger: Ledger, phase: string, findings: readonly VerifiedFinding[], note = ""): string {
  const lines = [
    `## Decision: ${decision.toUpperCase().replaceAll("-", " ")}`,
    "",
    `**Session:** \`${ledger.sessionId}\``,
    `**Phase:** ${phase}`,
    `**Passes:** ${ledger.completedPasses}/${MAX_PASSES}`,
    `**Remediation batches:** ${ledger.remediationBatches}/${MAX_REMEDIATIONS}`,
  ];
  if (findings.length) {
    lines.push("", "### Candidate findings requiring parent adjudication", "");
    for (const finding of findings) lines.push(`- **${finding.id} · ${finding.severity} · ${finding.confidence}%** ${finding.summary} — ${finding.file}:${finding.line}`);
  }
  const open = ledger.findings.filter((finding) => finding.status === "open");
  if (open.length) {
    lines.push("", "### Open blockers requiring resolution", "");
    for (const finding of open) lines.push(`- **${finding.id} · ${finding.severity} · ${finding.confidence}%** ${finding.impact} — ${finding.file}:${finding.line}`);
  }
  if (note) lines.push("", note);
  lines.push("", decision === "awaiting-adjudication"
    ? "Inspect each candidate, then call code_review with action=record before editing."
    : decision === "request-changes"
      ? "Apply one coherent remediation commit, then run phase=auto."
      : decision === "blocked"
        ? "The bounded review lifecycle is exhausted. Stop for architecture/product attention or explicitly reset."
        : "No open validated blocker remains for the reviewed committed head.");
  return lines.join("\n");
}

function resultFromLedger(ledger: Ledger, note: string): ReviewResult {
  return {
    effort: "low", status: ledger.decision === "incomplete" ? "incomplete" : "complete", summary: note,
    findings: [], failures: [], commented: false, usage: [], report: managedReport(ledger.decision, ledger, ledger.phase, [], note),
    decision: ledger.decision, sessionId: ledger.sessionId, ...(ledger.lastReviewedSnapshotHash ? { reviewedSnapshotHash: ledger.lastReviewedSnapshotHash } : {}),
    ledger: summary(ledger), ...(ledger.phase === "initial" || ledger.phase === "delta" || ledger.phase === "final" ? { phase: ledger.phase } : {}),
  };
}

async function markIncomplete(path: string, ledger: Ledger, phase: Exclude<ReviewPhase, "audit">, message: string): Promise<ReviewResult> {
  ledger.incompleteAttemptsThisPhase += 1;
  ledger.decision = ledger.incompleteAttemptsThisPhase >= MAX_INCOMPLETE ? "blocked" : "incomplete";
  if (ledger.decision === "blocked") ledger.phase = "blocked";
  await writeLedger(path, ledger);
  return resultFromLedger(ledger, `${phase} review incomplete: ${message}`);
}

export async function runManagedReview(input: ManagedReviewRunInput, dependencies: ReviewDependencies, signal?: AbortSignal): Promise<ReviewResult> {
  const root = await repositoryRoot(input.cwd, dependencies.commands, signal);
  const directory = await stateDirectory(input.cwd, dependencies.commands);
  const plan = await planData(input.planPath, input.contract);
  const implementationId = input.implementationId ?? (plan.planPath ? await deriveImplementationId(input.cwd, plan.planPath, dependencies.commands) : undefined);
  const existing = await findLedger(directory, input.sessionId, implementationId);
  const observedBase = await observedBaseSha(input, dependencies, signal);
  const ledger = existing?.ledger ?? newLedger(root, input.target, observedBase, implementationId, plan);
  const path = existing?.path ?? pathFor(directory, ledger.sessionId);

  return withLock(path, async () => {
    const current = await readLedger(path) ?? ledger;
    if (current.repositoryRoot !== root || current.targetIdentity !== targetIdentity(input.target)
      || current.planHash !== plan.planHash) {
      throw new Error("Existing review state does not match this repository, target, or approved plan");
    }
    if (current.baseSha !== observedBase) {
      current.phase = "blocked";
      current.decision = "blocked";
      await writeLedger(path, current);
      return resultFromLedger(current, "The review base changed after the session started; explicit reset is required.");
    }
    if (input.requestedPhase === "auto" && (current.decision === "approve" || current.decision === "comment") && current.lastReviewedHead) {
      const head = input.target.kind === "pull-request"
        ? (await captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal)).headSha
        : (await command(dependencies.commands, input.cwd, "git", ["rev-parse", "HEAD"], signal)).trim();
      if (head === current.lastReviewedHead) return resultFromLedger(current, "The current committed head is already review-complete.");
    }
    const phase = selectPhase(current, input.requestedPhase);
    if (current.completedPasses >= MAX_PASSES) {
      current.phase = "blocked";
      current.decision = "blocked";
      await writeLedger(path, current);
      return resultFromLedger(current, "No fourth review pass is permitted.");
    }
    if (phase !== "initial" && current.remediationBatches >= MAX_REMEDIATIONS) {
      current.phase = "blocked";
      current.decision = "blocked";
      await writeLedger(path, current);
      return resultFromLedger(current, "The two-remediation-batch budget is exhausted.");
    }

    let snapshot: ReviewSnapshot;
    try {
      snapshot = await managedSnapshot(input, phase, current.lastReviewedHead, dependencies, signal);
    } catch (error) {
      return markIncomplete(path, current, phase, error instanceof Error ? error.message : String(error));
    }
    const options: ReviewOptions = {
      cwd: snapshot.cwd, target: input.target, comment: false,
      effort: phase === "initial" ? input.effort : "low", phase, contract: current.contract, snapshot,
    };
    const pass = await runCodeReview(options, dependencies, signal);
    let currentHead: string | undefined;
    try {
      if (input.target.kind === "pull-request") {
        const currentSnapshot = await captureReviewSnapshot(input.target, input.cwd, dependencies.commands, signal);
        if (currentSnapshot.baseSha !== current.baseSha) {
          return markIncomplete(path, current, phase, "The pull-request base changed during review");
        }
        currentHead = currentSnapshot.headSha;
      } else {
        currentHead = (await command(dependencies.commands, snapshot.cwd, "git", ["rev-parse", "HEAD"], signal)).trim();
      }
    } catch (error) {
      return markIncomplete(path, current, phase, error instanceof Error ? error.message : String(error));
    }
    if (!snapshot.headSha || currentHead !== snapshot.headSha) return markIncomplete(path, current, phase, "The committed target changed during review");
    if (pass.status !== "complete") return markIncomplete(path, current, phase, pass.failures.map((failure) => `${failure.stage}: ${failure.message}`).join("; ") || pass.summary);
    if (phase !== "initial") current.remediationBatches += 1;

    current.phase = phase;
    current.decision = "awaiting-adjudication";
    current.completedPasses += 1;
    current.incompleteAttemptsThisPhase = 0;
    current.lastReviewedHead = snapshot.headSha;
    current.lastReviewedSnapshotHash = snapshot.snapshotHash;
    current.initialReviewedHead ??= snapshot.headSha;
    const mapped = mergeFindings(current, pass.findings, snapshot.headSha, phase);
    current.awaitingAdjudication = mapped.length > 0 || current.findings.some((finding) => finding.status === "open");
    if (!current.awaitingAdjudication) {
      current.phase = "approved";
      current.decision = current.findings.some((finding) => ["non-blocking", "accepted-risk", "product-decision", "follow-up"].includes(finding.status)) ? "comment" : "approve";
    }
    await writeLedger(path, current);
    return {
      ...pass, findings: mapped, report: managedReport(current.decision, current, phase, mapped),
      phase, decision: current.decision, sessionId: current.sessionId,
      reviewedSnapshotHash: snapshot.snapshotHash, ledger: summary(current),
    };
  });
}

function statusFor(disposition: FindingDisposition): FindingLedgerStatus {
  return disposition === "confirmed-blocker" ? "open" : disposition;
}

function blockerAllowed(finding: MutableFinding, disposition: FindingDispositionInput): boolean {
  if (!text(disposition.parentEvidence, 2_000)) return false;
  if ((finding.severity === "critical" || finding.severity === "high") && finding.confidence >= 80) return true;
  return finding.severity === "medium" && finding.confidence >= 90 && disposition.deterministic === true && Boolean(text(disposition.contractBasis));
}

export async function recordReviewDispositions(input: RecordReviewInput, dependencies: Pick<ReviewDependencies, "commands">): Promise<ReviewResult> {
  const directory = await stateDirectory(input.cwd, dependencies.commands);
  const path = pathFor(directory, input.sessionId);
  return withLock(path, async () => {
    const ledger = await readLedger(path);
    if (!ledger) throw new Error(`Review session not found: ${input.sessionId}`);
    if (ledger.planPath) {
      const currentPlan = await planData(ledger.planPath);
      if (currentPlan.planHash !== ledger.planHash) throw new Error("The approved plan changed after review; stale dispositions were not recorded");
    }
    if (!ledger.awaitingAdjudication || ledger.lastReviewedSnapshotHash !== input.reviewedSnapshotHash) throw new Error("Adjudication is stale or this session is not awaiting it");
    const seen = new Set<string>();
    for (const disposition of input.dispositions) {
      if (!FINDING_DISPOSITIONS.has(disposition.disposition)) {
        throw new Error(`Unknown finding disposition for ${disposition.id}: ${String(disposition.disposition)}`);
      }
      if (seen.has(disposition.id)) throw new Error(`Duplicate disposition for ${disposition.id}`);
      seen.add(disposition.id);
      const finding = ledger.findings.find((item) => item.id === disposition.id);
      if (!finding) throw new Error(`Unknown review finding: ${disposition.id}`);
      if (disposition.disposition === "confirmed-blocker" && !blockerAllowed(finding, disposition)) {
        throw new Error(`${finding.id} does not meet the blocker evidence/severity gate`);
      }
      finding.status = statusFor(disposition.disposition);
      if (disposition.parentEvidence) finding.parentEvidence = text(disposition.parentEvidence, 2_000);
      if (disposition.contractBasis) finding.contractBasis = text(disposition.contractBasis);
      finding.lastVerifiedHead = ledger.lastReviewedHead ?? finding.lastVerifiedHead;
    }
    const candidates = ledger.findings.filter((finding) => finding.status === "candidate");
    const open = ledger.findings.filter((finding) => finding.status === "open");
    ledger.awaitingAdjudication = candidates.length > 0;
    if (candidates.length) ledger.decision = "awaiting-adjudication";
    else if (open.length) {
      ledger.decision = ledger.completedPasses >= MAX_PASSES ? "blocked" : "request-changes";
      if (ledger.decision === "blocked") ledger.phase = "blocked";
    } else {
      ledger.phase = "approved";
      ledger.decision = ledger.findings.some((finding) => ["non-blocking", "accepted-risk", "product-decision", "follow-up"].includes(finding.status)) ? "comment" : "approve";
    }
    await writeLedger(path, ledger);
    return resultFromLedger(ledger, candidates.length ? `${candidates.length} candidate(s) still need disposition.`
      : open.length ? `${open.length} confirmed blocker root cause(s) require one coherent remediation commit.`
        : "No open blocker remains for the reviewed committed head.");
  });
}

async function locate(cwd: string, commands: CommandRunner, options: { sessionId?: string; implementationId?: string; planPath?: string }): Promise<{ path: string; ledger: Ledger } | undefined> {
  const directory = await stateDirectory(cwd, commands);
  const implementationId = options.implementationId ?? (options.planPath ? await deriveImplementationId(cwd, options.planPath, commands) : undefined);
  return findLedger(directory, options.sessionId, implementationId);
}

function nextAction(ledger: Ledger, stale: boolean): string {
  if (ledger.decision === "blocked") return "Stop for architecture/product attention or explicitly reset the session.";
  if (ledger.awaitingAdjudication) return "Inspect candidates and record parent dispositions before editing.";
  if (ledger.decision === "request-changes") return "Apply one coherent remediation commit, then run phase=auto.";
  if (ledger.decision === "incomplete") return "Fix the target/reviewer problem, then retry the same phase.";
  if (stale) return "The committed head changed; run phase=auto.";
  return "The reviewed committed head is complete; run required project checks before sign-off.";
}

export async function getReviewStatus(cwd: string, dependencies: Pick<ReviewDependencies, "commands">, options: { sessionId?: string; implementationId?: string; planPath?: string; target?: ReviewTarget }, signal?: AbortSignal): Promise<ReviewStatus | undefined> {
  const found = await locate(cwd, dependencies.commands, options);
  if (!found) return undefined;
  const currentHead = options.target?.kind === "pull-request"
    ? (await captureReviewSnapshot(options.target, cwd, dependencies.commands, signal)).headSha
    : (await optionalCommand(dependencies.commands, cwd, "git", ["rev-parse", "HEAD"], signal))?.trim();
  const stale = Boolean(currentHead && found.ledger.lastReviewedHead && currentHead !== found.ledger.lastReviewedHead);
  return { ...summary(found.ledger), ...(currentHead ? { currentHead } : {}), stale, nextAction: nextAction(found.ledger, stale) };
}

export async function resetReviewSession(cwd: string, dependencies: Pick<ReviewDependencies, "commands">, options: { sessionId?: string; implementationId?: string; planPath?: string; confirm: boolean }): Promise<string> {
  if (!options.confirm) throw new Error("Review reset requires explicit confirmation");
  const found = await locate(cwd, dependencies.commands, options);
  if (!found) return "No matching review session exists.";
  await withLock(found.path, () => rm(found.path, { force: true }));
  return `Review session ${found.ledger.sessionId} was reset.`;
}

export function formatStatusReport(status: ReviewStatus | undefined): string {
  if (!status) return "### Code review status\n\nNo managed review session exists for this target or approved plan.";
  const open = status.findings.filter((finding) => finding.status === "open").length;
  return [
    "### Code review status", "", `**Session:** \`${status.sessionId}\``,
    `**Decision:** ${status.decision.toUpperCase().replaceAll("-", " ")}`,
    `**Phase:** ${status.phase}`, `**Passes:** ${status.completedPasses}/${MAX_PASSES}`,
    `**Remediation batches:** ${status.remediationBatches}/${MAX_REMEDIATIONS}`,
    `**Open blockers:** ${open}`, `**Current head stale:** ${status.stale ? "yes" : "no"}`, "", status.nextAction,
  ].join("\n");
}
