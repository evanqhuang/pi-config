import test from "node:test";
import assert from "node:assert/strict";
import {
  appendOrchestratorReminder,
  classifyOrchestratorAgent,
  createOrchestratorReminderMessage,
  createOrchestratorState,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_TRACKED_ORCHESTRATOR_AGENTS,
  ORCHESTRATOR_AGENT_STATUSES,
  ORCHESTRATOR_AGENT_TYPES,
  ORCHESTRATOR_PHASES,
  ORCHESTRATOR_REMINDER_CUSTOM_TYPE,
  ORCHESTRATOR_REMINDER_MARKER,
  reduceOrchestratorState,
  renderOrchestratorReminder,
  resetOrchestratorState,
  updateOrchestratorState,
  isOrchestratorReminderMessage,
  removeOrchestratorReminderMessages,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../src/orchestrator-reminder.mjs";

function event(name, type, id = type, description = "owned implementation slice") {
  return {
    event: name,
    data: { id, type, description, result: "raw result must not appear", error: "raw error must not appear" },
  };
}

function apply(state, name, type, id = type) {
  return updateOrchestratorState(state, event(name, type, id));
}

test("classifies only the three canonical orchestrator roles", () => {
  assert.equal(classifyOrchestratorAgent("ImplementationWorker"), ORCHESTRATOR_AGENT_TYPES.IMPLEMENTATION_WORKER);
  assert.equal(classifyOrchestratorAgent({ subagent_type: "lunacompliance" }), ORCHESTRATOR_AGENT_TYPES.LUNA_COMPLIANCE);
  assert.equal(classifyOrchestratorAgent({ agentType: "LunaTestVerifier" }), ORCHESTRATOR_AGENT_TYPES.LUNA_TEST_VERIFIER);
  assert.equal(classifyOrchestratorAgent({ type: "general-purpose" }), null);
  assert.equal(classifyOrchestratorAgent({ type: "ImplementationWorkerish" }), null);
});

test("lifecycle transitions are pure and require both verification agents", () => {
  let state = createOrchestratorState();
  const initial = state;
  state = apply(state, "subagents:started", "ImplementationWorker", "worker-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.IMPLEMENTING);
  assert.deepEqual(initial, createOrchestratorState());

  state = apply(state, "subagents:completed", "ImplementationWorker", "worker-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.VERIFICATION_NEEDED);
  state = apply(state, "subagents:started", "LunaCompliance", "compliance-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.VERIFYING);
  state = apply(state, "subagents:completed", "LunaCompliance", "compliance-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.VERIFYING);
  state = apply(state, "subagents:started", "LunaTestVerifier", "tests-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.VERIFYING);
  state = apply(state, "subagents:completed", "LunaTestVerifier", "tests-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.SIGNOFF_READY);
  assert.deepEqual(state.agents.map(({ id, type, status }) => ({ id, type, status })), [
    { id: "worker-1", type: "ImplementationWorker", status: "completed" },
    { id: "compliance-1", type: "LunaCompliance", status: "completed" },
    { id: "tests-1", type: "LunaTestVerifier", status: "completed" },
  ]);
});

test("parallel workers remain tracked and any failure requires remediation", () => {
  let state = createOrchestratorState();
  state = apply(state, "subagents:started", "ImplementationWorker", "worker-1");
  state = apply(state, "subagents:started", "ImplementationWorker", "worker-2");
  state = apply(state, "subagents:completed", "ImplementationWorker", "worker-1");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.IMPLEMENTING);
  state = apply(state, "subagents:failed", "ImplementationWorker", "worker-2");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.VERIFICATION_FAILED);

  // Retrying a failed worker starts a fresh implementation cycle and discards
  // old verifier state rather than accidentally authorizing sign-off.
  state = apply(state, "subagents:started", "ImplementationWorker", "worker-3");
  assert.equal(state.phase, ORCHESTRATOR_PHASES.IMPLEMENTING);
  assert.deepEqual(state.agents.map((agent) => agent.type), ["ImplementationWorker"]);
});

test("unknown events and agents do not change state, and lifecycle resets are conservative", () => {
  let state = createOrchestratorState();
  state = apply(state, "subagents:started", "ImplementationWorker", "worker-1");
  const beforeUnknown = structuredClone(state);
  assert.deepEqual(updateOrchestratorState(state, event("subagents:completed", "general-purpose")), beforeUnknown);
  assert.deepEqual(updateOrchestratorState(state, { event: "subagents:unknown", data: { type: "ImplementationWorker" } }), beforeUnknown);
  assert.deepEqual(updateOrchestratorState(state, { type: "session-tree" }), createOrchestratorState());
  assert.deepEqual(resetOrchestratorState(), createOrchestratorState());
});

test("state metadata and rendered output stay bounded and exclude raw output", () => {
  let state = createOrchestratorState();
  const description = "x".repeat(MAX_AGENT_DESCRIPTION_LENGTH + 100);
  for (let index = 0; index < MAX_TRACKED_ORCHESTRATOR_AGENTS + 8; index += 1) {
    state = updateOrchestratorState(state, {
      event: "subagents:started",
      data: {
        id: `worker-${index}`,
        type: "ImplementationWorker",
        description,
        result: `secret-result-${index}`,
        error: `secret-error-${index}`,
      },
    });
  }
  assert.ok(state.agents.length <= MAX_TRACKED_ORCHESTRATOR_AGENTS);
  assert.ok(state.agents.every((agent) => agent.description.length <= MAX_AGENT_DESCRIPTION_LENGTH));
  const rendered = renderOrchestratorReminder(state);
  assert.match(rendered, new RegExp(`^${SYSTEM_REMINDER_OPEN}`));
  assert.match(rendered, new RegExp(`${SYSTEM_REMINDER_CLOSE}$`));
  assert.ok(rendered.includes(`[${ORCHESTRATOR_REMINDER_MARKER}]`));
  assert.doesNotMatch(rendered, /secret-result|secret-error/);
  assert.doesNotMatch(rendered, /<system-reminder>.*PLAN/s);
});

test("hidden transient reminders deduplicate without mutating input", () => {
  const first = createOrchestratorReminderMessage(createOrchestratorState());
  const replacement = createOrchestratorReminderMessage({ phase: ORCHESTRATOR_PHASES.SIGNOFF_READY });
  const ordinary = { role: "user", content: "continue" };
  const messages = [ordinary, first, { customType: ORCHESTRATOR_REMINDER_CUSTOM_TYPE, content: "stale" }];
  const cleaned = removeOrchestratorReminderMessages(messages);
  assert.deepEqual(cleaned, [ordinary]);
  assert.equal(messages.length, 3);
  const appended = appendOrchestratorReminder(messages, replacement);
  assert.equal(appended.filter(isOrchestratorReminderMessage).length, 1);
  assert.equal(appended.at(-1), replacement);
  assert.equal(replacement.role, "custom");
  assert.equal(replacement.customType, ORCHESTRATOR_REMINDER_CUSTOM_TYPE);
  assert.equal(replacement.display, false);
});

test("event-bus overload accepts a plain channel and payload", () => {
  let state = reduceOrchestratorState(createOrchestratorState(), "subagents:started", {
    id: "worker-1", type: "ImplementationWorker", description: "worker",
  });
  state = reduceOrchestratorState(state, "subagents:completed", {
    id: "worker-1", type: "ImplementationWorker", description: "worker",
  });
  assert.equal(state.phase, ORCHESTRATOR_PHASES.VERIFICATION_NEEDED);
  assert.equal(state.agents[0].status, ORCHESTRATOR_AGENT_STATUSES.COMPLETED);
});
