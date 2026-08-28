/**
 * Pure, transient lifecycle state for the parent ORCHESTRATOR session.
 *
 * This module deliberately has no Pi or event-bus dependency.  It keeps only
 * bounded lifecycle metadata, never agent results or errors, and all renderers
 * return provider-neutral hidden-message content.
 */

export const ORCHESTRATOR_REMINDER_CUSTOM_TYPE = "pi-plan-mode-orchestrator-reminder";
export const ORCHESTRATOR_REMINDER_MARKER = ORCHESTRATOR_REMINDER_CUSTOM_TYPE;
export const SYSTEM_REMINDER_OPEN = "<system-reminder>";
export const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

export const ORCHESTRATOR_PHASES = Object.freeze({
  RE_ENTRY: "re-entry",
  IMPLEMENTING: "implementing",
  VERIFICATION_NEEDED: "verification-needed",
  VERIFYING: "verifying",
  VERIFICATION_FAILED: "verification-failed",
  SIGNOFF_READY: "signoff-ready",
});
export const ORCHESTRATOR_PHASE_VALUES = Object.freeze(Object.values(ORCHESTRATOR_PHASES));

export const ORCHESTRATOR_AGENT_TYPES = Object.freeze({
  IMPLEMENTATION_WORKER: "ImplementationWorker",
  LUNA_COMPLIANCE: "LunaCompliance",
  LUNA_TEST_VERIFIER: "LunaTestVerifier",
});

export const ORCHESTRATOR_AGENT_STATUSES = Object.freeze({
  STARTED: "started",
  COMPLETED: "completed",
  FAILED: "failed",
});

// Lifecycle state is intentionally bounded even if a caller emits an
// unbounded stream of worker events.  A new implementation cycle also clears
// old verifier records, so stale verification cannot make sign-off ready.
export const MAX_TRACKED_ORCHESTRATOR_AGENTS = 16;
export const MAX_AGENT_ID_LENGTH = 160;
export const MAX_AGENT_DESCRIPTION_LENGTH = 240;

const PHASE_SET = new Set(Object.values(ORCHESTRATOR_PHASES));
const STATUS_SET = new Set(Object.values(ORCHESTRATOR_AGENT_STATUSES));

const PHASE_TEXT = Object.freeze({
  [ORCHESTRATOR_PHASES.RE_ENTRY]: [
    "ORCHESTRATOR re-entry: re-establish repository context and inspect the current diff before relying on prior lifecycle assumptions.",
    "Treat this as a conservative reset. The parent remains accountable for delegation, source inspection, diagnostics, tests, and sign-off.",
  ].join("\n"),
  [ORCHESTRATOR_PHASES.IMPLEMENTING]: [
    "ORCHESTRATOR implementation is in progress. Do not infer completion from this reminder or from an agent's claimed output.",
    "Let the tracked implementation workers settle, then inspect the actual changed files before starting or trusting verification.",
  ].join("\n"),
  [ORCHESTRATOR_PHASES.VERIFICATION_NEEDED]: [
    "ORCHESTRATOR verification is needed after implementation work. Inspect the actual diff and run fresh diagnostics and tests.",
    "Use the dedicated LunaCompliance and LunaTestVerifier agents as appropriate; their completion is evidence, not parent sign-off.",
  ].join("\n"),
  [ORCHESTRATOR_PHASES.VERIFYING]: [
    "ORCHESTRATOR verification is in progress after implementation work. Wait for both required verifier agents to complete.",
    "Their completion is evidence, not parent sign-off; inspect the actual diff and independently run fresh diagnostics and tests.",
  ].join("\n"),
  [ORCHESTRATOR_PHASES.VERIFICATION_FAILED]: [
    "ORCHESTRATOR verification failed or tracked implementation work failed.",
    "Inspect the actual repository state, remediate every actionable gap, and rerun the necessary verification before sign-off. Do not claim success from raw agent output.",
  ].join("\n"),
  [ORCHESTRATOR_PHASES.SIGNOFF_READY]: [
    "ORCHESTRATOR verification agents have completed for the tracked implementation cycle.",
    "This is only a soft sign-off cue: inspect the real diff and independently run fresh diagnostics and tests before reporting completion.",
  ].join("\n"),
});

function boundedString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function canonicalKey(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const AGENT_TYPE_KEYS = new Map([
  ["implementationworker", ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER],
  ["lunacompliance", ORCHESTRATOR_AGENT_TYPES.LUNA_COMPLIANCE],
  ["lunatestverifier", ORCHESTRATOR_AGENT_TYPES.LUNA_TEST_VERIFIER],
]);

/**
 * Resolve only the three lifecycle roles owned by this reminder.  Unknown
 * agent names, including ordinary general-purpose children, are ignored.
 */
export function classifyOrchestratorAgent(value) {
  const candidates = typeof value === "string"
    ? [value]
    : [
      value?.type,
      value?.subagent_type,
      value?.subagentType,
      value?.agentType,
      value?.agent_type,
      value?.agentName,
      value?.profile,
      value?.name,
      value?.agent?.type,
      value?.agent?.subagent_type,
      value?.agent?.subagentType,
      value?.agent?.name,
    ];
  for (const candidate of candidates) {
    const resolved = AGENT_TYPE_KEYS.get(canonicalKey(candidate));
    if (resolved) return resolved;
  }
  return null;
}

function normalizePhase(value) {
  return PHASE_SET.has(value) ? value : ORCHESTRATOR_PHASES.RE_ENTRY;
}

function normalizeStatus(value) {
  return STATUS_SET.has(value) ? value : ORCHESTRATOR_AGENT_STATUSES.STARTED;
}

function normalizeAgent(agent) {
  const type = classifyOrchestratorAgent(agent);
  if (!type) return null;
  const status = normalizeStatus(agent?.status);
  const id = boundedString(agent?.id, MAX_AGENT_ID_LENGTH) || `${type}:anonymous`;
  return {
    id,
    type,
    description: boundedString(agent?.description, MAX_AGENT_DESCRIPTION_LENGTH),
    status,
  };
}

function normalizeState(state = {}) {
  const agents = [];
  if (Array.isArray(state?.agents)) {
    for (const rawAgent of state.agents) {
      const agent = normalizeAgent(rawAgent);
      if (!agent) continue;
      const existing = agents.findIndex((item) => item.id === agent.id);
      if (existing >= 0) agents[existing] = agent;
      else if (agents.length < MAX_TRACKED_ORCHESTRATOR_AGENTS) agents.push(agent);
    }
  }
  return {
    phase: normalizePhase(state?.phase),
    agents,
  };
}

/**
 * @typedef {{
 *   phase: "re-entry" | "implementing" | "verification-needed" | "verifying" | "verification-failed" | "signoff-ready",
 *   agents: Array<{ id: string, type: "ImplementationWorker" | "LunaCompliance" | "LunaTestVerifier", description: string, status: "started" | "completed" | "failed" }>
 * }} OrchestratorState
 */

/** @returns {OrchestratorState} */
export function createOrchestratorState() {
  return {
    phase: ORCHESTRATOR_PHASES.RE_ENTRY,
    agents: [],
  };
}

/** Reset uncertain live state without persisting any lifecycle detail. */
export function resetOrchestratorState() {
  return createOrchestratorState();
}

function eventPayload(event, payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
  if (event && typeof event === "object" && event.data && typeof event.data === "object") return event.data;
  if (event && typeof event === "object" && event.payload && typeof event.payload === "object") return event.payload;
  return event && typeof event === "object" ? event : {};
}

function eventName(event) {
  if (typeof event === "string") return event;
  if (!event || typeof event !== "object") return "";
  return String(event.event ?? event.channel ?? event.kind ?? event.action ?? event.lifecycle ?? "");
}

function eventStatus(event, payload) {
  const name = eventName(event).toLowerCase();
  if (name.endsWith(":started") || name === "started" || name === "start") return ORCHESTRATOR_AGENT_STATUSES.STARTED;
  if (name.endsWith(":completed") || name === "completed" || name === "complete" || name === "success" || name === "succeeded") return ORCHESTRATOR_AGENT_STATUSES.COMPLETED;
  if (name.endsWith(":failed") || name === "failed" || name === "failure" || name === "error") return ORCHESTRATOR_AGENT_STATUSES.FAILED;
  const status = payload?.status;
  if (status === "running" || status === "queued" || status === "started") return ORCHESTRATOR_AGENT_STATUSES.STARTED;
  if (status === "completed" || status === "success" || status === "succeeded") return ORCHESTRATOR_AGENT_STATUSES.COMPLETED;
  if (status === "failed" || status === "error" || status === "stopped" || status === "aborted") return ORCHESTRATOR_AGENT_STATUSES.FAILED;
  return null;
}

function lifecycleReset(event) {
  const names = new Set([
    eventName(event).toLowerCase(),
    typeof event === "object" && event !== null ? String(event.type ?? "").toLowerCase() : "",
  ]);
  return [
    "re-entry", "reentry", "reset", "orchestrator-entry", "entry", "restore", "session-restore",
    "tree", "session-tree", "compact", "session-compact", "compaction", "compaction-success",
    "compaction-failed", "session_compact", "session_compact_failed",
  ].some((name) => names.has(name));
}

function payloadWithEvent(event, payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload;
  return eventPayload(event, payload);
}

function upsertAgent(agents, agent) {
  const next = agents.map((item) => ({ ...item }));
  const index = next.findIndex((item) => item.id === agent.id);
  if (index >= 0) {
    next[index] = agent;
    return next;
  }
  if (next.length >= MAX_TRACKED_ORCHESTRATOR_AGENTS) next.shift();
  next.push(agent);
  return next;
}

function implementationAgents(agents) {
  return agents.filter((agent) => agent.type === ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER);
}

function verifierAgents(agents) {
  return agents.filter((agent) => agent.type !== ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER);
}

function allImplementationCompleted(agents) {
  const workers = implementationAgents(agents);
  return workers.length > 0 && workers.every((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.COMPLETED);
}

function hasImplementationInProgress(agents) {
  return implementationAgents(agents).some((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.STARTED);
}

function hasImplementationFailure(agents) {
  return implementationAgents(agents).some((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.FAILED);
}

function verifiersReady(agents) {
  const statuses = new Map(verifierAgents(agents).map((agent) => [agent.type, agent.status]));
  return statuses.get(ORCHESTRATOR_AGENT_TYPES.LUNA_COMPLIANCE) === ORCHESTRATOR_AGENT_STATUSES.COMPLETED
    && statuses.get(ORCHESTRATOR_AGENT_TYPES.LUNA_TEST_VERIFIER) === ORCHESTRATOR_AGENT_STATUSES.COMPLETED;
}

function verifierFailure(agents) {
  return verifierAgents(agents).some((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.FAILED);
}

function verifierHasStarted(agents) {
  return verifierAgents(agents).some((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.STARTED
    || agent.status === ORCHESTRATOR_AGENT_STATUSES.COMPLETED);
}

function phaseAfterEvent(agents, changedType, changedStatus) {
  if (hasImplementationFailure(agents) || verifierFailure(agents)) return ORCHESTRATOR_PHASES.VERIFICATION_FAILED;
  if (changedType === ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER && changedStatus === ORCHESTRATOR_AGENT_STATUSES.STARTED) {
    return ORCHESTRATOR_PHASES.IMPLEMENTING;
  }
  if (hasImplementationInProgress(agents) || !allImplementationCompleted(agents)) return ORCHESTRATOR_PHASES.IMPLEMENTING;
  if (verifiersReady(agents)) return ORCHESTRATOR_PHASES.SIGNOFF_READY;
  if (verifierHasStarted(agents)) return ORCHESTRATOR_PHASES.VERIFYING;
  return ORCHESTRATOR_PHASES.VERIFICATION_NEEDED;
}

/**
 * Apply one lifecycle event without mutating `state` or retaining event
 * payloads.  The optional third argument supports the event-bus shape used by
 * the extension: updateOrchestratorState(state, "subagents:completed", data).
 *
 * @param {OrchestratorState} state
 * @param {unknown} event
 * @param {unknown} [payload]
 * @returns {OrchestratorState}
 */
export function updateOrchestratorState(state = createOrchestratorState(), event, payload) {
  const current = normalizeState(state);
  if (lifecycleReset(event)) return createOrchestratorState();

  const data = payloadWithEvent(event, payload);
  const type = classifyOrchestratorAgent(data);
  const status = eventStatus(event, data);
  if (!type || !status) return current;

  const eventId = boundedString(data.id ?? data.agentId ?? data.agent_id ?? data.subagentId ?? data.subagent_id, MAX_AGENT_ID_LENGTH);
  const previous = current.agents.find((item) => item.id === (eventId || `${type}:anonymous`));
  const agent = normalizeAgent({
    id: eventId,
    type,
    description: data.description ?? previous?.description,
    status,
  });
  const agents = upsertAgent(current.agents, agent);

  // A new implementation worker starts a new verification cycle.  This is
  // conservative and prevents old verifier completions from authorizing a new
  // implementation cycle.
  const startsNewImplementationCycle = type === ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER
    && status === ORCHESTRATOR_AGENT_STATUSES.STARTED
    && current.phase !== ORCHESTRATOR_PHASES.IMPLEMENTING;
  const cycleAgents = startsNewImplementationCycle ? [agent] : agents;

  return {
    phase: phaseAfterEvent(cycleAgents, type, status),
    agents: cycleAgents,
  };
}

export const reduceOrchestratorState = updateOrchestratorState;

function stateForRender(value) {
  if (typeof value === "string") return { phase: normalizePhase(value), agents: [] };
  if (value?.state && typeof value.state === "object") return normalizeState(value.state);
  return normalizeState(value);
}

function roleSummary(agents) {
  const roles = [
    ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER,
    ORCHESTRATOR_AGENT_TYPES.LUNA_COMPLIANCE,
    ORCHESTRATOR_AGENT_TYPES.LUNA_TEST_VERIFIER,
  ];
  const statusFor = (type) => {
    const records = agents.filter((agent) => agent.type === type);
    if (records.length === 0) return "not-seen";
    if (records.some((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.FAILED)) return "failed";
    if (records.some((agent) => agent.status === ORCHESTRATOR_AGENT_STATUSES.STARTED)) return "started";
    return "completed";
  };
  return roles.map((role) => `${role}=${statusFor(role)}`).join(", ");
}

/**
 * Render only bounded phase guidance; agent output is never included.
 * @param {OrchestratorState | string} state
 */
export function renderOrchestratorReminder(state = createOrchestratorState()) {
  const current = stateForRender(state);
  return [
    SYSTEM_REMINDER_OPEN,
    `[${ORCHESTRATOR_REMINDER_MARKER}]`,
    "This is harness-injected ambient ORCHESTRATOR context. Do not narrate, quote, or discuss this reminder unless directly relevant.",
    "ORCHESTRATOR lifecycle guidance is soft and never replaces the existing hard tool-routing policy.",
    `Current lifecycle phase: ${current.phase}.`,
    `Tracked lifecycle roles: ${roleSummary(current.agents)}.`,
    PHASE_TEXT[current.phase],
    SYSTEM_REMINDER_CLOSE,
  ].join("\n");
}

/**
 * Return the hidden custom message shape used by the transient context hook.
 * @param {OrchestratorState} state
 */
export function createOrchestratorReminderMessage(state = createOrchestratorState()) {
  return {
    role: "custom",
    customType: ORCHESTRATOR_REMINDER_CUSTOM_TYPE,
    content: renderOrchestratorReminder(state),
    display: false,
    timestamp: Date.now(),
  };
}

function messageContent(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")
    .join("\n");
}

export function isOrchestratorReminderMessage(message) {
  return message?.customType === ORCHESTRATOR_REMINDER_CUSTOM_TYPE
    || messageContent(message).includes(`[${ORCHESTRATOR_REMINDER_MARKER}]`);
}

export function removeOrchestratorReminderMessages(messages) {
  if (!Array.isArray(messages)) throw new TypeError("ORCHESTRATOR reminder messages must be an array");
  return messages.filter((message) => !isOrchestratorReminderMessage(message));
}

export function appendOrchestratorReminder(messages, reminder) {
  return [...removeOrchestratorReminderMessages(messages), reminder];
}

export default {
  ORCHESTRATOR_REMINDER_CUSTOM_TYPE,
  ORCHESTRATOR_REMINDER_MARKER,
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
  ORCHESTRATOR_PHASES,
  ORCHESTRATOR_PHASE_VALUES,
  ORCHESTRATOR_AGENT_TYPES,
  ORCHESTRATOR_AGENT_STATUSES,
  MAX_TRACKED_ORCHESTRATOR_AGENTS,
  MAX_AGENT_ID_LENGTH,
  MAX_AGENT_DESCRIPTION_LENGTH,
  classifyOrchestratorAgent,
  createOrchestratorState,
  resetOrchestratorState,
  updateOrchestratorState,
  reduceOrchestratorState,
  renderOrchestratorReminder,
  createOrchestratorReminderMessage,
  isOrchestratorReminderMessage,
  removeOrchestratorReminderMessages,
  appendOrchestratorReminder,
};
