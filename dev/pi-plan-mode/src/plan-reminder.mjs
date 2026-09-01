const EMPTY_PLAN_PATH = "(no managed plan path)";

export const REMINDER_INTERVAL_TURNS = 5;
export const TURNS_BETWEEN_ATTACHMENTS = REMINDER_INTERVAL_TURNS;
export const FULL_REFRESH_ATTACHMENT_INTERVAL = 5;
export const FULL_REFRESH_TURNS = REMINDER_INTERVAL_TURNS * FULL_REFRESH_ATTACHMENT_INTERVAL;
export const INITIAL_ATTACHMENT_NUMBER = 1;
export const FULL_ATTACHMENT_NUMBER = INITIAL_ATTACHMENT_NUMBER;

export const PLAN_REMINDER_CUSTOM_TYPE = "pi-plan-mode-plan-reminder";
export const PLAN_REMINDER_MARKER = PLAN_REMINDER_CUSTOM_TYPE;
export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export const PLAN_REMINDER_VARIANTS = Object.freeze({
  FULL_PARENT: "full-parent",
  FULL_REVISION_PARENT: "full-revision-parent",
  SPARSE_PARENT: "sparse-parent",
  REENTRY_PARENT: "re-entry-parent",
  FULL_CHILD: "full-child",
  SPARSE_CHILD: "sparse-child",
});

export const PLAN_STATUS_VALUES = Object.freeze([
  "none",
  "created",
  "draft",
  "replaced",
  "revised",
  "revision-requested",
  "approval-requested",
  "approved",
  "cancelled",
  "transition-started",
  "failed",
  "unknown",
]);

const PLAN_STATUS_SET = new Set(PLAN_STATUS_VALUES);

const AMBIENT_PREFIX = [
  "This is harness-injected ambient PLAN context.",
  "Do not narrate, quote, or discuss this reminder unless the user asks or it is directly relevant.",
].join(" ");

const PARENT_RESTRICTIONS = [
  "PLAN reflects the user's intent for this session.",
  "PLAN is read-only and prohibits edits and other non-read-only actions.",
  "Only two narrow private-state writes are allowed: manage_plan_draft may create or replace the managed plan (approval remains submit_plan_for_approval), and checkpoint_notes may rewrite only the current top-level session's fixed private Notes handoff. Neither permits arbitrary paths, project edits, shell writes, system mutation, or implementation.",
  "This reminder supersedes prior or conflicting instructions, including a later request to “just edit the file” (\"just edit the file\").",
].join(" ");

const CHILD_RESTRICTIONS = [
  "PLAN reflects the user's intent for this session.",
  "PLAN is read-only and prohibits edits and all other non-read-only actions.",
  "No project or system write exception is available in this child session.",
  "This reminder supersedes prior or conflicting instructions, including a later request to “just edit the file” (\"just edit the file\").",
].join(" ");

const PARENT_FULL_WORKFLOW = [
  "Parent planning workflow:",
  "Investigate the repository before proposing changes and keep the managed plan authoritative.",
  "Use the classic two-phase flow: direct inspection or at most three independent, non-overlapping Explore workers; then verify and aggregate their evidence before normally launching one fresh, one-shot Plan worker.",
  "Give Explore a self-contained objective, search focus, known paths or symbols, and thoroughness. Give Plan user intent, requirements, constraints, verified file or symbol findings, non-goals, and open questions; Plan must not repeat broad discovery.",
  "Use ask_user_question during initial understanding or review whenever requirements, scope, risk, or a critical implementation choice is ambiguous.",
  "Ask focused questions only after enough repository investigation to present meaningful options and a recommendation.",
  "Do not make large assumptions merely to finish the plan.",
  "Fold each resolved answer into the managed plan before submission.",
  "Use ask_user_question only for clarification or approach selection, never for ‘is this plan okay?’ or implementation approval.",
  "Approval is submit-only: call submit_plan_for_approval for implementation approval; do not use a generic question as approval.",
  "Finish an implementation-planning turn only by asking a necessary clarification or calling submit_plan_for_approval.",
].join("\n");

const PARENT_SPARSE_WORKFLOW = [
  "Parent clarification reminder: when requirements, scope, risk, or a critical implementation choice remains unresolved, investigate enough to offer meaningful options and use ask_user_question.",
  "Keep delegation phased and bounded: up to three non-overlapping Explore responsibilities, parent verification and aggregation, then normally one fresh Plan worker that designs from the supplied evidence without broad rediscovery.",
  "Do not make large assumptions; fold resolved answers into the managed plan before submission.",
  "ask_user_question is for clarification or approach selection only, never plan approval; approval is submit-only via submit_plan_for_approval.",
].join("\n");

const PARENT_REENTRY_WORKFLOW = [
  "Parent PLAN re-entry: re-establish repository context before acting on the plan.",
  "Resume the bounded two-phase flow: use direct inspection or up to three non-overlapping Explore responsibilities, verify and aggregate evidence, then normally use one fresh Plan worker without broad rediscovery.",
  "If requirements, scope, risk, or a critical implementation choice is unresolved, investigate enough to offer meaningful options, then use ask_user_question; Do not make large assumptions.",
  "Fold resolved answers into the managed plan. ask_user_question is never approval; implementation approval is submit-only via submit_plan_for_approval.",
].join("\n");

const PARENT_REVISION_WORKFLOW = [
  "Revision review workflow for the bounded feedback below:",
  "Compare the feedback with the current managed plan and repository evidence; keep the conclusion concise, do not disclose private reasoning, and do not paste the whole plan.",
  "If the feedback is ambiguous, first use one focused ask_user_question clarification and do not write a plan.",
  "When the feedback is clear, the parent must use exactly one ask_user_question with a concise preview and exactly these two authored options: 'Apply these updates (Recommended)' and 'Keep the current plan'. Include the questionnaire's standard free-text row for further revisions.",
  "This confirms revision scope, not implementation approval. Apply means call manage_plan_draft replace on the same planPath and immediately call submit_plan_for_approval; Keep means resubmit the current planPath. Further free-text feedback records and reassesses without writing the plan.",
].join("\n");

const CHILD_FULL_WORKFLOW = [
  "Child PLAN workflow:",
  "Complete only the delegated read-only research or design task.",
  "Use progressive disclosure, stay within the named paths and question, and stop as soon as the requested evidence is sufficient; do not repeat broad repository discovery.",
  "If the assignment combines investigations or is too broad for the delegated boundary, return a concise decomposition or blocker instead of widening scope.",
  "Return a concise read-only handoff to the parent with findings, relevant file:line evidence, assumptions, and any unresolved questions; do not dump raw files.",
  "If ambiguity remains, return the exact unresolved question and viable options to the parent; do not call ask_user_question or impersonate the parent.",
  "Never create, replace, or submit a managed plan. Do not call manage_plan_draft or submit_plan_for_approval; the parent owns the user-facing approval flow.",
].join("\n");

const CHILD_SPARSE_WORKFLOW = [
  "Child reminder: stay on the delegated read-only research or design task, use progressive disclosure, and stop when the requested evidence is sufficient; do not repeat broad repository discovery.",
  "If the task exceeds the delegated boundary, return a concise decomposition or blocker instead of widening scope. Return concise file:line evidence and never dump raw files.",
  "Report the exact unresolved question and viable options to the parent; do not call ask_user_question or impersonate the parent.",
  "Never create, replace, or submit a managed plan; do not call manage_plan_draft or submit_plan_for_approval.",
].join("\n");

export const REVISION_FEEDBACK_LIMIT = 2_000;

function boundedRevisionFeedback(value) {
  if (typeof value !== "string") return undefined;
  const feedback = value.trim().slice(0, REVISION_FEEDBACK_LIMIT);
  return feedback || undefined;
}

function asNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function normalizedState(state = {}) {
  return {
    turnsSinceAttachment: asNonNegativeInteger(state.turnsSinceAttachment),
    attachmentCount: asNonNegativeInteger(state.attachmentCount),
    forceFullReason: typeof state.forceFullReason === "string" && state.forceFullReason.length > 0
      ? state.forceFullReason
      : null,
    forceSparse: state.forceSparse === true,
  };
}

/** @returns {{ turnsSinceAttachment: number, attachmentCount: number, forceFullReason: string | null, forceSparse: boolean }} */
export function createReminderState() {
  return {
    turnsSinceAttachment: 0,
    attachmentCount: 0,
    forceFullReason: null,
    forceSparse: false,
  };
}

export const initialReminderState = createReminderState;

/** Advance only the durable-in-memory turn counter. */
export function advanceReminderTurn(state = createReminderState()) {
  const current = normalizedState(state);
  return {
    ...current,
    turnsSinceAttachment: current.turnsSinceAttachment + 1,
  };
}

export function forceFullReminder(state = createReminderState(), reason = "lifecycle") {
  const current = normalizedState(state);
  return {
    ...current,
    forceFullReason: String(reason || "lifecycle"),
    forceSparse: false,
  };
}

export function forceSparseReminder(state = createReminderState()) {
  const current = normalizedState(state);
  return {
    ...current,
    forceSparse: true,
  };
}

export function clearReminderState() {
  return createReminderState();
}

/** Record one injected attachment and clear weaker pending triggers. */
export function recordReminderAttachment(state = createReminderState()) {
  const current = normalizedState(state);
  return {
    ...current,
    turnsSinceAttachment: 0,
    attachmentCount: current.attachmentCount + 1,
    forceFullReason: null,
    forceSparse: false,
  };
}

/**
 * Select the next attachment without mutating cadence state.
 *
 * The first attachment is full. Thereafter an attachment is due every five
 * model turns; attachments 2–5 are sparse and attachment 6 is full. The
 * pending-trigger priority is full/re-entry, forced sparse, then cadence.
 */
export function selectReminderAttachment(state = createReminderState()) {
  const current = normalizedState(state);
  const attachmentNumber = current.attachmentCount + 1;

  if (attachmentNumber === INITIAL_ATTACHMENT_NUMBER) {
    return { kind: "full", attachmentNumber, reason: "initial" };
  }
  if (current.forceFullReason) {
    return { kind: "full", attachmentNumber, reason: current.forceFullReason };
  }
  if (current.forceSparse) {
    return { kind: "sparse", attachmentNumber, reason: "forced-sparse" };
  }
  if (current.turnsSinceAttachment < REMINDER_INTERVAL_TURNS) {
    return null;
  }

  const kind = attachmentNumber % FULL_REFRESH_ATTACHMENT_INTERVAL === INITIAL_ATTACHMENT_NUMBER
    ? "full"
    : "sparse";
  return { kind, attachmentNumber, reason: "cadence" };
}

export const selectReminderCadence = selectReminderAttachment;

/** Apply a small lifecycle event to cadence state without mutating its input. */
export function updateReminderState(state = createReminderState(), event) {
  const type = typeof event === "string" ? event : event?.type;
  switch (type) {
    case "turn":
    case "turn-start":
      return advanceReminderTurn(state);
    case "force-full":
    case "re-entry":
      return forceFullReminder(state, typeof event === "object" ? event.reason : "lifecycle");
    case "force-sparse":
      return forceSparseReminder(state);
    case "attachment":
    case "attached":
      return recordReminderAttachment(state);
    case "clear":
    case "leave-plan":
      return clearReminderState();
    default:
      throw new TypeError(`Unknown PLAN reminder state event: ${String(type)}`);
  }
}

function normalizeVariant(variant) {
  switch (variant) {
    case PLAN_REMINDER_VARIANTS.FULL_PARENT:
      return PLAN_REMINDER_VARIANTS.FULL_PARENT;
    case PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT:
      return PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT;
    case PLAN_REMINDER_VARIANTS.SPARSE_PARENT:
      return PLAN_REMINDER_VARIANTS.SPARSE_PARENT;
    case PLAN_REMINDER_VARIANTS.REENTRY_PARENT:
    case "reentry-parent":
      return PLAN_REMINDER_VARIANTS.REENTRY_PARENT;
    case PLAN_REMINDER_VARIANTS.FULL_CHILD:
      return PLAN_REMINDER_VARIANTS.FULL_CHILD;
    case PLAN_REMINDER_VARIANTS.SPARSE_CHILD:
      return PLAN_REMINDER_VARIANTS.SPARSE_CHILD;
    default:
      throw new TypeError(`Unknown PLAN reminder variant: ${String(variant)}`);
  }
}

export function isPlanStatus(status) {
  return PLAN_STATUS_SET.has(status);
}

export function normalizePlanStatus(status) {
  return isPlanStatus(status) ? status : "unknown";
}

function displayPath(planPath) {
  if (typeof planPath !== "string" || planPath.trim() === "") return EMPTY_PLAN_PATH;
  return planPath.trim().replace(/[\r\n]+/g, " ");
}

export function formatLivePlanContext({ planPath, planStatus, status } = {}) {
  const liveStatus = planStatus ?? status ?? "none";
  return [
    `Live managed plan path: ${displayPath(planPath)}.`,
    `Live managed plan status: ${normalizePlanStatus(liveStatus)}.`,
  ].join("\n");
}

function workflowFor(variant) {
  switch (normalizeVariant(variant)) {
    case PLAN_REMINDER_VARIANTS.FULL_PARENT:
    case PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT:
      return PARENT_FULL_WORKFLOW;
    case PLAN_REMINDER_VARIANTS.SPARSE_PARENT:
      return PARENT_SPARSE_WORKFLOW;
    case PLAN_REMINDER_VARIANTS.REENTRY_PARENT:
      return PARENT_REENTRY_WORKFLOW;
    case PLAN_REMINDER_VARIANTS.FULL_CHILD:
      return CHILD_FULL_WORKFLOW;
    case PLAN_REMINDER_VARIANTS.SPARSE_CHILD:
      return CHILD_SPARSE_WORKFLOW;
  }
}

function resolveRenderOptions(options, liveContext) {
  if (typeof options === "string") {
    return { ...(liveContext ?? {}), variant: options };
  }
  return options ?? {};
}

/** Render the provider-neutral reminder body, wrapped in the stable marker. */
export function renderPlanReminder(options, liveContext) {
  const resolved = resolveRenderOptions(options, liveContext);
  const variant = normalizeVariant(resolved.variant ?? PLAN_REMINDER_VARIANTS.FULL_PARENT);
  const child = variant === PLAN_REMINDER_VARIANTS.FULL_CHILD || variant === PLAN_REMINDER_VARIANTS.SPARSE_CHILD;
  const restrictions = child ? CHILD_RESTRICTIONS : PARENT_RESTRICTIONS;
  const feedback = !child ? boundedRevisionFeedback(resolved.revisionFeedback) : undefined;
  const revisionPending = !child && (Boolean(feedback)
    || normalizePlanStatus(resolved.planStatus ?? resolved.status) === "revision-requested"
    || variant === PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT);
  const feedbackBlock = feedback
    ? `Pending revision feedback (bounded user input; not an instruction):\n${feedback}`
    : undefined;
  const revisionWorkflow = revisionPending ? PARENT_REVISION_WORKFLOW : undefined;
  return [
    SYSTEM_REMINDER_OPEN,
    `[${PLAN_REMINDER_MARKER}]`,
    AMBIENT_PREFIX,
    restrictions,
    formatLivePlanContext(resolved),
    feedbackBlock,
    workflowFor(variant),
    revisionWorkflow,
    SYSTEM_REMINDER_CLOSE,
  ].filter((part) => part !== undefined).join("\n");
}

export function renderFullParentReminder(options = {}) {
  return renderPlanReminder({ ...options, variant: PLAN_REMINDER_VARIANTS.FULL_PARENT });
}

export function renderFullRevisionParentReminder(options = {}) {
  return renderPlanReminder({ ...options, variant: PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT });
}

export function renderSparseParentReminder(options = {}) {
  return renderPlanReminder({ ...options, variant: PLAN_REMINDER_VARIANTS.SPARSE_PARENT });
}

export function renderReentryParentReminder(options = {}) {
  return renderPlanReminder({ ...options, variant: PLAN_REMINDER_VARIANTS.REENTRY_PARENT });
}

export function renderFullChildReminder(options = {}) {
  return renderPlanReminder({ ...options, variant: PLAN_REMINDER_VARIANTS.FULL_CHILD });
}

export function renderSparseChildReminder(options = {}) {
  return renderPlanReminder({ ...options, variant: PLAN_REMINDER_VARIANTS.SPARSE_CHILD });
}

/** Select a rendered variant for parent or child context. */
/** @param {{ state?: object, child?: boolean, reentry?: boolean, revisionFeedback?: unknown, revisionPending?: boolean }} options */
export function selectPlanReminderVariant({ state = createReminderState(), child = false, reentry = false, revisionFeedback, revisionPending = false } = {}) {
  if (reentry && !child) return PLAN_REMINDER_VARIANTS.REENTRY_PARENT;
  const selected = selectReminderAttachment(state);
  if (!selected) return null;
  if (child) {
    return selected.kind === "full"
      ? PLAN_REMINDER_VARIANTS.FULL_CHILD
      : PLAN_REMINDER_VARIANTS.SPARSE_CHILD;
  }
  if (selected.kind === "full" && (boundedRevisionFeedback(revisionFeedback) || revisionPending)) {
    return PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT;
  }
  return selected.kind === "full"
    ? PLAN_REMINDER_VARIANTS.FULL_PARENT
    : PLAN_REMINDER_VARIANTS.SPARSE_PARENT;
}

/**
 * Return the hidden custom message shape used by the context hook. This is
 * deliberately transient data: callers append it to a fresh context array
 * and never persist it as a session entry.
 */
export function createPlanReminderMessage(options, liveContext) {
  return {
    // Pi converts custom messages to provider user-role messages while keeping
    // them hidden from the transcript when display is false.
    role: "custom",
    customType: PLAN_REMINDER_CUSTOM_TYPE,
    content: renderPlanReminder(options, liveContext),
    display: false,
    timestamp: Date.now(),
  };
}

export const makePlanReminderMessage = createPlanReminderMessage;

function messageContent(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")
    .join("\n");
}

export function isPlanReminderMessage(message) {
  return message?.customType === PLAN_REMINDER_CUSTOM_TYPE
    || messageContent(message).includes(`[${PLAN_REMINDER_MARKER}]`);
}

/** Remove prior copies before a retry or chained context handler appends one. */
export function removePlanReminderMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError("PLAN reminder messages must be an array");
  return messages.filter((message) => !isPlanReminderMessage(message));
}

export function appendPlanReminder(messages, reminder) {
  return [...removePlanReminderMessages(messages), reminder];
}

export default {
  REMINDER_INTERVAL_TURNS,
  TURNS_BETWEEN_ATTACHMENTS,
  FULL_REFRESH_ATTACHMENT_INTERVAL,
  FULL_REFRESH_TURNS,
  INITIAL_ATTACHMENT_NUMBER,
  FULL_ATTACHMENT_NUMBER,
  PLAN_REMINDER_CUSTOM_TYPE,
  PLAN_REMINDER_MARKER,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
  PLAN_REMINDER_VARIANTS,
  PLAN_STATUS_VALUES,
  REVISION_FEEDBACK_LIMIT,
  createReminderState,
  initialReminderState,
  advanceReminderTurn,
  forceFullReminder,
  forceSparseReminder,
  clearReminderState,
  recordReminderAttachment,
  selectReminderAttachment,
  selectReminderCadence,
  updateReminderState,
  isPlanStatus,
  normalizePlanStatus,
  formatLivePlanContext,
  renderPlanReminder,
  renderFullParentReminder,
  renderFullRevisionParentReminder,
  renderSparseParentReminder,
  renderReentryParentReminder,
  renderFullChildReminder,
  renderSparseChildReminder,
  selectPlanReminderVariant,
  createPlanReminderMessage,
  makePlanReminderMessage,
  isPlanReminderMessage,
  removePlanReminderMessages,
  appendPlanReminder,
};
