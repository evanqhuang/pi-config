import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, matchesKey } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { parseReviewArgs } from "../src/args.js";
import { cancelActiveReviews, startReviewCancellation } from "../src/cancellation.js";
import { parseReviewEffort, type ReviewEffort } from "../src/effort.js";
import { NodeCommandRunner } from "../src/commands.js";
import { PiReviewAgentRunner } from "../src/runner.js";
import { runCodeReview } from "../src/pipeline.js";
import {
  formatStatusReport,
  getReviewStatus,
  recordReviewDispositions,
  resetReviewSession,
  runManagedReview,
  type FindingDispositionInput,
} from "../src/lifecycle.js";
import { captureReviewSnapshot, resolveReviewTarget } from "../src/targets.js";
import type { ReviewDecision, ReviewPhase, ReviewResult, ReviewTarget } from "../src/types.js";

interface ReviewToolParams {
  readonly action?: "run" | "record" | "status" | "reset" | undefined;
  readonly target?: string | undefined;
  readonly comment?: boolean | undefined;
  readonly effort?: string | undefined;
  readonly model?: string | undefined;
  readonly phase?: "auto" | ReviewPhase | undefined;
  readonly planPath?: string | undefined;
  readonly implementationId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly reviewedSnapshotHash?: string | undefined;
  readonly dispositions?: readonly FindingDispositionInput[] | undefined;
  readonly confirmReset?: boolean | undefined;
}

interface ReviewUI {
  notify(message: string, level: "info" | "warning" | "error"): void;
  setStatus?: ((key: string, text: string | undefined) => void) | undefined;
  setWorkingMessage?: ((message: string | undefined) => void) | undefined;
}

interface SessionContextLike {
  readonly cwd: string;
  readonly sessionManager?: {
    getBranch?: (() => readonly unknown[]) | undefined;
    getEntries?: (() => readonly unknown[]) | undefined;
  } | undefined;
}

interface ReviewExecutionContext extends SessionContextLike {
  readonly signal?: AbortSignal | undefined;
  readonly ui: ReviewUI;
}

interface ContextEventLike {
  readonly messages: readonly any[];
}

const REVIEW_REMINDER_CUSTOM_TYPE = "pi-code-review-lifecycle-reminder";
const PLAN_CONTEXT_TYPE = "pi-plan-mode-plan-context";
const MODE_STATE_TYPES = new Set(["pi-plan-mode-state", "mode-state"]);
const IMPLEMENTATION_ALIASES = new Set(["implementationworker", "implementation-worker", "implementation", "worker"]);
const PLAN_AGENT_TYPES = new Set(["plan", "explore"]);
const REVIEW_AGENT_TYPES = new Set(["review", "reviewer", "code-review", "compliance", "lunacompliance", "test-verifier", "lunatestverifier"]);
const REVIEW_TASK = /\b(?:code[- ]?review|review this|review the (?:diff|implementation|pull request|pr)|security review|spec(?:ification)? compliance review|test evidence review)\b/iu;
const FINDING_DISPOSITIONS = new Set<FindingDispositionInput["disposition"]>([
  "confirmed-blocker",
  "non-blocking",
  "accepted-risk",
  "product-decision",
  "follow-up",
  "not-reproducible",
  "resolved",
]);

function renderProgress(ctx: { ui: ReviewUI }, stage: string, message: string): void {
  const progress = `[${stage}] ${message}`;
  ctx.ui.setStatus?.("code-review", progress);
  ctx.ui.setWorkingMessage?.(progress);
}

function clearProgress(ctx: { ui: ReviewUI }): void {
  ctx.ui.setStatus?.("code-review", undefined);
  ctx.ui.setWorkingMessage?.(undefined);
}

function branchEntries(ctx: SessionContextLike | undefined): readonly unknown[] {
  if (!ctx?.sessionManager) return [];
  const branch = ctx.sessionManager.getBranch?.();
  if (Array.isArray(branch)) return branch;
  const entries = ctx.sessionManager.getEntries?.();
  return Array.isArray(entries) ? entries : [];
}

function customEntry(value: unknown): { customType?: string; data?: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || typeof entry.customType !== "string") return undefined;
  return {
    customType: entry.customType,
    ...(entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? { data: entry.data as Record<string, unknown> } : {}),
  };
}

export function latestManagedPlanPath(ctx: SessionContextLike | undefined): string | undefined {
  for (const raw of [...branchEntries(ctx)].reverse()) {
    const entry = customEntry(raw);
    if (entry?.customType !== PLAN_CONTEXT_TYPE) continue;
    const status = String(entry.data?.status ?? "");
    const planPath = entry.data?.planPath;
    if (typeof planPath !== "string") return undefined;
    return ["approved-pending", "transition-started", "approved"].includes(status) ? planPath : undefined;
  }
  return undefined;
}

function latestMode(ctx: SessionContextLike | undefined): "PLAN" | "ORCHESTRATOR" | "YOLO" {
  for (const raw of [...branchEntries(ctx)].reverse()) {
    const entry = customEntry(raw);
    if (!entry?.customType || !MODE_STATE_TYPES.has(entry.customType)) continue;
    const mode = String(entry.data?.mode ?? "").toUpperCase();
    if (mode === "PLAN" || mode === "ORCHESTRATOR" || mode === "YOLO") return mode;
  }
  return "PLAN";
}

function reviewTargetIdentity(target: ReviewTarget): string {
  switch (target.kind) {
    case "pull-request": return `pr:${target.value}`;
    case "branch": return `branch:${target.ref}`;
    case "worktree": return `worktree:${resolve(target.path)}`;
    case "path": return `path:${target.path}`;
    case "current-diff": return "current-diff";
  }
}

function operationCwd(ctx: ReviewExecutionContext, target: ReviewTarget): string {
  return target.kind === "worktree" ? target.path : ctx.cwd;
}

function contextAt(ctx: ReviewExecutionContext, cwd: string): ReviewExecutionContext {
  return { cwd, ui: ctx.ui, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.sessionManager ? { sessionManager: ctx.sessionManager } : {}) };
}

function plainResult(report: string, effort: ReviewEffort, decision?: ReviewDecision, status: ReviewResult["status"] = "complete"): ReviewResult {
  return {
    effort,
    status,
    summary: report,
    findings: [],
    failures: [],
    report,
    commented: false,
    usage: [],
    ...(decision ? { decision } : {}),
  };
}

export function validateFindingDispositionInputs(dispositions: readonly FindingDispositionInput[]): void {
  for (const disposition of dispositions) {
    if (!FINDING_DISPOSITIONS.has(disposition.disposition)) {
      throw new Error(`Unknown finding disposition for ${disposition.id}: ${String(disposition.disposition)}`);
    }
  }
}

export function buildManagedImplementationId(repositoryRoot: string, branchIdentity: string, planPath = ""): string {
  return createHash("sha256").update(`${repositoryRoot}|${branchIdentity}|${planPath}`).digest("hex").slice(0, 32);
}

async function checkedCommand(
  commands: NodeCommandRunner,
  cwd: string,
  name: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  const result = await commands.run(name, args, { cwd, signal });
  if (result.canceled) throw new Error(`${name} ${args.join(" ")} was canceled`);
  if (result.truncated) throw new Error(`${name} ${args.join(" ")} output was truncated`);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${name} ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout;
}

async function managedImplementationId(
  cwd: string,
  planPath: string | undefined,
  supplied: string | undefined,
  commands: NodeCommandRunner,
  signal?: AbortSignal,
): Promise<string> {
  if (supplied?.trim()) return supplied.trim();
  const repositoryRoot = await realpath((await checkedCommand(commands, cwd, "git", ["rev-parse", "--show-toplevel"], signal)).trim());
  const shortRef = (await checkedCommand(commands, cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"], signal)).trim();
  const branchIdentity = shortRef === "HEAD"
    ? (await checkedCommand(commands, cwd, "git", ["rev-parse", "HEAD"], signal)).trim()
    : shortRef;
  const canonicalPlan = planPath
    ? await realpath(isAbsolute(planPath) ? planPath : resolve(cwd, planPath))
    : "";
  return buildManagedImplementationId(repositoryRoot, branchIdentity, canonicalPlan);
}

async function requireManagedTargetCheckout(
  ctx: ReviewExecutionContext,
  target: ReviewTarget,
  commands: NodeCommandRunner,
): Promise<Awaited<ReturnType<typeof captureReviewSnapshot>> | undefined> {
  if (target.kind === "path") {
    throw new Error("Managed review does not support path-only targets; use a committed branch, worktree, pull request, or current checkout.");
  }
  const cwd = operationCwd(ctx, target);
  const status = await checkedCommand(commands, cwd, "git", ["status", "--porcelain"], ctx.signal);
  if (status.trim()) throw new Error("Managed review and adjudication require a clean committed target checkout.");
  const localHead = (await checkedCommand(commands, cwd, "git", ["rev-parse", "HEAD"], ctx.signal)).trim();
  if (target.kind === "branch") {
    const branchHead = (await checkedCommand(commands, cwd, "git", ["rev-parse", `${target.ref}^{commit}`], ctx.signal)).trim();
    if (localHead !== branchHead) {
      throw new Error(`Managed branch review requires the local checkout at ${target.ref} (${branchHead}); current HEAD is ${localHead}.`);
    }
  }
  if (target.kind !== "pull-request") return undefined;
  const snapshot = await captureReviewSnapshot(target, cwd, commands, ctx.signal);
  if (!snapshot.headSha || localHead !== snapshot.headSha) {
    throw new Error(`Managed pull-request review requires the local checkout at PR head ${snapshot.headSha ?? "unknown"}; current HEAD is ${localHead}.`);
  }
  return snapshot;
}

async function requireCurrentAdjudicationTarget(
  ctx: ReviewExecutionContext,
  target: ReviewTarget,
  params: ReviewToolParams,
  dependencies: { commands: NodeCommandRunner },
): Promise<void> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) throw new Error("record requires sessionId");
  const snapshot = await requireManagedTargetCheckout(ctx, target, dependencies.commands);
  const cwd = operationCwd(ctx, target);
  const status = await getReviewStatus(cwd, dependencies, { sessionId, target }, ctx.signal);
  if (!status) throw new Error(`Review session not found: ${sessionId}`);
  if (status.targetIdentity !== reviewTargetIdentity(target)) {
    throw new Error("The adjudication target does not match the managed review session; use the same target used for the review.");
  }
  if (status.stale) throw new Error("The target changed after review; run the next managed review phase before recording dispositions.");
  if (target.kind === "pull-request"
    && (!snapshot?.pullRequest || snapshot.pullRequest.baseSha !== status.baseSha || snapshot.headSha !== status.lastReviewedHead)) {
    throw new Error("The pull-request base or head changed after review; dispositions for the stale snapshot were not recorded.");
  }
}

async function executeReview(
  ctx: ReviewExecutionContext,
  params: ReviewToolParams,
  activeReviews: Set<AbortController>,
): Promise<ReviewResult> {
  const commands = new NodeCommandRunner();
  const action = params.action ?? "run";
  if (!["run", "record", "status", "reset"].includes(action)) throw new Error(`Unknown code-review action: ${action}`);
  const effort = parseReviewEffort(params.effort);
  const planPath = params.planPath?.trim() || latestManagedPlanPath(ctx);
  const dependencies = {
    commands,
    agents: new PiReviewAgentRunner(),
    ...(params.model?.trim() ? { reviewerModel: params.model.trim() } : {}),
    onProgress: (stage: Parameters<typeof renderProgress>[1], message: string) => renderProgress(ctx, stage, message),
  };
  const target = await resolveReviewTarget(params.target?.trim(), ctx.cwd, commands, ctx.signal);
  const cwd = operationCwd(ctx, target);
  const targetContext = contextAt(ctx, cwd);

  if (action === "record") {
    if (!params.reviewedSnapshotHash?.trim()) throw new Error("record requires reviewedSnapshotHash");
    if (!params.dispositions || params.dispositions.length === 0) throw new Error("record requires at least one finding disposition");
    validateFindingDispositionInputs(params.dispositions);
    await requireCurrentAdjudicationTarget(targetContext, target, params, dependencies);
    return recordReviewDispositions({
      cwd,
      sessionId: params.sessionId!.trim(),
      reviewedSnapshotHash: params.reviewedSnapshotHash.trim(),
      dispositions: params.dispositions,
    }, dependencies);
  }

  const inferredImplementationId = planPath || params.implementationId?.trim()
    ? await managedImplementationId(cwd, planPath, params.implementationId, commands, ctx.signal)
    : undefined;

  if (action === "status") {
    const status = await getReviewStatus(cwd, dependencies, {
      ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
      ...(inferredImplementationId ? { implementationId: inferredImplementationId } : {}),
      ...(planPath ? { planPath } : {}),
      target,
    }, ctx.signal);
    return plainResult(formatStatusReport(status), effort, status?.decision);
  }
  if (action === "reset") {
    const message = await resetReviewSession(cwd, dependencies, {
      ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
      ...(inferredImplementationId ? { implementationId: inferredImplementationId } : {}),
      ...(planPath ? { planPath } : {}),
      confirm: params.confirmReset === true,
    });
    return plainResult(`### Code review reset\n\n${message}`, effort);
  }

  const phase = params.phase ?? "auto";
  if (!["auto", "initial", "delta", "final", "audit"].includes(phase)) throw new Error(`Unknown code-review phase: ${phase}`);
  const managed = phase !== "audit" && Boolean(planPath || params.implementationId?.trim() || params.sessionId?.trim() || phase === "initial" || phase === "delta" || phase === "final");
  const implementationId = managed
    ? inferredImplementationId ?? await managedImplementationId(cwd, planPath, params.implementationId, commands, ctx.signal)
    : undefined;
  const cancellation = startReviewCancellation(activeReviews, ctx.signal);
  try {
    if (managed) {
      await requireManagedTargetCheckout(targetContext, target, commands);
      return runManagedReview({
        cwd,
        target,
        requestedPhase: phase,
        effort,
        ...(implementationId ? { implementationId } : {}),
        ...(params.sessionId?.trim() ? { sessionId: params.sessionId.trim() } : {}),
        ...(planPath ? { planPath } : {}),
      }, dependencies, cancellation.signal);
    }
    return runCodeReview({
      cwd,
      target,
      comment: params.comment === true,
      effort: phase === "audit" && params.effort === undefined ? "high" : effort,
      ...(phase === "audit" ? { phase: "audit" as const } : {}),
    }, dependencies, cancellation.signal);
  } finally {
    cancellation.dispose();
    clearProgress(ctx);
  }
}

export interface ReviewMessageSender {
  sendMessage<T = unknown>(
    message: { customType: string; content: string; display: boolean; details?: T },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

export function injectReviewResult(pi: ReviewMessageSender, result: ReviewResult): void {
  pi.sendMessage<ReviewResult>({
    customType: "code-review-result",
    content: result.report,
    display: true,
    details: result,
  });
}

function messageContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = message as { content?: unknown };
  if (typeof value.content === "string") return value.content;
  if (!Array.isArray(value.content)) return "";
  return value.content.map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join("\n");
}

function isLifecycleReminder(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const value = message as { customType?: unknown };
  return value.customType === REVIEW_REMINDER_CUSTOM_TYPE || messageContent(message).includes(`[${REVIEW_REMINDER_CUSTOM_TYPE}]`);
}

function isOldOrchestratorReminder(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && (message as { customType?: unknown }).customType === "pi-plan-mode-orchestrator-reminder");
}

function lifecycleReminder(mode: "ORCHESTRATOR" | "YOLO", planPath: string, statusReport: string): Record<string, unknown> {
  return {
    role: "custom",
    customType: REVIEW_REMINDER_CUSTOM_TYPE,
    display: false,
    content: [
      "<system-reminder>",
      `[${REVIEW_REMINDER_CUSTOM_TYPE}]`,
      `${mode} approved-plan review policy: pi-code-review is the only code-review authority.`,
      "Do not launch reviewer, LunaCompliance, LunaTestVerifier, compliance, audit, or test-verifier subagents.",
      "Implementation workers may edit only bounded implementation/remediation units. The parent inspects changes, runs project checks, commits the intended state, calls code_review with phase=auto, adjudicates candidates, and records dispositions before fixing anything.",
      "A normal session permits one initial review, one delta review, and at most one final review. Never start a fourth review pass.",
      `Managed plan: ${planPath}`,
      statusReport,
      "</system-reminder>",
    ].join("\n"),
    timestamp: Date.now(),
  };
}

function agentRequestText(input: Record<string, unknown>): string {
  return [input.subagent_type, input.task, input.prompt, input.description, input.name]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function applyReviewAgentPolicy(
  mode: "PLAN" | "ORCHESTRATOR" | "YOLO",
  input: Record<string, unknown>,
): { block: true; reason: string } | undefined {
  const requestText = agentRequestText(input);
  const requestedType = String(input.subagent_type ?? "").trim().toLowerCase();
  const explicitImplementation = mode === "ORCHESTRATOR" && IMPLEMENTATION_ALIASES.has(requestedType);
  if (mode === "PLAN" && PLAN_AGENT_TYPES.has(requestedType)) return undefined;
  if (REVIEW_AGENT_TYPES.has(requestedType) || (REVIEW_TASK.test(requestText) && !explicitImplementation)) {
    return { block: true, reason: "Use code_review as the only review authority; reviewer/compliance/test-verifier subagents are disabled." };
  }
  if (mode === "ORCHESTRATOR") {
    if (!explicitImplementation) {
      return { block: true, reason: "ORCHESTRATOR permits only a bounded ImplementationWorker unit. Use code_review for review work." };
    }
    input.subagent_type = "ImplementationWorker";
  }
  return undefined;
}

export default function (pi: ExtensionAPI): void {
  const activeReviews = new Set<AbortController>();
  let activeContext: SessionContextLike | undefined;
  let activeMode: "PLAN" | "ORCHESTRATOR" | "YOLO" = "PLAN";
  let lateModeHooksRegistered = false;

  const registerLateModeHooks = () => {
    if (lateModeHooksRegistered) return;
    lateModeHooksRegistered = true;
    // pi-code-review is loaded before pi-plan-mode so its Agent guard sees the
    // original request. Register prompt/context hooks after all session-start
    // handlers so this policy remains the final mode guidance.
    pi.on("before_agent_start", (event) => {
      const planPath = latestManagedPlanPath(activeContext);
      activeMode = latestMode(activeContext);
      if (activeMode === "PLAN") {
        return {
          systemPrompt: `${event.systemPrompt}\n\nFor every non-trivial managed implementation plan, include a bounded \`## Review contract\` with \`### Guarantees\`, \`### Non-goals\`, \`### Risk areas\`, and \`### Required checks\`. These sections define the supported review boundary; they do not authorize implementation.`,
        };
      }
      if (!planPath || (activeMode !== "ORCHESTRATOR" && activeMode !== "YOLO")) return undefined;
      return {
        systemPrompt: `${event.systemPrompt}\n\nApproved-plan implementation is active. Use pi-code-review as the only review authority. Commit the intended implementation before each managed review pass. Run project checks, call code_review phase=auto, independently adjudicate every candidate, record dispositions, and fix only confirmed blockers in one coherent batch. Do not launch LunaCompliance, LunaTestVerifier, reviewer, compliance, audit, or test-verifier agents. Stop after initial, delta, and at most one final review pass.`,
      };
    });

    const registerContextHook = pi.on as unknown as (
      event: "context",
      handler: (event: ContextEventLike) => Promise<{ messages: readonly any[] }>,
    ) => void;
    registerContextHook("context", async (event) => {
      activeMode = latestMode(activeContext);
      const planPath = latestManagedPlanPath(activeContext);
      const ordinaryMessages = event.messages.filter((message) => !isLifecycleReminder(message));
      if (!planPath || (activeMode !== "ORCHESTRATOR" && activeMode !== "YOLO") || !activeContext) return { messages: ordinaryMessages };
      const messages = ordinaryMessages.filter((message) => !isOldOrchestratorReminder(message));
      let statusText: string;
      try {
        const commands = new NodeCommandRunner();
        const implementationId = await managedImplementationId(activeContext.cwd, planPath, undefined, commands);
        const status = await getReviewStatus(activeContext.cwd, { commands }, { implementationId, planPath, target: { kind: "current-diff" } });
        statusText = status
          ? `Review status: ${status.decision}; phase=${status.phase}; passes=${status.completedPasses}/3; remediation=${status.remediationBatches}/2. ${status.nextAction}`
          : "Review status: not started. After implementation is committed and checks are run, call code_review with phase=auto and the managed plan path.";
      } catch (error) {
        statusText = `Review status unavailable: ${error instanceof Error ? error.message : String(error)}. Do not claim sign-off until code_review status succeeds.`;
      }
      return { messages: [...messages, lifecycleReminder(activeMode, planPath, statusText)] };
    });
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    activeMode = latestMode(ctx);
    registerLateModeHooks();
    ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "escape") || cancelActiveReviews(activeReviews) === 0) return;
      ctx.ui.notify("Code review canceled.", "warning");
      return { consume: true };
    });
  });

  pi.on("session_tree", (_event, ctx) => {
    activeContext = ctx;
    activeMode = latestMode(ctx);
  });

  pi.on("session_shutdown", () => {
    cancelActiveReviews(activeReviews);
    activeContext = undefined;
  });

  pi.on("tool_call", (event) => {
    if (event.toolName !== "Agent" || !event.input || typeof event.input !== "object" || Array.isArray(event.input)) return undefined;
    const input = event.input as Record<string, unknown>;
    return applyReviewAgentPolicy(activeMode, input);
  });

  pi.registerMessageRenderer<ReviewResult>("code-review-result", (message, _options, _theme) => {
    const report = typeof message.content === "string" ? message.content : message.details?.report;
    return new Markdown(report || "Review result unavailable.", 0, 0, getMarkdownTheme());
  });

  pi.registerEntryRenderer<ReviewResult>("code-review-result", (entry, _options, _theme) => {
    return new Markdown(entry.data?.report ?? "Review result unavailable.", 0, 0, getMarkdownTheme());
  });

  pi.registerCommand("code-review", {
    description: "Run or inspect the bounded stateful code-review lifecycle",
    handler: async (args, ctx) => {
      try {
        const parsed = parseReviewArgs(args);
        const result = await executeReview(ctx, {
          action: parsed.action,
          comment: parsed.comment,
          effort: parsed.effort,
          phase: parsed.phase,
          confirmReset: parsed.confirmReset,
          ...(parsed.target ? { target: parsed.target } : {}),
          ...(parsed.model ? { model: parsed.model } : {}),
          ...(parsed.planPath ? { planPath: parsed.planPath } : {}),
          ...(parsed.implementationId ? { implementationId: parsed.implementationId } : {}),
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
        }, activeReviews);
        injectReviewResult(pi, result);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "code_review",
    label: "Code Review",
    description: "Run, adjudicate, inspect, or explicitly reset the bounded initial/delta/final code-review lifecycle. Results are report-only unless comment is explicitly true for a one-shot pull-request review.",
    parameters: Type.Object({
      action: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("record"), Type.Literal("status"), Type.Literal("reset")])),
      target: Type.Optional(Type.String({ description: "Pull request number/URL, branch, path, worktree, or omit for current diff" })),
      comment: Type.Optional(Type.Boolean({ description: "Publish only for an explicit one-shot pull-request review" })),
      effort: Type.Optional(Type.String({ description: "Review depth: low, medium, high, xhigh, max, or ultra" })),
      model: Type.Optional(Type.String({ description: "Reviewer model provider/id override" })),
      phase: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("initial"), Type.Literal("delta"), Type.Literal("final"), Type.Literal("audit")])),
      planPath: Type.Optional(Type.String({ description: "Managed plan path whose review contract and implementation identity should be used" })),
      implementationId: Type.Optional(Type.String({ description: "Stable approved implementation identity" })),
      sessionId: Type.Optional(Type.String({ description: "Review session ID returned by a prior managed run" })),
      reviewedSnapshotHash: Type.Optional(Type.String({ description: "Exact snapshot hash returned by the managed review being adjudicated" })),
      dispositions: Type.Optional(Type.Array(Type.Object({
        id: Type.String(),
        disposition: Type.Union([
          Type.Literal("confirmed-blocker"),
          Type.Literal("non-blocking"),
          Type.Literal("accepted-risk"),
          Type.Literal("product-decision"),
          Type.Literal("follow-up"),
          Type.Literal("not-reproducible"),
          Type.Literal("resolved"),
        ]),
        parentEvidence: Type.Optional(Type.String()),
        deterministic: Type.Optional(Type.Boolean()),
        contractBasis: Type.Optional(Type.String()),
      }))),
      confirmReset: Type.Optional(Type.Boolean({ description: "Must be true for an explicit reset" })),
    }),
    execute: async (_toolCallId, params: ReviewToolParams, signal, _onUpdate, ctx) => {
      try {
        const sessionManager = (ctx as unknown as SessionContextLike).sessionManager;
        const result = await executeReview({ cwd: ctx.cwd, ui: ctx.ui, ...(signal ? { signal } : {}), ...(sessionManager ? { sessionManager } : {}) }, params, activeReviews);
        return {
          content: [{ type: "text", text: result.report }],
          details: {
            effort: result.effort,
            status: result.status,
            decision: result.decision,
            phase: result.phase,
            sessionId: result.sessionId,
            reviewedSnapshotHash: result.reviewedSnapshotHash,
            findings: result.findings,
            ledger: result.ledger,
            failures: result.failures,
            commented: result.commented,
            usage: result.usage,
          },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Code review failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { effort: params.effort ?? "medium", status: "incomplete", decision: "incomplete", findings: [], failures: [String(error)], commented: false },
          isError: true,
        };
      }
    },
    renderResult: (result, _options, _theme) => {
      const text = result.content[0];
      return new Markdown(text?.type === "text" ? text.text : "Review result unavailable.", 0, 0, getMarkdownTheme());
    },
  });
}
