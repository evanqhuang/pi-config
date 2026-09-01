import test from "node:test";
import assert from "node:assert/strict";
import {
  appendPlanReminder,
  advanceReminderTurn,
  createPlanReminderMessage,
  createReminderState,
  forceFullReminder,
  forceSparseReminder,
  FULL_REFRESH_ATTACHMENT_INTERVAL,
  FULL_REFRESH_TURNS,
  isPlanReminderMessage,
  PLAN_REMINDER_CUSTOM_TYPE,
  PLAN_REMINDER_MARKER,
  PLAN_REMINDER_VARIANTS,
  REVISION_FEEDBACK_LIMIT,
  recordReminderAttachment,
  REMINDER_INTERVAL_TURNS,
  removePlanReminderMessages,
  renderFullChildReminder,
  renderFullParentReminder,
  renderFullRevisionParentReminder,
  renderPlanReminder,
  renderReentryParentReminder,
  renderSparseChildReminder,
  renderSparseParentReminder,
  selectPlanReminderVariant,
  selectReminderAttachment,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
  updateReminderState,
} from "../src/plan-reminder.mjs";

function advanceUntilDue(state) {
  let next = state;
  for (let turn = 0; turn < REMINDER_INTERVAL_TURNS; turn += 1) {
    next = advanceReminderTurn(next);
  }
  return next;
}

function coreAssertions(reminder, path, status, { child = false } = {}) {
  assert.match(reminder, new RegExp(`^${SYSTEM_REMINDER_OPEN.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
  assert.ok(reminder.includes(`[${PLAN_REMINDER_MARKER}]`));
  assert.ok(reminder.endsWith(SYSTEM_REMINDER_CLOSE));
  assert.ok(reminder.includes("harness-injected ambient PLAN context"));
  assert.ok(reminder.includes("Do not narrate"));
  assert.ok(reminder.includes("PLAN reflects the user's intent"));
  assert.ok(reminder.includes("non-read-only action"));
  if (child) {
    assert.ok(reminder.includes("No project or system write exception is available"));
    assert.doesNotMatch(reminder, /The only exception is the managed plan mechanism/);
  } else {
    assert.ok(reminder.includes("manage_plan_draft"));
    assert.ok(reminder.includes("checkpoint_notes"));
    assert.ok(reminder.includes("fixed private Notes handoff"));
    assert.ok(reminder.includes("Neither permits arbitrary paths"));
  }
  assert.ok(reminder.includes("supersedes prior or conflicting instructions"));
  assert.ok(reminder.includes("just edit the file"));
  assert.ok(reminder.includes(`Live managed plan path: ${path}.`));
  assert.ok(reminder.includes(`Live managed plan status: ${status}.`));
}

test("named cadence constants describe five-turn attachments and 25-turn full refreshes", () => {
  assert.equal(REMINDER_INTERVAL_TURNS, 5);
  assert.equal(FULL_REFRESH_ATTACHMENT_INTERVAL, 5);
  assert.equal(FULL_REFRESH_TURNS, 25);
});

test("cadence starts full at attachment one, sparsifies attachments two through five, then refreshes at six", () => {
  let state = createReminderState();
  const first = selectReminderAttachment(state);
  assert.deepEqual(first, { kind: "full", attachmentNumber: 1, reason: "initial" });
  const untouched = state;
  state = recordReminderAttachment(state);
  assert.deepEqual(untouched, createReminderState());

  for (let attachmentNumber = 2; attachmentNumber <= 5; attachmentNumber += 1) {
    for (let turn = 0; turn < REMINDER_INTERVAL_TURNS - 1; turn += 1) {
      state = advanceReminderTurn(state);
      assert.equal(selectReminderAttachment(state), null);
    }
    state = advanceReminderTurn(state);
    const selected = selectReminderAttachment(state);
    assert.equal(selected?.attachmentNumber, attachmentNumber);
    assert.equal(selected?.kind, "sparse");
    state = recordReminderAttachment(state);
  }

  state = advanceUntilDue(state);
  assert.deepEqual(selectReminderAttachment(state), {
    kind: "full",
    attachmentNumber: 6,
    reason: "cadence",
  });
});

test("turn updates are pure and pending full beats sparse and cadence triggers", () => {
  const initial = createReminderState();
  const afterTurn = updateReminderState(initial, { type: "turn" });
  assert.equal(afterTurn.turnsSinceAttachment, 1);
  assert.equal(initial.turnsSinceAttachment, 0);

  let state = forceSparseReminder(recordReminderAttachment(initial));
  state = forceFullReminder(state, "compaction-reentry");
  assert.deepEqual(selectReminderAttachment(state), {
    kind: "full",
    attachmentNumber: 2,
    reason: "compaction-reentry",
  });
  assert.equal(selectPlanReminderVariant({ state, reentry: true }), PLAN_REMINDER_VARIANTS.REENTRY_PARENT);

  const consumed = updateReminderState(state, { type: "attachment" });
  assert.equal(consumed.attachmentCount, 2);
  assert.equal(consumed.turnsSinceAttachment, 0);
  assert.equal(consumed.forceFullReason, null);
  assert.equal(consumed.forceSparse, false);
});

test("forced sparse state is immediate and leaving PLAN clears pending cadence state", () => {
  let state = recordReminderAttachment(createReminderState());
  state = forceSparseReminder(state);
  assert.deepEqual(selectReminderAttachment(state), {
    kind: "sparse",
    attachmentNumber: 2,
    reason: "forced-sparse",
  });
  assert.deepEqual(updateReminderState(state, "leave-plan"), createReminderState());
});

test("every parent and child renderer carries ambient restrictions and live plan context", () => {
  const path = "/private/plans/example/plan.md";
  const status = "revision-requested";
  const reminders = [
    renderFullParentReminder({ planPath: path, planStatus: status }),
    renderSparseParentReminder({ planPath: path, planStatus: status }),
    renderReentryParentReminder({ planPath: path, planStatus: status }),
    renderFullChildReminder({ planPath: path, planStatus: status }),
    renderSparseChildReminder({ planPath: path, planStatus: status }),
  ];
  for (const [index, reminder] of reminders.entries()) {
    coreAssertions(reminder, path, status, { child: index >= 3 });
  }
});

test("full parent reminder preserves clarification and submit-only approval contract", () => {
  const reminder = renderFullParentReminder({ planPath: "/plans/plan.md", planStatus: "draft" });
  for (const required of [
    "initial understanding or review",
    "requirements, scope, risk, or a critical implementation choice",
    "enough repository investigation",
    "meaningful options and a recommendation",
    "Do not make large assumptions",
    "Fold each resolved answer into the managed plan before submission",
    "ask_user_question only for clarification or approach selection",
    "never for ‘is this plan okay?’ or implementation approval",
    "Approval is submit-only",
    "submit_plan_for_approval",
    "Finish an implementation-planning turn only by asking a necessary clarification or calling submit_plan_for_approval",
  ]) {
    assert.ok(reminder.includes(required), `missing contract text: ${required}`);
  }
});

test("sparse and re-entry parent reminders keep ambiguity active without replacing the full workflow", () => {
  for (const reminder of [
    renderSparseParentReminder(),
    renderReentryParentReminder(),
  ]) {
    assert.match(reminder, /use ask_user_question/);
    assert.match(reminder, /Do not make large assumptions/);
    assert.match(reminder, /fold resolved answers into the managed plan/i);
    assert.match(reminder, /ask_user_question.*never.*approval/i);
    assert.match(reminder, /submit-only via submit_plan_for_approval/);
  }
});

test("revision reminders are full, bounded, parent-owned, and never dump the plan", () => {
  const feedback = "Add rollback steps and reassess the execution mode.";
  const reminder = renderFullRevisionParentReminder({
    planPath: "/plans/live/plan.md",
    planStatus: "revision-requested",
    revisionFeedback: feedback,
  });
  assert.match(reminder, /Pending revision feedback/);
  assert.match(reminder, /Add rollback steps and reassess the execution mode/);
  assert.match(reminder, /exactly one ask_user_question/);
  assert.match(reminder, /'Apply these updates \(Recommended\)'/);
  assert.match(reminder, /'Keep the current plan'/);
  assert.match(reminder, /exactly these two authored options/);
  assert.match(reminder, /standard free-text row/);
  assert.match(reminder, /manage_plan_draft replace.*same planPath.*submit_plan_for_approval/);
  assert.match(reminder, /Further free-text feedback records and reassesses without writing/);
  assert.doesNotMatch(reminder, /# Current plan|whole plan contents|chain-of-thought disclosure/);

  const oversized = "x".repeat(REVISION_FEEDBACK_LIMIT + 100);
  const bounded = renderFullParentReminder({ revisionFeedback: oversized });
  assert.ok(bounded.includes("x".repeat(REVISION_FEEDBACK_LIMIT)));
  assert.ok(!bounded.includes("x".repeat(REVISION_FEEDBACK_LIMIT + 1)));
  assert.doesNotMatch(renderFullParentReminder({ revisionFeedback: { text: "bad" } }), /\[object Object\]/);
  assert.equal(selectPlanReminderVariant({
    state: forceFullReminder(createReminderState(), "revision-feedback"),
    revisionFeedback: feedback,
  }), PLAN_REMINDER_VARIANTS.FULL_REVISION_PARENT);
});

test("child reminders return research and unresolved questions to the parent without owning approval", () => {
  for (const reminder of [
    renderFullChildReminder({ planPath: "/plans/plan.md", planStatus: "draft" }),
    renderSparseChildReminder({ planPath: "/plans/plan.md", planStatus: "draft" }),
  ]) {
    assert.match(reminder, /delegated read-only research or design task/);
    assert.match(reminder, /concise .*handoff to the parent/i);
    assert.match(reminder, /exact unresolved question and viable options to the parent/);
    assert.match(reminder, /do not call ask_user_question/);
    assert.match(reminder, /Never create, replace, or submit a managed plan/);
    assert.match(reminder, /manage_plan_draft/);
    assert.match(reminder, /submit_plan_for_approval/);
    assert.doesNotMatch(reminder, /The only exception is the managed plan mechanism/);
  }

  assert.equal(selectPlanReminderVariant({ state: createReminderState(), child: true }), PLAN_REMINDER_VARIANTS.FULL_CHILD);
  let state = recordReminderAttachment(createReminderState());
  state = advanceUntilDue(state);
  assert.equal(selectPlanReminderVariant({ state, child: true }), PLAN_REMINDER_VARIANTS.SPARSE_CHILD);
});

test("reminder messages are hidden transient custom messages and marker de-duplication is pure", () => {
  const message = createPlanReminderMessage({
    variant: PLAN_REMINDER_VARIANTS.FULL_PARENT,
    planPath: "/plans/live/plan.md",
    planStatus: "approved",
  });
  assert.deepEqual(Object.keys(message).sort(), ["content", "customType", "display", "role", "timestamp"]);
  assert.equal(message.role, "custom");
  assert.equal(message.customType, PLAN_REMINDER_CUSTOM_TYPE);
  assert.equal(message.display, false);
  assert.equal(typeof message.timestamp, "number");
  assert.ok(message.timestamp > 0);
  assert.equal(isPlanReminderMessage(message), true);

  const ordinary = { role: "user", content: "A normal context message" };
  const existing = createPlanReminderMessage({ variant: PLAN_REMINDER_VARIANTS.SPARSE_PARENT });
  const messages = [ordinary, existing];
  const cleaned = removePlanReminderMessages(messages);
  assert.deepEqual(cleaned, [ordinary]);
  assert.deepEqual(messages, [ordinary, existing]);
  assert.deepEqual(appendPlanReminder(messages, message), [ordinary, message]);
});

test("live status is rendered on each call rather than captured in a baseline", () => {
  const draft = renderPlanReminder({
    variant: PLAN_REMINDER_VARIANTS.SPARSE_PARENT,
    planPath: "/plans/one/plan.md",
    planStatus: "draft",
  });
  const approved = renderPlanReminder({
    variant: PLAN_REMINDER_VARIANTS.SPARSE_PARENT,
    planPath: "/plans/two/plan.md",
    planStatus: "approved",
  });
  assert.ok(draft.includes("/plans/one/plan.md"));
  assert.ok(draft.includes("status: draft"));
  assert.ok(approved.includes("/plans/two/plan.md"));
  assert.ok(approved.includes("status: approved"));
  assert.ok(!approved.includes("/plans/one/plan.md"));
  assert.doesNotMatch(approved, /turnsSinceAttachment|attachmentCount|timestamp|Date\.now/);
});
