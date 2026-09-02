import test from "node:test";
import assert from "node:assert/strict";
import {
  appendModeChangeReminder,
  createModeChangeReminderMessage,
  isModeChangeReminderMessage,
  MODE_CHANGE_REMINDER_CUSTOM_TYPE,
  MODE_CHANGE_REMINDER_MARKER,
  removeModeChangeReminderMessages,
  renderModeChangeReminder,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../src/mode-change-reminder.mjs";

test("renders a bounded, marker-wrapped announcement naming the new mode and carrying the contract", () => {
  const rendered = renderModeChangeReminder({ mode: "ORCHESTRATOR", contract: "Delegate implementation to leaf workers." });
  assert.match(rendered, new RegExp(`^${SYSTEM_REMINDER_OPEN}\n`));
  assert.match(rendered, new RegExp(`${SYSTEM_REMINDER_CLOSE}$`));
  assert.match(rendered, new RegExp(`\\[${MODE_CHANGE_REMINDER_MARKER}\\]`));
  assert.match(rendered, /switched the session mode to ORCHESTRATOR during this run/);
  assert.match(rendered, /no longer apply/);
  assert.match(rendered, /Delegate implementation to leaf workers\./);
});

test("PLAN is a recognized mode, carrying PLAN_PROMPT-shaped contract text", () => {
  const rendered = renderModeChangeReminder({ mode: "PLAN", contract: "PLAN MODE IS ACTIVE. You are a read-only planning agent." });
  assert.match(rendered, /switched the session mode to PLAN during this run/);
  assert.match(rendered, /read-only planning agent/);
});

test("an unrecognized mode falls back to YOLO rather than throwing or rendering garbage", () => {
  const rendered = renderModeChangeReminder({ mode: "BOGUS", contract: "irrelevant" });
  assert.match(rendered, /switched the session mode to YOLO during this run/);
});

test("the contract is bounded so an oversized value cannot inflate the reminder unboundedly", () => {
  const rendered = renderModeChangeReminder({ mode: "YOLO", contract: "x".repeat(20_000) });
  assert.ok(rendered.length < 8_500);
});

test("the hidden message carries the custom type and stays hidden from the transcript", () => {
  const message = createModeChangeReminderMessage({ mode: "YOLO", contract: "Full tool access restored." });
  assert.equal(message.role, "custom");
  assert.equal(message.customType, MODE_CHANGE_REMINDER_CUSTOM_TYPE);
  assert.equal(message.display, false);
  assert.equal(typeof message.timestamp, "number");
  assert.match(message.content, /Full tool access restored\./);
});

test("isModeChangeReminderMessage recognizes the custom type and the marker text alike", () => {
  const message = createModeChangeReminderMessage({ mode: "YOLO", contract: "x" });
  assert.equal(isModeChangeReminderMessage(message), true);
  assert.equal(isModeChangeReminderMessage({ role: "user", content: message.content }), true, "marker text alone is still recognized");
  assert.equal(isModeChangeReminderMessage({ role: "user", content: "unrelated" }), false);
  assert.equal(isModeChangeReminderMessage(undefined), false);
});

test("removeModeChangeReminderMessages strips every prior copy and rejects non-array input", () => {
  const first = createModeChangeReminderMessage({ mode: "YOLO", contract: "first" });
  const second = createModeChangeReminderMessage({ mode: "ORCHESTRATOR", contract: "second" });
  const other = { role: "user", content: "keep me" };
  assert.deepEqual(removeModeChangeReminderMessages([first, other, second]), [other]);
  assert.throws(() => removeModeChangeReminderMessages(null), TypeError);
});

test("appendModeChangeReminder de-duplicates before appending, so only the latest copy survives", () => {
  const stale = createModeChangeReminderMessage({ mode: "YOLO", contract: "stale" });
  const other = { role: "user", content: "keep me" };
  const fresh = createModeChangeReminderMessage({ mode: "ORCHESTRATOR", contract: "fresh" });
  const result = appendModeChangeReminder([stale, other], fresh);
  assert.deepEqual(result, [other, fresh]);
});
