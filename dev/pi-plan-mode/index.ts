import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createBashTool, getMarkdownTheme, type BashOperations } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Container, Key, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  delegationProfile,
  filterTools,
  isAllowedTool,
  isDelegationTool,
  isReadOnlyBatch,
  isReadOnlyCommand,
  modeNames,
  restoreMode,
} from "./src/policy.mjs";
import { installContextBridgeSandboxPatch } from "./src/context-sandbox.mjs";
import { initializePlanSandbox, resetPlanSandbox, runSandboxed } from "./src/sandbox.mjs";
import { contextSandboxPaths } from "./src/context-paths.mjs";
import {
  appendOrchestratorReminder,
  createOrchestratorReminderMessage,
  createOrchestratorState,
  removeOrchestratorReminderMessages,
  resetOrchestratorState,
  updateOrchestratorState,
} from "./src/orchestrator-reminder.mjs";
import {
  advanceReminderTurn,
  appendPlanReminder,
  clearReminderState,
  createPlanReminderMessage,
  createReminderState,
  forceFullReminder,
  forceSparseReminder,
  normalizePlanStatus,
  recordReminderAttachment,
  removePlanReminderMessages,
  REVISION_FEEDBACK_LIMIT,
  selectPlanReminderVariant,
} from "./src/plan-reminder.mjs";

const STATE_TYPE = "pi-plan-mode-state";
const LEGACY_STATE_TYPE = "mode-state";
const PLAN_CONTEXT_TYPE = "pi-plan-mode-plan-context";
const PLAN_CONTEXT_VERSION = 1;
const APPROVAL_RESUME_OPTIONS = ["Resume approved implementation", "Stay in PLAN"] as const;
const RESTORE_PROMPT_REGISTRY = Symbol.for("pi-plan-mode:approval-restore-prompts:v1");
const CHILD_CONTEXT_PROBE = Symbol.for("pi-subagents:child-context:v1");
const CHILD_PLAN_TOOLS = new Set(["manage_plan_draft", "submit_plan_for_approval"]);
const ORCHESTRATOR_VERIFIERS = new Map([
  ["lunacompliance", "LunaCompliance"],
  ["lunatestverifier", "LunaTestVerifier"],
]);
const PLAN_PROMPT = `PLAN MODE IS ACTIVE. You are a read-only planning agent.
Investigate the repository before proposing changes. Use direct tools for simple, known-file questions. For a substantial task with 2-4 genuinely independent unknowns, launch focused Explore agents together in one parallel batch; do not delegate to satisfy a quota. Give each agent the exact checkout, branch, PR ref, or worktree, a non-overlapping question, relevant paths, and require a concise file:line handoff. Continue useful parent-session investigation while background agents run; never poll or sleep. Verify every handoff against the correct ref, redirect or relaunch an agent whose premise is wrong, and reconcile conflicting evidence. Once evidence is sufficient, use the read-only Plan agent to draft or stress-test a substantial implementation strategy. LunaCompliance and LunaTestVerifier are post-implementation verification agents and must not be used while creating the plan. The parent remains responsible for clarification, source verification, final synthesis, and approval.
When requirements or implementation choices are ambiguous, use ask_user_question to present focused options and obtain the user's decision; do not rely on an unstructured prose question when that tool is available. Never implement, edit, write, patch, delete, install, commit, create worktrees, or otherwise mutate project or system state. The sole project-independent write exception is manage_plan_draft, which may create or replace a managed plan artifact. Context-mode may persist its own private index and session metadata. Do not switch modes yourself or ask the user to switch modes as a substitute for completing the planning task. If a tool call is rejected by PLAN policy, acknowledge the constraint internally, continue with allowed read-only investigation, and still complete the planning response.
Finish with a concrete plan containing context, numbered changes, relevant files and symbols, tests, risks, and validation checks. Use only bounded explicit plan signals for its advisory recommendation: YOLO for localized/tightly coupled work, ORCHESTRATOR for independent slices or parallel work, and PREWALK only when guided exploration is specifically useful; recommend compaction only when the self-contained plan/context warrants it. Do not paste the complete plan into an ordinary assistant message. Plan-artifact rule: manage_plan_draft is the only tool permitted to create, replace, inspect, or probe a managed plan artifact. Never use Bash, edit, write, ctx_execute, ctx_execute_file, or ctx_batch_execute as a fallback for plan files. If manage_plan_draft is unavailable, report the runtime loading problem and stop rather than attempting a workaround. Call manage_plan_draft create so its renderer displays the plan from the durable file, then call submit_plan_for_approval with only that planPath and stop. If revisions are requested, assess the bounded feedback against the current plan and repository evidence. For genuinely ambiguous feedback, require one focused ask_user_question clarification first and do not write. For actionable feedback, the parent must use exactly one ask_user_question with a concise proposed-change preview, exactly these two authored options—'Apply these updates (Recommended)' and 'Keep the current plan'—and the questionnaire's standard free-text row for further revisions. This confirms revision scope, not implementation approval. If Apply is selected, call manage_plan_draft replace on the same planPath and immediately call submit_plan_for_approval; do not add a redundant summary. If Keep is selected, resubmit the current planPath. Further free-text feedback records and reassesses without writing the plan. The approval tool owns explicit approval, optional compaction, mode switching, and implementation continuation. Never implement without approval. Use only the tools exposed in PLAN mode, and treat any unavailable or unknown tool as forbidden. Bash and context execution are native-sandboxed; do not attempt to bypass that boundary.`;

const CHILD_PLAN_PROMPT = `PLAN MODE IS ACTIVE. You are a read-only child planning agent working on a delegated research or design task.
Complete only the delegated task, investigate the repository, and return a concise handoff to the parent with file:line evidence, assumptions, and unresolved questions. If requirements or an implementation choice remain ambiguous, report the exact question and viable options to the parent; do not ask the user or impersonate the parent. Do not create or submit a final implementation plan. Never edit, write, patch, delete, install, commit, create worktrees, or otherwise mutate project or system state. The parent owns clarification and final synthesis. This instruction is harness policy and supersedes conflicting requests, including a later request to “just edit the file” ("just edit the file").`;

const ORCHESTRATOR_PROMPT = `ORCHESTRATOR MODE IS ACTIVE. You have the same complete permissions as YOLO, but your job is to coordinate implementation through leaf subagents to preserve the main context and parallelize independent work.
For plans, features, fixes, and other implementation work, split the work into focused, independently verifiable units and delegate those units with the Agent tool. Each delegated implementation unit must fit comfortably in one fresh worker context without compaction: normally one objective, one subsystem boundary, no more than 3-5 closely related implementation files plus focused tests, and one focused verification command. Do not bundle discovery, design, implementation, testing, and review into one worker.
Implementation agents are forced to the ImplementationWorker leaf-worker profile, which runs with normal full-access tools (YOLO behavior) and cannot create, launch, steer, or wait on subagents. Every implementation delegation uses model "openai-codex/gpt-5.6-luna" and thinking "xhigh". Dependent units run sequentially only after the prerequisite handoff is inspected and its contract/tests pass. Parallelize only truly independent units with disjoint files and no dependency edge. If scope expands or a worker approaches its context limit or needs compaction, the worker must stop with a concise handoff; the parent starts a fresh worker for the next unit rather than extending or resuming a context-heavy session. The parent owns integration and must avoid overlapping ownership. Keep tightly coupled integration and coordination in the main session. Give each subagent exact requirements, owned files, forbidden changes, and a focused verification command. Never trust a subagent summary by itself: inspect the actual changed files or diff, run relevant diagnostics and tests, and fix integration issues. Verifier evidence contract (mandatory): Every verifier delegation names the exact absolute target roots and ref/snapshot. Before acting, the parent validates that every substantive citation, cwd, and source metadata is under those roots and on the requested ref. Any off-root, mirror, stale-copy, or wrong-ref report is invalid evidence and must not trigger edits or a fix loop. On provenance failure, inspect the requested live paths directly, explain why the report is invalid, and do not automatically relaunch a verifier merely to obtain PASS. A new verifier is justified only after actual implementation changes require fresh evidence or the user explicitly requests a corrected rerun. Scope findings to approved criteria/non-goals; classify out-of-scope suggestions instead of fixing them. Do not launch either verifier by default or merely because implementation finished. Use LunaCompliance only when the approved plan or user requirements contain concrete compliance, specification, security, migration, or acceptance criteria that warrant an independent implementation comparison. If no such criteria exist, do not launch it. Use LunaTestVerifier only when test evidence is broad, high-risk, coverage-sensitive, difficult to interpret, or otherwise benefits from independent review. For routine changes with focused commands and clear results, the parent runs and evaluates verification directly instead of launching LunaTestVerifier. These dedicated read-only verifier profiles use model "openai-codex/gpt-5.6-luna" with thinking "high". When one or both are justified, run only the selected verifier or verifiers after implementation, in parallel when independent, then resolve every actionable gap they identify. Verify the complete result yourself before reporting completion. Do not delegate final accountability or claim success from unverified subagent output.`;

type Mode = "PLAN" | "ORCHESTRATOR" | "YOLO";
type ParentRecommendation = "YOLO" | "ORCHESTRATOR" | "PREWALK";
type CompactionAdvice = "direct" | "compact-first";
type PlanRecommendation = {
  // These names mirror the managed-plan front matter contract.
  recommendedMode: ParentRecommendation;
  recommendCompaction: boolean;
  recommendationReason: string;
  // Compatibility/display aliases kept inside the extension, not used as
  // approval state.
  parentRecommendation: ParentRecommendation;
  compactionAdvice: CompactionAdvice;
  reason: string;
  signals: string[];
};
type ApprovalAction = "yolo-direct" | "yolo-compact" | "orchestrator-direct" | "orchestrator-compact" | "prewalk";

/** Versioned cross-extension bridge for the explicit plan approval boundary. */
export const PLAN_MODE_BRIDGE_VERSION = 1 as const;
export const PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL = "pi-plan-mode:approved-plan-query-v1" as const;
export type PlanModeApprovalAction = ApprovalAction;
export type PlanModeExecutionStrategy = ParentRecommendation;
export interface PlanModeBridgePlan {
  planPath: string;
  action: PlanModeApprovalAction;
  strategy: PlanModeExecutionStrategy;
  /** Present only when the selected action requires PREWALK reproduction. */
  prewalk?: { required: true };
}

type PendingApproval = {
  action: ApprovalAction;
  /** In-memory generation; durable recovery gets a fresh generation. */
  transitionId?: string;
  plan: string;
  directory: string;
  planPath: string;
  transcriptPath?: string;
  recommendation: PlanRecommendation;
};

type ApprovalPendingRecord = {
  status: "approved-pending" | "transition-started";
  approvalAction: ApprovalAction;
  planPath: string;
};

type RestorePromptRegistry = {
  bySessionFile: Map<string, Set<string>>;
  bySessionManager: WeakMap<object, Set<string>>;
  byBranch: WeakMap<object, Set<string>>;
};
type RevisionFeedbackAssessment = {
  ambiguous: boolean;
  reason: string;
};

type RevisionProposalGuidance = {
  tool: "ask_user_question";
  question: string;
  options: [typeof REVISION_APPLY_OPTION, typeof REVISION_KEEP_OPTION];
  freeText: true;
  freeTextInstruction: string;
  preview: string;
};
type PlanRecommendationInput = {
  recommendedMode?: unknown;
  recommendCompaction?: unknown;
  recommendationReason?: unknown;
};
type PlanToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};
type ReminderState = {
  turnsSinceAttachment: number;
  attachmentCount: number;
  forceFullReason: string | null;
  forceSparse: boolean;
};
type OrchestratorState = {
  phase: "re-entry" | "implementing" | "verification-needed" | "verifying" | "verification-failed" | "signoff-ready";
  agents: Array<{
    id: string;
    type: "ImplementationWorker" | "LunaCompliance" | "LunaTestVerifier";
    description: string;
    status: "started" | "completed" | "failed";
  }>;
};

type State = {
  mode: Mode;
  pendingMode?: Mode;
  pendingApproval?: PendingApproval;
  pendingApprovalArmed: boolean;
  transitionPromises: Map<string, Promise<void>>;
  transitionStarted: Set<string>;
  compactionCallbacks: Set<string>;
  allTools: string[];
  sandboxed: boolean;
  contextSandboxed: boolean;
  reminder: ReminderState;
  orchestrator: OrchestratorState;
  planPath?: string;
  planStatus: string;
  pendingRevisionFeedback?: string;
};

const PLAN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_OPTIONS = {
  "Implement with YOLO": "yolo-direct",
  "Compact + YOLO": "yolo-compact",
  "Implement with ORCHESTRATOR": "orchestrator-direct",
  "Compact + ORCHESTRATOR": "orchestrator-compact",
  "Implement with PREWALK": "prewalk",
} as const satisfies Record<string, ApprovalAction>;
const REVISION_OPTION = "Request revisions…";
const REVISION_APPLY_OPTION = "Apply these updates (Recommended)";
const REVISION_KEEP_OPTION = "Keep the current plan";
const PLAN_SIGNAL_SCAN_LIMIT = 16_000;
const MAX_RECOMMENDATION_SIGNALS = 4;

const ACTION_LABELS = Object.keys(APPROVAL_OPTIONS) as Array<keyof typeof APPROVAL_OPTIONS>;

export function isApprovalAction(value: unknown): value is ApprovalAction {
  return typeof value === "string" && (Object.values(APPROVAL_OPTIONS) as string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function approvalTransitionKey(pending: Pick<PendingApproval, "action" | "planPath" | "transitionId">) {
  return `${pending.transitionId ?? "legacy"}:${pending.action}:${pending.planPath}`;
}

function approvalPromptKey(pending: Pick<PendingApproval, "action" | "planPath">) {
  return `${pending.action}:${pending.planPath}`;
}

function restorePromptRegistry(): RestorePromptRegistry {
  const registry = (globalThis as unknown as Record<PropertyKey, unknown>)[RESTORE_PROMPT_REGISTRY];
  if (isRecord(registry) && registry.bySessionFile instanceof Map && registry.bySessionManager instanceof WeakMap
    && registry.byBranch instanceof WeakMap) {
    return registry as unknown as RestorePromptRegistry;
  }
  const created: RestorePromptRegistry = {
    bySessionFile: new Map(),
    bySessionManager: new WeakMap(),
    byBranch: new WeakMap(),
  };
  (globalThis as unknown as Record<PropertyKey, unknown>)[RESTORE_PROMPT_REGISTRY] = created;
  return created;
}

function restorePromptSeen(ctx: ExtensionContext, pending: Pick<PendingApproval, "action" | "planPath">) {
  const sessionManager = ctx.sessionManager as object;
  const sessionFile = ctx.sessionManager.getSessionFile();
  const fingerprint = approvalPromptKey(pending);
  const registry = restorePromptRegistry();
  if (sessionFile) {
    const key = sessionFile;
    const seen = registry.bySessionFile.get(key) ?? new Set<string>();
    const alreadySeen = seen.has(fingerprint);
    seen.add(fingerprint);
    registry.bySessionFile.set(key, seen);
    return alreadySeen;
  }
  // Test/runtime adapters sometimes omit a session filename. Prefer the
  // active branch identity so a reloaded extension using a new wrapper around
  // the same branch still cannot show a second prompt.
  const branch = activeBranch(ctx) as object;
  const seen = registry.byBranch.get(branch) ?? registry.bySessionManager.get(sessionManager) ?? new Set<string>();
  const alreadySeen = seen.has(fingerprint);
  seen.add(fingerprint);
  registry.byBranch.set(branch, seen);
  registry.bySessionManager.set(sessionManager, seen);
  return alreadySeen;
}

function boundedPlanText(plan: string) {
  return plan.trim().slice(0, PLAN_SIGNAL_SCAN_LIMIT);
}

function boundedRevisionFeedback(feedback: string | undefined) {
  if (typeof feedback !== "string") return undefined;
  const bounded = feedback.trim().slice(0, REVISION_FEEDBACK_LIMIT);
  return bounded || undefined;
}

function explicitRecommendation(plan: string): { recommendation: ParentRecommendation; signal: string } | undefined {
  const text = boundedPlanText(plan);
  const marker = text.match(/(?:parent\s+)?(?:recommendation|recommended\s+(?:action|mode)|execution\s+(?:mode|recommendation))\s*[:=-]\s*(YOLO|ORCHESTRATOR|PREWALK)\b/i);
  if (marker) {
    const recommendation = marker[1].toUpperCase() as ParentRecommendation;
    return { recommendation, signal: `explicit:${recommendation}` };
  }
  const proseMarker = text.match(/(?:this|the)\s+plan\s+(?:should\s+)?recommend(?:s|ed)?\s+(?:the\s+)?(?:parent\s+)?(?:mode\s+)?(?:be\s+)?(YOLO|ORCHESTRATOR|PREWALK)\b/i);
  if (proseMarker) {
    const recommendation = proseMarker[1].toUpperCase() as ParentRecommendation;
    return { recommendation, signal: `explicit:${recommendation}` };
  }

  // These are deliberately narrow, positive signals. A generic mention of a
  // mode in a tradeoff paragraph must not silently choose it.
  const signals = [
    { recommendation: "PREWALK" as const, pattern: /(?:^|[\n*#-])\s*(?:prewalk|checklist[- ]first|walkthrough[- ]first|guided\s+exploration)\b/i, signal: "explicit:prewalk" },
    { recommendation: "ORCHESTRATOR" as const, pattern: /(?:^|[\n*#-])\s*(?:orchestrator|parallel(?:ize|ism)?|independent\s+(?:work|slices)|subagents?|delegat(?:e|ion)|multi[- ]file|cross[- ]subsystem)\b/i, signal: "explicit:orchestrator" },
    { recommendation: "YOLO" as const, pattern: /(?:^|[\n*#-])\s*(?:yolo|direct(?:ly)?\s+implement(?:ation)?|single[- ]pass|localized|tightly\s+coupled|single[- ]file)\b/i, signal: "explicit:yolo" },
  ];
  const matches = signals.filter(({ pattern }) => pattern.test(text));
  return matches.length === 1 ? matches[0] : undefined;
}

function explicitCompactionAdvice(plan: string): { advice: CompactionAdvice; signal: string } | undefined {
  const text = boundedPlanText(plan);
  const marker = text.match(/(?:compaction(?:\s+advice)?|compact(?:ion)?\s+recommendation|recommendCompaction)\s*[:=-]\s*(compact[- ]first|compact|recommended|required|true|direct|skip|avoid|none|no|false)\b/i);
  if (marker) {
    const advice = /compact|recommended|required|true/i.test(marker[1]) ? "compact-first" : "direct";
    return { advice, signal: `explicit:compaction-${advice}` };
  }
  if (/(?:^|[\n*#-])\s*(?:compact[- ]first|compact\s+before\s+implement(?:ation)?)\b/i.test(text)) {
    return { advice: "compact-first", signal: "explicit:compact-first" };
  }
  if (/(?:^|[\n*#-])\s*(?:skip|avoid|no)\s+compaction\b/i.test(text)) {
    return { advice: "direct", signal: "explicit:direct" };
  }
  return undefined;
}

/**
 * Derive a display-only parent recommendation from a small, bounded set of
 * explicit plan signals. It never reads approval state and never changes the
 * active mode. Ambiguous or unmarked plans intentionally fall back to YOLO.
 */
export function derivePlanRecommendation(plan: string): PlanRecommendation {
  const text = boundedPlanText(plan);
  const explicit = explicitRecommendation(text);
  const recommendation = explicit?.recommendation ?? "YOLO";
  const compaction = explicitCompactionAdvice(text);
  const compactionAdvice = compaction?.advice ?? "direct";
  const signals = [
    explicit?.signal,
    compaction?.signal,
    !explicit && recommendation === "YOLO" ? "default:yolo" : undefined,
  ].filter((signal): signal is string => Boolean(signal)).slice(0, MAX_RECOMMENDATION_SIGNALS);
  const reason = explicit
    ? `The plan contains an explicit ${recommendation} execution signal.`
    : "No unambiguous execution signal was found; YOLO is only the display recommendation, not an approval or mode change.";
  const recommendCompaction = compactionAdvice === "compact-first";
  return {
    recommendedMode: recommendation,
    recommendCompaction,
    recommendationReason: reason,
    parentRecommendation: recommendation,
    compactionAdvice,
    reason,
    signals,
  };
}

/** Apply only bounded explicit caller hints to the derived display recommendation. */
function recommendationForPlan(plan: string, input: PlanRecommendationInput = {}): PlanRecommendation {
  const derived = derivePlanRecommendation(plan);
  const modeValue = typeof input.recommendedMode === "string" ? input.recommendedMode.trim().toUpperCase() : "";
  const recommendedMode = modeValue === "YOLO" || modeValue === "ORCHESTRATOR" || modeValue === "PREWALK"
    ? modeValue as ParentRecommendation
    : derived.recommendedMode;
  const recommendCompaction = typeof input.recommendCompaction === "boolean"
    ? input.recommendCompaction
    : derived.recommendCompaction;
  const recommendationReason = typeof input.recommendationReason === "string" && input.recommendationReason.trim()
    ? input.recommendationReason.trim().slice(0, 500)
    : derived.recommendationReason;
  const signals = [
    ...derived.signals,
    modeValue && modeValue !== derived.recommendedMode ? `explicit-input:${recommendedMode}` : undefined,
    typeof input.recommendCompaction === "boolean" && input.recommendCompaction !== derived.recommendCompaction
      ? `explicit-input:compaction-${recommendCompaction ? "compact-first" : "direct"}`
      : undefined,
  ].filter((signal): signal is string => Boolean(signal)).slice(0, MAX_RECOMMENDATION_SIGNALS);
  return {
    ...derived,
    recommendedMode,
    recommendCompaction,
    recommendationReason,
    parentRecommendation: recommendedMode,
    compactionAdvice: recommendCompaction ? "compact-first" : "direct",
    reason: recommendationReason,
    signals,
  };
}

/** Assess user revision feedback without pretending that a vague request is a plan. */
export function assessRevisionFeedback(feedback: string | undefined): RevisionFeedbackAssessment {
  const text = typeof feedback === "string" ? feedback.trim().slice(0, PLAN_SIGNAL_SCAN_LIMIT) : "";
  if (!text) return { ambiguous: true, reason: "No revision feedback was provided." };
  if (text.split(/\s+/).length < 2) return { ambiguous: true, reason: "The feedback does not identify a change." };
  if (/^(?:please\s+)?(?:fix|change|update|improve|revise|adjust|handle|review|redo)(?:\s+(?:it|this|that|the\s+plan))?[.!?]*$/i.test(text)) {
    return { ambiguous: true, reason: "The requested change is too broad to turn into a safe proposal." };
  }
  if (/^(?:make\s+it|do\s+something|not\s+right|this\s+is\s+wrong|i\s+don'?t\s+like\s+it)\b/i.test(text) && text.split(/\s+/).length <= 5) {
    return { ambiguous: true, reason: "The feedback does not identify which plan behavior should change." };
  }
  return { ambiguous: false, reason: "The feedback names a concrete requested change." };
}

function revisionProposalGuidance(feedback: string, planPath: string): RevisionProposalGuidance {
  const bounded = boundedRevisionFeedback(feedback) ?? "the pending feedback";
  return {
    tool: "ask_user_question",
    question: "Review these proposed updates to the managed plan.",
    options: [REVISION_APPLY_OPTION, REVISION_KEEP_OPTION],
    freeText: true,
    freeTextInstruction: "Include the questionnaire's standard free-text row for further revisions.",
    preview: `For the same managed planPath (${shortenHome(planPath)}), propose only the concise updates needed for: ${bounded}.`,
  };
}

function recommendedApprovalAction(recommendation: PlanRecommendation): ApprovalAction {
  if (recommendation.recommendedMode === "PREWALK") return "prewalk";
  if (recommendation.recommendedMode === "ORCHESTRATOR") {
    return recommendation.recommendCompaction ? "orchestrator-compact" : "orchestrator-direct";
  }
  return recommendation.recommendCompaction ? "yolo-compact" : "yolo-direct";
}

function actionLabel(action: ApprovalAction) {
  return ACTION_LABELS.find((label) => APPROVAL_OPTIONS[label] === action) ?? "Implement with YOLO";
}

export function approvalOptionLabels(recommendation: PlanRecommendation) {
  const recommended = actionLabel(recommendedApprovalAction(recommendation));
  return [
    `${recommended} (Recommended)`,
    ...ACTION_LABELS.filter((label) => label !== recommended),
    REVISION_OPTION,
  ];
}

function approvalActionForLabel(answer: string, recommendation: PlanRecommendation): ApprovalAction | undefined {
  const label = answer.replace(/ \(Recommended\)$/, "") as keyof typeof APPROVAL_OPTIONS;
  if (Object.prototype.hasOwnProperty.call(APPROVAL_OPTIONS, label)) return APPROVAL_OPTIONS[label];
  // Accepting an unadorned value here keeps RPC/test adapters tolerant while
  // the interactive list still always puts the marked recommendation first.
  return answer === `${actionLabel(recommendedApprovalAction(recommendation))} (Recommended)`
    ? recommendedApprovalAction(recommendation)
    : undefined;
}

function recommendationTradeoffs(recommendation: PlanRecommendation) {
  const compact = recommendation.recommendCompaction;
  return [
    `YOLO: fastest direct implementation; it keeps the current context${compact ? " only if you skip the compact-first advice" : ""}.`,
    "ORCHESTRATOR: delegates independent implementation slices and costs coordination/context overhead.",
    "PREWALK: runs the external prewalk checklist/executor and does not switch this parent session's mode.",
    `Compaction advice: ${compact ? "compact first to preserve a long plan/context" : "skip compaction unless you need it; direct execution is sufficient"}.`,
  ].join("\n");
}

function plansRoot() {
  return process.env.PI_PLAN_DIR ?? join(homedir(), ".pi", "agent", "plans");
}

async function prunePlans(root: string, now = Date.now()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await Promise.all((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join(root, entry.name);
    if (now - (await stat(path)).mtimeMs > PLAN_RETENTION_MS) await rm(path, { recursive: true, force: true });
  }));
}

function shortenHome(path: string) {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function planDocument(plan: string, metadata: Record<string, unknown>) {
  return `---\n${JSON.stringify(metadata, null, 2)}\n---\n\n${plan.trim()}\n`;
}

function planFrontmatter(document: string): Record<string, unknown> {
  const match = document.match(/^---\n([\s\S]{0,8000}?)\n---\n\n/);
  if (!match) return {};
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function planBody(document: string) {
  const match = document.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
  return (match?.[1] ?? document).trim();
}

function managedPlanMetadata(plan: string, metadata: Record<string, unknown>, recommendation = recommendationForPlan(plan)) {
  return {
    ...metadata,
    // Keep the approved front-matter names and parent-facing aliases together
    // so old readers can still understand a newly revised managed plan.
    recommendedMode: recommendation.recommendedMode,
    recommendCompaction: recommendation.recommendCompaction,
    parentRecommendation: recommendation.parentRecommendation,
    recommendation: recommendation.parentRecommendation,
    compactionAdvice: recommendation.compactionAdvice,
    recommendationReason: recommendation.recommendationReason,
    recommendationSignals: recommendation.signals,
  };
}

async function validateManagedPlanPath(candidate: string) {
  const root = plansRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lexicalRoot = resolve(root);
  const lexicalCandidate = resolve(candidate);
  const rootInfo = await lstat(lexicalRoot);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Managed plan root is invalid");
  const canonicalRoot = await realpath(lexicalRoot);
  const lexicalRel = relative(lexicalRoot, lexicalCandidate);
  const canonicalCandidate = await realpath(lexicalCandidate);
  const canonicalRel = relative(canonicalRoot, canonicalCandidate);
  const lexicalInside = Boolean(lexicalRel) && !lexicalRel.startsWith("..") && !lexicalRel.includes("../");
  const canonicalInside = Boolean(canonicalRel) && !canonicalRel.startsWith("..") && !canonicalRel.includes("../");
  if (!lexicalInside && !canonicalInside) throw new Error("Plan path is outside a managed plan directory");
  // Check the lexical path as well as its realpath. A symlinked directory can
  // resolve back inside the managed root, but it is still not an approved
  // restore target. Paths already returned by realpath use the canonical walk.
  const walkRoot = lexicalInside ? lexicalRoot : canonicalRoot;
  const walkCandidate = lexicalInside ? lexicalCandidate : canonicalCandidate;
  let cursor = walkCandidate;
  while (cursor !== walkRoot) {
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(cursor === lexicalCandidate ? "Managed plan must be a regular file; symlinks are not allowed" : "Managed plan path cannot contain symlinks");
    }
    cursor = dirname(cursor);
  }
  if (basename(lexicalCandidate) !== "plan.md") throw new Error("Managed plans must use the filename plan.md");
  const info = await lstat(lexicalCandidate);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Managed plan must be a regular file");
  const canonical = canonicalCandidate;
  const rel = relative(canonicalRoot, canonical);
  if (!rel || rel.startsWith("..") || rel.includes("../") || dirname(canonical) === canonicalRoot) {
    throw new Error("Plan path is outside a managed plan directory");
  }
  const parentInfo = await lstat(dirname(lexicalCandidate));
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error("Managed plan directory is invalid");
  return canonical;
}

async function createPlanDraft(plan: string, ctx: ExtensionContext, recommendationInput: PlanRecommendationInput = {}): Promise<PendingApproval> {
  const root = plansRoot();
  await prunePlans(root);
  const createdAt = new Date().toISOString();
  const directory = join(root, `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const planPath = join(directory, "plan.md");
  const sessionFile = ctx.sessionManager.getSessionFile();
  const transcriptPath = sessionFile ? join(directory, basename(sessionFile)) : undefined;
  const recommendation = recommendationForPlan(plan, recommendationInput);
  await writeFile(planPath, planDocument(plan, managedPlanMetadata(plan, { createdAt, sessionFile: sessionFile ?? null, cwd: ctx.cwd, status: "draft" }, recommendation)), { mode: 0o600, flag: "wx" });
  if (sessionFile && transcriptPath) {
    await copyFile(sessionFile, transcriptPath);
    await chmod(transcriptPath, 0o600);
  }
  const canonicalPlanPath = await realpath(planPath);
  return { action: "yolo-direct", plan: plan.trim(), directory: dirname(canonicalPlanPath), planPath: canonicalPlanPath, transcriptPath, recommendation };
}

async function replacePlanDraft(planPath: string, plan: string, recommendationInput: PlanRecommendationInput = {}): Promise<PendingApproval> {
  const canonical = await validateManagedPlanPath(planPath);
  const current = await readFile(canonical, "utf8");
  const createdAt = current.match(/"createdAt":\s*"([^"]+)"/)?.[1] ?? new Date().toISOString();
  const sessionFile = current.match(/"sessionFile":\s*"([^"]+)"/)?.[1];
  const transcriptPath = sessionFile ? join(dirname(canonical), basename(sessionFile)) : undefined;
  const recommendation = recommendationForPlan(plan, recommendationInput);
  await writeFile(canonical, planDocument(plan, managedPlanMetadata(plan, { createdAt, sessionFile: sessionFile ?? null, status: "revised", updatedAt: new Date().toISOString() }, recommendation)), { mode: 0o600 });
  return { action: "yolo-direct", plan: plan.trim(), directory: dirname(canonical), planPath: canonical, transcriptPath, recommendation };
}

async function loadPendingPlan(planPath: string): Promise<PendingApproval> {
  const canonical = await validateManagedPlanPath(planPath);
  const document = await readFile(canonical, "utf8");
  const plan = planBody(document);
  if (!plan) throw new Error("Managed plan is empty");
  const metadata = planFrontmatter(document);
  const recommendation = recommendationForPlan(plan, {
    recommendedMode: metadata.recommendedMode,
    recommendCompaction: metadata.recommendCompaction,
    recommendationReason: metadata.recommendationReason,
  });
  const sessionFile = document.match(/"sessionFile":\s*"([^"]+)"/)?.[1];
  const transcriptPath = sessionFile ? join(dirname(canonical), basename(sessionFile)) : undefined;
  return { action: "yolo-direct", plan, directory: dirname(canonical), planPath: canonical, transcriptPath, recommendation };
}

async function recordApproval(pending: PendingApproval, status: string) {
  const current = await readFile(pending.planPath, "utf8");
  await writeFile(pending.planPath, `${current.trimEnd()}\n\n<!-- approval-status: ${status}; updated: ${new Date().toISOString()} -->\n`, { mode: 0o600 });
}

function activeBranch(ctx: ExtensionContext) {
  const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getBranch?: () => SessionEntry[];
  };
  const entries = typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : sessionManager.getEntries();
  return Array.isArray(entries) ? entries : [];
}

function persistedPlanContextApproval(entry: SessionEntry): ApprovalPendingRecord | "invalid" | undefined {
  if (entry.type !== "custom" || entry.customType !== PLAN_CONTEXT_TYPE || !isRecord(entry.data)) return undefined;
  if (entry.data.status !== "approved-pending" && entry.data.status !== "transition-started") return undefined;
  if (entry.data.version !== PLAN_CONTEXT_VERSION
    || !isApprovalAction(entry.data.approvalAction)
    || typeof entry.data.planPath !== "string"
    || !entry.data.planPath) return "invalid";
  return {
    status: entry.data.status,
    approvalAction: entry.data.approvalAction,
    planPath: entry.data.planPath,
  };
}

function latestApprovalMarker(document: string): string | undefined {
  const markers = [...document.matchAll(/<!--\s*approval-status:\s*([^;\s]+)\s*;/g)].map(match => match[1]);
  return markers.at(-1);
}

function bridgePlanForAction(planPath: string, action: ApprovalAction): PlanModeBridgePlan {
  const strategy = action.startsWith("orchestrator")
    ? "ORCHESTRATOR"
    : action === "prewalk"
      ? "PREWALK"
      : "YOLO";
  return action === "prewalk"
    ? { planPath, action, strategy, prewalk: { required: true } }
    : { planPath, action, strategy };
}

/**
 * Read only the active branch's latest approval record. This intentionally
 * shares the canonical path validator and durable markers used by restore;
 * recommendations, draft/revision status, and old approval records cannot
 * become bridge results.
 */
async function approvedPlanForBridge(ctx: ExtensionContext): Promise<PlanModeBridgePlan | undefined> {
  const latest = latestPlanContextEntry(ctx);
  if (!latest) return undefined;
  const record = persistedPlanContextApproval(latest);
  if (!record || record === "invalid") return undefined;
  try {
    const canonical = await validateManagedPlanPath(record.planPath);
    if (canonical !== record.planPath) return undefined;
    const document = await readFile(canonical, "utf8");
    const marker = latestApprovalMarker(document);
    if (marker !== `approved-${record.approvalAction}-pending`
      && marker !== `approved-${record.approvalAction}-started`) return undefined;
    return bridgePlanForAction(canonical, record.approvalAction);
  } catch {
    // Stale, malformed, symlinked, or otherwise unreadable plans are not
    // approval results. The bridge deliberately fails closed.
    return undefined;
  }
}

/**
 * Restore only the new, explicit approval record. Older state entries never
 * carried enough information to authorize an implementation and are ignored.
 */
function latestPlanContextEntry(ctx: ExtensionContext) {
  const entries = activeBranch(ctx);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === PLAN_CONTEXT_TYPE) return entry;
  }
  return undefined;
}

async function restorePendingApproval(ctx: ExtensionContext): Promise<PendingApproval | undefined> {
  const latest = latestPlanContextEntry(ctx);
  if (!latest) return undefined;
  const record = persistedPlanContextApproval(latest);
  if (!record || record === "invalid" || record.status === "transition-started") return undefined;
  try {
    const canonical = await validateManagedPlanPath(record.planPath);
    // Persisted restore records must already contain the canonical path; do
    // not silently normalize malformed or legacy records into authorization.
    if (canonical !== record.planPath) return undefined;
    const pending = await loadPendingPlan(canonical);
    pending.action = record.approvalAction;
    pending.transitionId = randomUUID();
    return pending;
  } catch {
    return undefined;
  }
}

function branchHasTransitionMarker(ctx: ExtensionContext, pending: PendingApproval) {
  // Walk backwards until the newest matching approval generation. A failed
  // transition context may follow its marker; it must not make an older
  // extension instance safe to replay. A later approved-pending record for the
  // same path/action starts a new generation and deliberately wins.
  for (const entry of [...activeBranch(ctx)].reverse()) {
    const record = persistedPlanContextApproval(entry);
    if (!record || record === "invalid"
      || record.approvalAction !== pending.action
      || record.planPath !== pending.planPath) continue;
    return record.status === "transition-started";
  }
  return false;
}

function lastMode(ctx: ExtensionContext): Mode {
  const entries = activeBranch(ctx).filter((entry) => (
    entry.type === "custom" &&
    (entry.customType === STATE_TYPE || entry.customType === LEGACY_STATE_TYPE)
  ));
  const modes = entries.map((entry) => {
    if (!("data" in entry) || !entry.data || typeof entry.data !== "object") return {};
    return entry.data as { mode?: unknown };
  });
  return restoreMode(modes) as Mode;
}

async function restorePlanContext(ctx: ExtensionContext) {
  for (const entry of [...activeBranch(ctx)].reverse()) {
    if (entry.type !== "custom" || entry.customType !== PLAN_CONTEXT_TYPE) continue;
    if (!("data" in entry) || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as { planPath?: unknown; status?: unknown; planStatus?: unknown; revisionFeedback?: unknown };
    const planStatus = data.status === "approved-pending"
      ? "approved"
      : normalizePlanStatus(data.status ?? data.planStatus);
    const revisionFeedback = typeof data.revisionFeedback === "string"
      ? data.revisionFeedback.trim().slice(0, REVISION_FEEDBACK_LIMIT) || undefined
      : undefined;
    if (typeof data.planPath !== "string") continue;
    try {
      return { planPath: await validateManagedPlanPath(data.planPath), planStatus, revisionFeedback };
    } catch {
      // Ignore malformed or stale persisted paths rather than trusting session data.
    }
  }
  return { planPath: undefined, planStatus: "none", revisionFeedback: undefined };
}

function detectChildSession(): boolean {
  let probe: unknown;
  try {
    probe = (globalThis as unknown as Record<PropertyKey, unknown>)[CHILD_CONTEXT_PROBE];
  } catch {
    // A probe that cannot be read is not evidence of a fresh parent. Fail
    // closed so a child can never inherit unrestricted mutation tools.
    return true;
  }
  // An absent probe is the only signal for a genuine fresh parent. Any other
  // malformed value is treated as a child because the safe fallback is PLAN.
  if (probe === undefined) return false;
  if (typeof probe !== "function") return true;
  try {
    const result: unknown = probe();
    return typeof result === "boolean" ? result : true;
  } catch {
    return true;
  }
}

function sandboxOperations(): BashOperations {
  return { exec: (command, cwd, options) => runSandboxed(command, cwd, options) };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

export default async function piPlanMode(pi: ExtensionAPI): Promise<void> {
  const isChild = detectChildSession();
  // The context-mode extension lazily creates its MCP client during
  // before_agent_start. Install the interceptor before session_start so every
  // future context bridge starts through the native sandbox wrapper.
  const contextPatch = await installContextBridgeSandboxPatch();
  const state: State = {
    // Child detection is fail-closed, so a child starts in PLAN even before
    // the session_start hook has had a chance to apply its persisted state.
    mode: isChild ? "PLAN" : "YOLO",
    pendingApprovalArmed: false,
    transitionPromises: new Map(),
    transitionStarted: new Set(),
    compactionCallbacks: new Set(),
    allTools: [],
    sandboxed: false,
    contextSandboxed: false,
    reminder: createReminderState(),
    orchestrator: createOrchestratorState(),
    planStatus: "none",
  };

  let activeContext: ExtensionContext | undefined;
  const orchestratorUnsubscribers: Array<() => void> = [];
  const bridgeUnsubscribers: Array<() => void> = [];
  const eventBus = (pi as unknown as {
    events?: {
      on(channel: string, handler: (data: unknown) => void): unknown;
      emit(channel: string, data: unknown): void;
    };
  }).events;
  if (!isChild && eventBus) {
    const unsubscribe = eventBus.on(PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL, async (raw) => {
      if (!isRecord(raw)
        || raw.version !== PLAN_MODE_BRIDGE_VERSION
        || typeof raw.requestId !== "string"
        || !/^[A-Za-z0-9._:-]{1,128}$/u.test(raw.requestId)) return;
      const result = activeContext ? await approvedPlanForBridge(activeContext) : undefined;
      eventBus.emit(`${PLAN_MODE_APPROVED_PLAN_QUERY_CHANNEL}:reply:${raw.requestId}`, {
        version: PLAN_MODE_BRIDGE_VERSION,
        requestId: raw.requestId,
        result: result ?? null,
      });
    });
    if (typeof unsubscribe === "function") bridgeUnsubscribers.push(unsubscribe as () => void);
  }
  if (!isChild && eventBus) {
    for (const channel of ["subagents:started", "subagents:completed", "subagents:failed"]) {
      const unsubscribe = eventBus.on(channel, (data) => {
        if (state.mode !== "ORCHESTRATOR") return;
        state.orchestrator = updateOrchestratorState(state.orchestrator, { event: channel, data });
      });
      if (typeof unsubscribe === "function") orchestratorUnsubscribers.push(unsubscribe as () => void);
    }
  }

  const currentTools = () => pi.getAllTools().map((tool) => tool.name);
  const refreshTools = () => {
    state.allTools = currentTools();
    const available = filterTools(state.mode, state.allTools);
    pi.setActiveTools(isChild && state.mode === "PLAN"
      ? available.filter((name) => !CHILD_PLAN_TOOLS.has(name))
      : available);
  };

  const recordPlanContext = async (
    ctx: ExtensionContext,
    planPath: string,
    status: string,
    revisionFeedback?: string | null,
    approvalAction?: ApprovalAction,
  ) => {
    const canonicalPlanPath = await validateManagedPlanPath(planPath);
    if (approvalAction !== undefined && !isApprovalAction(approvalAction)) throw new Error("Invalid approval action");
    const planStatus = status === "approved-pending" ? "approved" : normalizePlanStatus(status);
    const persistedStatus = status === "approved-pending" ? status : planStatus;
    // An omitted feedback argument preserves a pending revision across ordinary
    // lifecycle entries. Only null (cancellation/Keep) or a successful
    // replacement explicitly clears/replaces it.
    const boundedFeedback = revisionFeedback === null
      ? undefined
      : revisionFeedback === undefined
        ? state.pendingRevisionFeedback
        : boundedRevisionFeedback(revisionFeedback);
    state.planPath = canonicalPlanPath;
    state.planStatus = planStatus;
    state.pendingRevisionFeedback = boundedFeedback;
    pi.appendEntry(PLAN_CONTEXT_TYPE, {
      version: PLAN_CONTEXT_VERSION,
      planPath: canonicalPlanPath,
      status: persistedStatus,
      approvalAction: approvalAction ?? null,
      revisionFeedback: boundedFeedback ?? null,
    });
    if (state.mode === "PLAN") {
      state.reminder = planStatus === "revision-requested"
        || (Boolean(boundedFeedback) && revisionFeedback !== undefined)
        ? forceFullReminder(state.reminder, "revision-feedback")
        : forceSparseReminder(state.reminder);
    }
  };

  const persistApprovedPending = async (pending: PendingApproval, ctx: ExtensionContext, clearRevisionFeedback = false) => {
    const canonicalPlanPath = await validateManagedPlanPath(pending.planPath);
    if (canonicalPlanPath !== pending.planPath || !isApprovalAction(pending.action)) {
      throw new Error("Approval state is not canonical or has an invalid action");
    }
    // This versioned context entry is the recovery authorization. It is
    // deliberately appended before this tool returns.
    await recordPlanContext(ctx, canonicalPlanPath, "approved-pending", clearRevisionFeedback ? null : undefined, pending.action);
    await recordApproval(pending, `approved-${pending.action}-pending`);
  };

  const beginTransition = async (pending: PendingApproval, ctx: ExtensionContext) => {
    const key = approvalTransitionKey(pending);
    // The active branch is also checked so an old extension instance cannot
    // replay an approval after a reload has already begun its transition.
    if (state.transitionStarted.has(key) || branchHasTransitionMarker(ctx, pending)) {
      state.transitionStarted.add(key);
      return false;
    }
    state.transitionStarted.add(key);
    // Mark the branch before switching mode, asking for compaction, or
    // launching PREWALK. A restart can therefore never replay a transition.
    await recordPlanContext(ctx, pending.planPath, "transition-started", undefined, pending.action);
    await recordApproval(pending, `approved-${pending.action}-started`);
    return true;
  };

  const recordPlanFailure = async (ctx: ExtensionContext, pending: PendingApproval) => {
    try {
      await recordPlanContext(ctx, pending.planPath, "failed");
    } catch (error) {
      notify(ctx, `Could not persist PLAN failure context: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const blockPlanTool = (reason: string) => {
    state.reminder = forceSparseReminder(state.reminder);
    return { block: true, reason };
  };

  const apply = async (mode: Mode, ctx: ExtensionContext) => {
    if (mode === "PLAN" && !state.sandboxed) {
      if (!contextPatch.available) throw new Error("context-mode native sandbox integration is unavailable");
      const paths = contextSandboxPaths();
      await initializePlanSandbox({ contextState: paths.contextState, contextTemp: paths.contextTemp });
      try {
        await contextPatch.setWrapper({ contextState: paths.contextState, contextTemp: paths.contextTemp });
        state.contextSandboxed = true;
      } catch (error) {
        await resetPlanSandbox();
        throw error;
      }
      state.sandboxed = true;
    }
    if (mode !== "PLAN") {
      contextPatch.clearWrapper?.();
      state.contextSandboxed = false;
      if (state.sandboxed) {
        await resetPlanSandbox();
        state.sandboxed = false;
      }
    }
    state.mode = mode;
    state.orchestrator = resetOrchestratorState();
    state.reminder = mode === "PLAN"
      ? forceFullReminder(state.reminder, "plan-entry")
      : clearReminderState();
    refreshTools();
    pi.appendEntry(STATE_TYPE, { mode });
    const status = mode === "PLAN"
      ? ctx.ui.theme.fg("warning", "PLAN")
      : mode === "ORCHESTRATOR"
        ? ctx.ui.theme.fg("accent", "ORCHESTRATOR")
        : ctx.ui.theme.fg("error", "YOLO");
    ctx.ui.setStatus("pi-plan-mode", status);
    notify(ctx, `${mode} mode active`);
  };

  const requestMode = async (mode: Mode, ctx: ExtensionContext) => {
    if (isChild && mode !== "PLAN") {
      notify(ctx, "Child PLAN sessions cannot activate unrestricted execution modes", "error");
      return;
    }
    if (!ctx.isIdle()) {
      state.pendingMode = mode;
      notify(ctx, `${mode} mode queued until the current run finishes`);
      return;
    }
    try {
      await apply(mode, ctx);
    } catch (error) {
      notify(ctx, `Cannot activate ${mode} mode: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  };

  const handleMode = async (args: string | undefined, ctx: ExtensionContext) => {
    const requested = args?.trim().toLowerCase();
    if (!requested) {
      if (!ctx.hasUI) return;
      const choice = await ctx.ui.select("Mode", modeNames());
      if (choice) await handleMode(choice.toLowerCase(), ctx);
      return;
    }
    if (requested !== "plan" && requested !== "orchestrator" && requested !== "yolo") {
      notify(ctx, "Only PLAN, ORCHESTRATOR, and YOLO modes are available", "error");
      return;
    }
    await requestMode(requested.toUpperCase() as Mode, ctx);
  };

  const startImplementation = async (pending: PendingApproval, ctx: ExtensionContext, mode: Exclude<Mode, "PLAN">) => {
    await apply(mode, ctx);
    const history = pending.transcriptPath
      ? ` A snapshot of the planning chat is available at ${pending.transcriptPath} if details are needed.`
      : "";
    pi.sendUserMessage(`Implement the approved plan saved at ${pending.planPath} in ${mode} mode.${history}`);
  };

  const runPrewalk = async (pending: PendingApproval, ctx: ExtensionContext) => {
    const launcher = process.env.PI_PREWALK_LAUNCHER ?? join(homedir(), ".agents", "skills", "prewalk", "scripts", "run-prewalk");
    const history = pending.transcriptPath
      ? `\nThe full planning chat snapshot is at ${pending.transcriptPath}; consult it if needed.`
      : "";
    const task = `Implement the approved plan below. The durable plan is at ${pending.planPath}.${history}\n\n${pending.plan}\n`;
    notify(ctx, "PREWALK started; this session will wait and report its result");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launcher, ["--prompt-stdin"], { cwd: ctx.cwd, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-1_000_000); });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr = (stderr + text).slice(-1_000_000);
        for (const line of text.split("\n").filter((item) => item.startsWith("[prewalk]") && !item.startsWith("[prewalk] summary"))) {
          notify(ctx, line);
        }
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(task);
    });
    const summaryLine = [...result.stderr.split("\n")].reverse().find((line: string) => line.startsWith("[prewalk] summary "));
    const summaryText = summaryLine?.slice("[prewalk] summary ".length);
    let summary: unknown;
    try { summary = summaryText ? JSON.parse(summaryText) : undefined; } catch { summary = undefined; }
    const succeeded = result.code === 0 && summary !== undefined;
    await recordApproval(pending, succeeded ? "prewalk-completed" : "prewalk-failed");
    if (!succeeded) await recordPlanContext(ctx, pending.planPath, "failed");
    const report = succeeded
      ? `PREWALK completed for ${pending.planPath}.\n\n${JSON.stringify(summary, null, 2)}`
      : `PREWALK failed for ${pending.planPath} (exit ${result.code ?? "unknown"}).\n\n${result.stderr.trim().slice(-4000) || result.stdout.trim().slice(-4000)}`;
    pi.sendMessage({ customType: "pi-plan-prewalk-result", content: report, display: true, details: { summary, exitCode: result.code } });
    if (!succeeded) notify(ctx, "PREWALK failed; no fallback implementation was started", "error");
  };

  const executeApprovedTransition = async (pending: PendingApproval, ctx: ExtensionContext): Promise<void> => {
    const key = approvalTransitionKey(pending);
    const existing = state.transitionPromises.get(key);
    if (existing) return existing;
    const transition = (async () => {
      if (!(await beginTransition(pending, ctx))) return;
      const mode: Exclude<Mode, "PLAN"> = pending.action.startsWith("orchestrator") ? "ORCHESTRATOR" : "YOLO";
      if (pending.action === "prewalk") {
        await runPrewalk(pending, ctx);
        return;
      }
      if (pending.action.endsWith("direct")) {
        await startImplementation(pending, ctx, mode);
        return;
      }
      const callbackKey = `${key}:compaction`;
      ctx.compact({
        customInstructions: `Preserve this approved implementation plan in full and make it the primary task after compaction. After compaction it will run in ${mode} mode:\n\n${pending.plan}\n\nThe durable plan is at ${pending.planPath}. The approval artifact directory is ${pending.directory}.${pending.transcriptPath ? ` A snapshot of the full chat history before compaction is at ${pending.transcriptPath}; consult it if omitted details are needed.` : ""}`,
        onComplete: () => {
          if (state.compactionCallbacks.has(callbackKey)) return;
          state.compactionCallbacks.add(callbackKey);
          void startImplementation(pending, ctx, mode).catch(async (error) => {
            await recordPlanFailure(ctx, pending);
            notify(ctx, `Compaction completed, but implementation could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
          });
        },
        onError: (error) => {
          if (state.compactionCallbacks.has(callbackKey)) return;
          state.compactionCallbacks.add(callbackKey);
          state.reminder = forceFullReminder(state.reminder, "compaction-failed");
          void recordApproval(pending, "compaction-failed");
          void recordPlanFailure(ctx, pending);
          notify(ctx, `Plan compaction failed; remaining in PLAN mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        },
      });
    })();
    state.transitionPromises.set(key, transition);
    return transition;
  };

  const submitPlanForApprovalUI = async (pending: PendingApproval, ctx: ExtensionContext): Promise<PlanToolResult> => {
    if (!ctx.hasUI) {
      await recordApproval(pending, "approval-failed");
      await recordPlanContext(ctx, pending.planPath, "failed");
      return {
        content: [{ type: "text", text: `Plan is at ${shortenHome(pending.planPath)}, but interactive approval requires a UI. Remaining in PLAN mode.` }],
        details: { planPath: pending.planPath, status: "approval-failed" },
        isError: true,
      };
    }

    const options = approvalOptionLabels(pending.recommendation);
    const recommended = options[0];
    const answer = await ctx.ui.select(
      [
        "Approve this plan for implementation?",
        `Recommended action: ${recommended}`,
        pending.recommendation.recommendationReason,
        recommendationTradeoffs(pending.recommendation),
        "The recommendation is advisory: you remain the sole approval authority; your selection is the only approval and does not switch modes inside this tool call.",
      ].join("\n\n"),
      options,
    );
    if (!answer || answer === REVISION_OPTION) {
      const feedback = answer === REVISION_OPTION
        ? boundedRevisionFeedback(await ctx.ui.input("What should change in the plan?"))
        : undefined;
      const status = answer === REVISION_OPTION ? "revision-requested" : "cancelled";
      const assessment = answer === REVISION_OPTION ? assessRevisionFeedback(feedback) : undefined;
      // Revision feedback and cancellation are branch-local context only. Do
      // not append an approval marker to the managed artifact before Apply.
      await recordPlanContext(ctx, pending.planPath, status, answer === REVISION_OPTION ? feedback ?? null : null);
      if (answer !== REVISION_OPTION) {
        return {
          content: [{ type: "text", text: "The plan was not approved. Approval was cancelled; remaining in PLAN mode." }],
          details: { feedback: null, planPath: pending.planPath, status },
        };
      }
      if (assessment!.ambiguous) {
        return {
          content: [{ type: "text", text: `Revision feedback is ambiguous: ${assessment!.reason} First use one focused ask_user_question clarification about the requested change; do not write or propose a replacement yet. This is not implementation approval.` }],
          details: { feedback: feedback ?? null, planPath: pending.planPath, status, clarificationRequired: true, clarificationTool: "ask_user_question", assessment: assessment!.reason },
        };
      }
      const proposal = revisionProposalGuidance(feedback!, pending.planPath);
      return {
        content: [{ type: "text", text: `Revision feedback is actionable: ${feedback!.trim()} Compare it with the current plan and repository evidence, then use exactly one ask_user_question with a concise proposed-change preview. Its exactly two authored options must be '${REVISION_APPLY_OPTION}' and '${REVISION_KEEP_OPTION}', plus the questionnaire's standard free-text row for further revisions. This confirms revision scope, not implementation approval. Apply requires manage_plan_draft replace on the same planPath followed immediately by submit_plan_for_approval; Keep resubmits the current path; further feedback records and reassesses without a plan write.` }],
        details: {
          feedback: feedback ?? null,
          planPath: pending.planPath,
          status,
          clarificationRequired: false,
          assessment: assessment!.reason,
          revisionProposal: proposal,
          proposalOptions: proposal.options,
          proposalFreeText: true,
        },
      };
    }

    const action = approvalActionForLabel(answer, pending.recommendation);
    if (!action) {
      await recordApproval(pending, "approval-failed");
      await recordPlanContext(ctx, pending.planPath, "failed");
      return { content: [{ type: "text", text: "Unknown approval choice; remaining in PLAN mode." }], details: { planPath: pending.planPath, status: "approval-failed" }, isError: true };
    }
    pending.action = action;
    pending.transitionId = randomUUID();
    state.pendingApproval = pending;
    state.pendingApprovalArmed = true;
    // An implementation selection after revision review is the parent-owned
    // Keep/resubmit path. A normal first submission has no pending feedback to
    // clear and leaves the context untouched.
    const clearRevisionFeedback = state.planStatus === "revision-requested";
    await persistApprovedPending(pending, ctx, clearRevisionFeedback);
    return {
      content: [{ type: "text", text: `Approval recorded for ${pending.action}: ${shortenHome(pending.planPath)}. The transition begins after this run settles. Stop now.` }],
      details: {
        action: pending.action,
        planPath: pending.planPath,
        status: "approved-pending",
        recommendedMode: pending.recommendation.recommendedMode,
        recommendCompaction: pending.recommendation.recommendCompaction,
        recommendationReason: pending.recommendation.recommendationReason,
      },
    };
  };

  pi.registerTool({
    name: "manage_plan_draft",
    label: "Manage Plan Draft",
    description: "Create or replace the managed plan.md artifact. Revision proposals are presented by the parent with ask_user_question; this tool never presents revision choices.",
    promptSnippet: "Create or replace the durable PLAN-mode plan artifact",
    promptGuidelines: ["Use manage_plan_draft create for the final plan. After the parent receives Apply from its ask_user_question revision proposal, use replace with the same planPath and immediately submit it for approval. Do not paste the full plan into ordinary assistant prose."],
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "replace"] },
        plan: { type: "string", minLength: 1, description: "Draft or replacement plan" },
        planPath: { type: "string", description: "Required for replace; must be the same managed planPath" },
        recommendedMode: { type: "string", enum: ["YOLO", "ORCHESTRATOR", "PREWALK"], description: "Optional bounded display recommendation signal; never approval" },
        recommendCompaction: { type: "boolean", description: "Optional display advice to compact before implementation; never approval" },
        recommendationReason: { type: "string", maxLength: 500, description: "Optional concise reason for the display recommendation" },
      },
      required: ["action", "plan"],
      additionalProperties: false,
    } as any,
    async execute(_id, rawParams, _signal, _onUpdate, ctx) {
      if (isChild) throw new Error("Child PLAN sessions cannot manage plan drafts");
      if (state.mode !== "PLAN") throw new Error("Plan drafts can be managed only in PLAN mode");
      const params = rawParams as { action: "create" | "replace"; plan: string; planPath?: string } & PlanRecommendationInput;
      if (params.action !== "create" && params.action !== "replace") throw new Error("Unknown plan draft action; use create or replace");
      if (!params.plan.trim()) throw new Error("Plan draft cannot be empty");
      if (params.action === "replace" && !params.planPath) throw new Error("replace requires planPath");
      if (params.action === "create" && params.planPath) throw new Error("create does not accept planPath");
      const recommendationInput: PlanRecommendationInput = {
        recommendedMode: params.recommendedMode,
        recommendCompaction: params.recommendCompaction,
        recommendationReason: params.recommendationReason,
      };
      const pending = params.action === "create"
        ? await createPlanDraft(params.plan, ctx, recommendationInput)
        : await replacePlanDraft(params.planPath!, params.plan, recommendationInput);
      await recordPlanContext(ctx, pending.planPath, params.action === "create" ? "created" : "replaced", params.action === "replace" ? null : undefined);
      return {
        content: [{ type: "text" as const, text: `Plan ${params.action === "create" ? "created" : "revised"}: ${shortenHome(pending.planPath)}` }],
        details: {
          action: params.action,
          plan: pending.plan,
          planPath: pending.planPath,
          recommendedMode: pending.recommendation.recommendedMode,
          recommendCompaction: pending.recommendation.recommendCompaction,
          recommendationReason: pending.recommendation.recommendationReason,
        },
      };
    },
    renderCall(rawArgs, theme) {
      const args = rawArgs as { action?: string };
      const label = args.action === "replace" ? "Revising" : "Creating";
      return new Text(theme.fg("muted", `${label} managed plan…`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { action?: string; plan?: string; planPath?: string; recommendedMode?: ParentRecommendation; recommendCompaction?: boolean; recommendationReason?: string } | undefined;
      if (!details?.planPath) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "Plan operation failed", 0, 0);
      const path = shortenHome(details.planPath);
      const container = new Container();
      container.addChild(new Text(theme.bold("Here is the plan:"), 0, 0));
      container.addChild(new Text(theme.fg("muted", "╌".repeat(72)), 0, 0));
      container.addChild(new Markdown(details.plan ?? "", 0, 0, getMarkdownTheme()));
      if (details.recommendedMode) {
        const compaction = details.recommendCompaction ? "compact first" : "direct execution";
        container.addChild(new Text(theme.fg("muted", `Parent recommendation: ${details.recommendedMode}; ${compaction}. ${details.recommendationReason ?? ""}`), 0, 0));
      }
      container.addChild(new Text(theme.fg("muted", "╌".repeat(72)), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("accent", `Plan file: ${path}`), 0, 0));
      return container;
    },
  });

  pi.registerTool({
    name: "submit_plan_for_approval",
    label: "Submit Plan for Approval",
    description: "Read a managed plan file, show the advisory recommendation and tradeoffs, and ask the user whether to implement directly or compact first.",
    promptSnippet: "Submit a managed planPath for explicit user approval",
    promptGuidelines: ["Call submit_plan_for_approval only with a planPath returned by manage_plan_draft, then stop. Only this tool can record approval; its recommendation is advisory."],
    parameters: {
      type: "object",
      properties: {
        planPath: { type: "string", minLength: 1, description: "Managed plan.md path returned by manage_plan_draft" },
      },
      required: ["planPath"],
      additionalProperties: false,
    } as any,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (isChild) throw new Error("Child PLAN sessions cannot submit plans for approval");
      void toolCallId;
      void signal;
      void onUpdate;
      if (state.mode !== "PLAN") {
        return { content: [{ type: "text" as const, text: "Plan approval is available only in PLAN mode." }], details: {}, isError: true };
      }
      const pending = await loadPendingPlan((params as { planPath: string }).planPath);
      return submitPlanForApprovalUI(pending, ctx);
    },
  });

  pi.registerCommand("mode", { description: "Switch between PLAN, ORCHESTRATOR, and YOLO", handler: handleMode });
  pi.registerCommand("modes", { description: "Alias for /mode", handler: handleMode });
  pi.registerCommand("plan", { description: "Alias for /mode plan", handler: async (_args, ctx) => handleMode("plan", ctx) });
  pi.registerCommand("orchestrator", { description: "Alias for /mode orchestrator", handler: async (_args, ctx) => handleMode("orchestrator", ctx) });
  pi.registerCommand("yolo", { description: "Alias for /mode yolo", handler: async (_args, ctx) => handleMode("yolo", ctx) });

  pi.registerShortcut(Key.shift("tab"), {
    description: "Cycle PLAN, ORCHESTRATOR, and YOLO modes",
    handler: async (ctx) => {
      const modes = modeNames() as Mode[];
      const current = state.pendingMode ?? state.mode;
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      await requestMode(next, ctx);
    },
  });

  const localBash = createBashTool(process.cwd());
  pi.registerTool({
    ...localBash,
    label: "bash (PLAN sandboxed)",
    async execute(id, params, signal, onUpdate, ctx) {
      if (state.mode !== "PLAN") {
        const tool = createBashTool(ctx.cwd);
        return tool.execute(id, params, signal, onUpdate);
      }
      const tool = createBashTool(ctx.cwd, { operations: sandboxOperations() });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", (_event, ctx) => {
    if (state.mode !== "PLAN") return undefined;
    return { operations: sandboxOperations() };
  });

  pi.on("tool_call", async (event) => {
    if (state.mode === "ORCHESTRATOR") {
      if (event.toolName === "Agent") {
        if (!event.input || typeof event.input !== "object" || Array.isArray(event.input)) {
          return { block: true, reason: "ORCHESTRATOR requires a valid Agent request object." };
        }
        const input = event.input as Record<string, unknown>;
        const requestedType = String(input.subagent_type ?? "").toLowerCase();
        const verifierType = ORCHESTRATOR_VERIFIERS.get(requestedType);
        // Leaf workers deliberately do not load pi-plan-mode, so a fresh child
        // never falls back to PLAN and cannot create a nested delegation tree.
        input.subagent_type = verifierType ?? "ImplementationWorker";
        input.model = "openai-codex/gpt-5.6-luna";
        input.thinking = verifierType ? "high" : "xhigh";
      }
      return undefined;
    }
    if (state.mode === "YOLO") return undefined;

    if (isChild && CHILD_PLAN_TOOLS.has(event.toolName)) {
      return blockPlanTool(`Child PLAN blocks parent-only tool: ${event.toolName}`);
    }

    if (!isAllowedTool("PLAN", event.toolName)) {
      return blockPlanTool(`PLAN blocks unknown or mutating tool: ${event.toolName}`);
    }

    if (event.toolName === "bash") {
      const command = (event.input as { command?: unknown })?.command;
      if (!isReadOnlyCommand(command)) {
        return blockPlanTool("PLAN Bash only permits a single recognized read-only command; use ctx_execute for sandboxed derivation.");
      }
    }

    if (event.toolName === "ctx_batch_execute" && !isReadOnlyBatch(event.input)) {
      return blockPlanTool("PLAN ctx_batch_execute requires every nested command to be recognized as read-only.");
    }

    if (["ctx_execute", "ctx_execute_file", "ctx_batch_execute"].includes(event.toolName) && !state.contextSandboxed) {
      return blockPlanTool("PLAN context execution is unavailable because its native sandbox wrapper is not ready.");
    }

    if (isDelegationTool(event.toolName)) {
      const result = delegationProfile(event.input);
      if (!result.allowed) {
        return blockPlanTool(`PLAN blocks unrestricted delegation: ${result.reason}`);
      }
      const input = event.input as Record<string, unknown>;
      input.subagent_type = result.subagentType;
      input.readOnly = true;
      input.mode = "PLAN";
      input.profile = result.profile;
      // The child starts in this extension's safe default PLAN mode. These
      // fields are also useful to extensions that understand inherited policy.
      input.inheritPlan = result.inheritPlan;
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (state.mode === "PLAN") {
      const prompt = isChild
        ? CHILD_PLAN_PROMPT
        : `${PLAN_PROMPT}${state.pendingRevisionFeedback ? `\n\nPending revision feedback to assess: ${state.pendingRevisionFeedback}` : ""}`;
      return { systemPrompt: `${event.systemPrompt}\n\n${prompt}` };
    }
    if (state.mode === "ORCHESTRATOR") return { systemPrompt: `${event.systemPrompt}\n\n${ORCHESTRATOR_PROMPT}` };
    return undefined;
  });

  pi.on("session_start", async (event, ctx) => {
    activeContext = ctx;
    try {
      await prunePlans(plansRoot());
      const restoredPlan = await restorePlanContext(ctx);
      state.planPath = restoredPlan.planPath;
      state.planStatus = restoredPlan.planStatus;
      state.pendingRevisionFeedback = restoredPlan.revisionFeedback;
      const resumedSession = activeBranch(ctx).length > 0;
      const recoveredApproval = !isChild && resumedSession
        ? await restorePendingApproval(ctx)
        : undefined;
      const startReason = (event as { reason?: unknown }).reason;
      const genuineResume = startReason === undefined
        ? resumedSession
        : startReason === "startup" || startReason === "resume";
      state.pendingApproval = recoveredApproval;
      state.pendingApprovalArmed = false;
      state.allTools = currentTools();
      // A recoverable approval is an explicit safety interlock: it never
      // restores the previously persisted execution mode before the user
      // chooses whether to resume it.
      await apply(recoveredApproval ? "PLAN" : isChild ? "PLAN" : lastMode(ctx), ctx);
      if (!recoveredApproval || !genuineResume || !ctx.hasUI) return;
      // Explicit runtime reasons distinguish reload/fork from a later real
      // startup/resume. Adapters without the reason use the process/session
      // registry to prevent duplicate prompts on extension reload.
      const duplicatePrompt = startReason === undefined && restorePromptSeen(ctx, recoveredApproval);
      if (duplicatePrompt) return;
      const answer = await ctx.ui.select(
        "An approved implementation is pending. Resume it or remain in PLAN?",
        [...APPROVAL_RESUME_OPTIONS],
      );
      if (answer !== APPROVAL_RESUME_OPTIONS[0]) {
        // Keep the durable record and deliberately leave it disarmed. A later
        // settle event must not turn Stay in PLAN into implicit approval.
        state.pendingApprovalArmed = false;
        return;
      }
      // The startup choice has consumed the in-memory gate; the durable
      // transition marker now owns idempotency and restart recovery.
      state.pendingApproval = undefined;
      state.pendingApprovalArmed = false;
      await executeApprovedTransition(recoveredApproval, ctx);
    } catch (error) {
      state.contextSandboxed = false;
      state.mode = "PLAN";
      state.sandboxed = false;
      state.reminder = forceFullReminder(state.reminder, "sandbox-failure");
      state.allTools = currentTools();
      pi.setActiveTools([]);
      ctx.ui.setStatus("pi-plan-mode", ctx.ui.theme.fg("error", "PLAN BLOCKED"));
      notify(ctx, `PLAN failed closed because native sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  });

  pi.on("turn_start", async () => {
    if (state.mode === "PLAN") state.reminder = advanceReminderTurn(state.reminder);
    refreshTools();
  });

  pi.on("context", async (event) => {
    const messages = removePlanReminderMessages(removeOrchestratorReminderMessages(event.messages));
    if (!isChild && state.mode === "ORCHESTRATOR") {
      return {
        messages: appendOrchestratorReminder(messages, createOrchestratorReminderMessage(state.orchestrator)),
      };
    }
    if (state.mode !== "PLAN") return { messages };

    const reentry = state.reminder.forceFullReason === "compaction-reentry";
    const variant = selectPlanReminderVariant({
      state: state.reminder,
      child: isChild,
      reentry,
      revisionFeedback: state.pendingRevisionFeedback,
      revisionPending: state.planStatus === "revision-requested",
    });
    if (!variant) return { messages };

    const reminder = createPlanReminderMessage({
      variant,
      planPath: state.planPath,
      planStatus: state.planStatus,
      revisionFeedback: state.pendingRevisionFeedback,
    });
    state.reminder = recordReminderAttachment(state.reminder);
    return { messages: appendPlanReminder(messages, reminder) };
  });

  pi.on("session_compact", async () => {
    if (state.mode === "PLAN") state.reminder = forceFullReminder(state.reminder, "compaction-reentry");
    if (state.mode === "ORCHESTRATOR") state.orchestrator = resetOrchestratorState();
  });

  pi.on("session_compact_failed", async () => {
    if (state.mode === "PLAN") state.reminder = forceFullReminder(state.reminder, "compaction-failed");
    if (state.mode === "ORCHESTRATOR") state.orchestrator = resetOrchestratorState();
  });

  pi.on("session_tree", async (_event, ctx) => {
    activeContext = ctx;
    const restoredPlan = await restorePlanContext(ctx);
    const recoveredApproval = !isChild ? await restorePendingApproval(ctx) : undefined;
    state.planPath = restoredPlan.planPath;
    state.planStatus = restoredPlan.planStatus;
    state.pendingRevisionFeedback = restoredPlan.revisionFeedback;
    state.pendingApproval = recoveredApproval;
    state.pendingApprovalArmed = false;
    // Tree navigation re-evaluates the branch but never prompts or consumes an
    // approval. A valid pending record still forces the hard PLAN gate.
    await apply(isChild ? "PLAN" : recoveredApproval ? "PLAN" : lastMode(ctx), ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const pendingApproval = state.pendingApprovalArmed ? state.pendingApproval : undefined;
    if (pendingApproval) {
      state.pendingApproval = undefined;
      state.pendingApprovalArmed = false;
      state.pendingMode = undefined;
      try {
        await executeApprovedTransition(pendingApproval, ctx);
      } catch (error) {
        if (pendingApproval.action === "prewalk") await recordApproval(pendingApproval, "prewalk-failed");
        await recordPlanFailure(ctx, pendingApproval);
        const prefix = pendingApproval.action === "prewalk"
          ? "PREWALK failed; no fallback implementation was started"
          : "Implementation could not start; remaining in the current mode";
        notify(ctx, `${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
      return;
    }
    const pendingMode = state.pendingMode;
    if (!pendingMode) return;
    state.pendingMode = undefined;
    await requestMode(pendingMode, ctx);
  });

  pi.on("session_shutdown", async () => {
    activeContext = undefined;
    while (bridgeUnsubscribers.length > 0) {
      try { bridgeUnsubscribers.pop()?.(); } catch {}
    }
    while (orchestratorUnsubscribers.length > 0) {
      try { orchestratorUnsubscribers.pop()?.(); } catch {}
    }
    contextPatch.cleanup();
    if (state.sandboxed) {
      try { await resetPlanSandbox(); } catch {}
      state.sandboxed = false;
    }
  });
}
