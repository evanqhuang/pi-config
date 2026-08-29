import { describe, expect, it } from "vitest";
import {
  NOTES_REMINDER_TYPE,
  classifyToolResult,
  createRuntime,
  notesPathFor,
  renderNotes,
  stripNotesReminders,
  type CheckpointPayload,
} from "../index.js";

const payload: CheckpointPayload = {
  current: "Implementing durable Notes.",
  completed: ["Added session-local storage."],
  findings: ["Tree navigation is branch-local."],
  decisions: ["Keep one notesId per top-level session."],
  failed_approaches: [],
  blockers: [],
  verification: ["Typecheck pending."],
  next_action: "Run focused tests.",
};

describe("runtime and rendering", () => {
  it("starts auto mode armed but inactive with a session-local Notes path", () => {
    const runtime = createRuntime();
    expect(runtime.activationMode).toBe("auto");
    expect(runtime.active).toBe(false);
    expect(runtime.notesPath).toBe(notesPathFor(runtime.notesId));
    expect(runtime.notesPath.endsWith("NOTES.md")).toBe(true);
  });

  it("renders bounded continuation sections and deterministic harness facts", () => {
    const runtime = createRuntime("manual");
    runtime.harnessFacts.modifiedFiles.add("src/a.ts");
    runtime.harnessFacts.lastVerificationCommand = "pnpm test";
    runtime.harnessFacts.lastVerificationOutcome = "success";
    const notes = renderNotes(payload, runtime);
    expect(notes).toContain("# Task Notes");
    expect(notes).toContain("## Current\nImplementing durable Notes.");
    expect(notes).toContain("## Failed Approaches\n- None.");
    expect(notes).toContain("Modified files: `src/a.ts`");
    expect(notes).toContain("Last verification outcome: success");
    expect(notes).toContain("Checkpoint generation: 1");
    expect(notes).toContain(`notesId=${runtime.notesId}`);
  });
});

describe("activity classification", () => {
  it("marks edit/write as meaningful mutations", () => {
    expect(classifyToolResult("edit", { path: "src/a.ts" }, false)).toEqual({
      meaningful: true,
      highSignal: true,
      modifiedPath: "src/a.ts",
    });
  });

  it("records verification commands without inventing exit codes", () => {
    expect(classifyToolResult("bash", { command: "pnpm test" }, false)).toMatchObject({
      meaningful: true,
      highSignal: true,
      verification: "pnpm test",
    });
  });

  it("does not dirty Notes for ordinary read-only exploration", () => {
    expect(classifyToolResult("bash", { command: "rg TODO src" }, false)).toEqual({
      meaningful: false,
      highSignal: false,
    });
    expect(classifyToolResult("read", { path: "src/a.ts" }, false)).toEqual({
      meaningful: false,
      highSignal: false,
    });
  });

  it("does not treat a failed lookup as a milestone", () => {
    expect(classifyToolResult("bash", { command: "rg missing src" }, true)).toEqual({
      meaningful: false,
      highSignal: false,
    });
  });
});

describe("transient reminders", () => {
  it("removes previous pi-notes reminders without touching normal messages", () => {
    const normal = { role: "user", content: "hello" };
    const reminder = { role: "custom", customType: NOTES_REMINDER_TYPE, content: "old" };
    expect(stripNotesReminders([normal, reminder])).toEqual([normal]);
  });
});
