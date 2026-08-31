import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  NOTES_REMINDER_TYPE,
  classifyToolResult,
  createRuntime,
  notesPathFor,
  renderNotes,
  repairCheckpointArguments,
  selectReminder,
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

describe("checkpoint argument compatibility", () => {
  it("repairs exact malformed array-field keys into missing canonical fields", () => {
    const malformed = { ...payload } as Record<string, unknown>;
    delete malformed.findings;
    malformed["findings]\n[\"Observed fact\"]\n</parameter"] = "";

    expect(repairCheckpointArguments(malformed)).toEqual({
      ...payload,
      findings: ["Observed fact"],
    });
  });

  it("repairs an array field split at an arrow inside a string", () => {
    const malformed = { ...payload } as Record<string, unknown>;
    delete malformed.findings;
    const findings = ["await operation.catch(() => {}); then continue"];
    const serialized = JSON.stringify(findings);
    const arrow = serialized.indexOf("=>");
    malformed[`findings]\n${serialized.slice(0, arrow + 1)}`] = serialized.slice(arrow + 2);

    expect(repairCheckpointArguments(malformed)).toEqual({
      ...payload,
      findings,
    });
  });

  it("repairs multiple exact fragments without weakening required fields", () => {
    const malformed = { ...payload } as Record<string, unknown>;
    delete malformed.completed;
    delete malformed.verification;
    malformed["completed]\n[\"Finished\"]\n</parameter"] = "";
    malformed["verification]\n[\"pnpm test passed\"]\n</parameter"] = "";

    expect(repairCheckpointArguments(malformed)).toEqual({
      ...payload,
      completed: ["Finished"],
      verification: ["pnpm test passed"],
    });
  });

  it.each([
    ["canonical conflict", (input: Record<string, unknown>) => {
      input["findings]\n[\"replacement\"]\n</parameter"] = "";
    }],
    ["arrow-split canonical conflict", (input: Record<string, unknown>) => {
      input["findings]\n[\"await work(() ="] = " {});\"]";
    }],
    ["duplicate fragments", (input: Record<string, unknown>) => {
      delete input.findings;
      input["findings]\n[\"first\"]\n</parameter"] = "";
      input["findings]\n[\"second\"]\n</parameter"] = "";
    }],
    ["malformed JSON", (input: Record<string, unknown>) => {
      delete input.findings;
      input["findings]\nnot-json\n</parameter"] = "";
    }],
    ["non-array and non-string values", (input: Record<string, unknown>) => {
      delete input.findings;
      input["findings]\n{\"not\":\"an array\"}\n</parameter"] = "";
    }],
    ["non-empty sentinel", (input: Record<string, unknown>) => {
      delete input.findings;
      input["findings]\n[]\n</parameter"] = "not-empty";
    }],
    ["invalid arrow-split remainder", (input: Record<string, unknown>) => {
      delete input.findings;
      input["findings]\n[\"await work(() ="] = { unexpected: true };
    }],
    ["unknown or near-match names", (input: Record<string, unknown>) => {
      delete input.findings;
      input["finding]\n[]\n</parameter"] = "";
    }],
    ["unrelated extras", (input: Record<string, unknown>) => {
      delete input.findings;
      input["findings]\n[]\n</parameter"] = "";
      input.unrelated = "";
    }],
  ])("fails closed for %s", (_label, addInvalidFragment) => {
    const input = { ...payload } as Record<string, unknown>;
    addInvalidFragment(input);
    expect(repairCheckpointArguments(input)).toBe(input);
  });

  it("leaves repaired values for the unchanged schema to bound", () => {
    const malformed = { ...payload } as Record<string, unknown>;
    delete malformed.completed;
    const tooMany = Array.from({ length: 41 }, (_, index) => `done ${index}`);
    malformed[`completed]\n${JSON.stringify(tooMany)}\n</parameter`] = "";

    const repaired = repairCheckpointArguments(malformed) as Record<string, unknown>;
    expect(repaired.completed).toEqual(tooMany);
  });
});

describe("runtime and rendering", () => {
  it("uses conservative automatic activation thresholds", () => {
    expect(DEFAULT_CONFIG.autoActivation).toEqual({
      turns: 8,
      toolCalls: 32,
      readOnlyLongTaskTurns: 10,
      requireHighSignalActivity: true,
    });
    expect(DEFAULT_CONFIG.checkpointing).toEqual({
      dirtyTurns: 6,
      continuityRelevantToolResults: 20,
    });
  });

  it("starts auto mode armed but inactive with a session-local Notes path", () => {
    const runtime = createRuntime();
    expect(runtime.activationMode).toBe("auto");
    expect(runtime.active).toBe(false);
    expect(runtime.notesPath).toBe(notesPathFor(runtime.notesId));
    expect(runtime.notesPath.endsWith("NOTES.md")).toBe(true);
  });

  it("renders task-state sections with only the deterministic working set", () => {
    const runtime = createRuntime("manual");
    runtime.harnessFacts.modifiedFiles.add("src/a.ts");
    runtime.harnessFacts.lastVerificationCommand = "pnpm test";
    runtime.harnessFacts.lastVerificationOutcome = "success";
    runtime.harnessFacts.recentFailedCommandCount = 3;
    const notes = renderNotes(payload, runtime);
    expect(notes).toContain("# Task State");
    expect(notes).toContain("## Current\nImplementing durable Notes.");
    expect(notes).toContain("## Failed Approaches\n- None.");
    expect(notes).toContain("## Working Set\n- `src/a.ts`");
    expect(notes).not.toContain("Last verification command");
    expect(notes).not.toContain("Last verification outcome");
    expect(notes).not.toContain("Recent failed commands");
    expect(notes).not.toContain("Checkpoint generation: 1");
    expect(notes).toContain(`notesId=${runtime.notesId} generation=1`);
  });

  it("fails closed when the required omission marker crosses the byte bound", () => {
    const nearBoundaryPayload: CheckpointPayload = {
      current: "c".repeat(2048),
      completed: ["d".repeat(1024)],
      findings: ["f".repeat(1024)],
      decisions: ["i".repeat(1024)],
      failed_approaches: ["a".repeat(755)],
      blockers: [],
      verification: [],
      next_action: "n".repeat(2048),
    };
    const runtime = createRuntime("manual");
    const emptyNotes = renderNotes(nearBoundaryPayload, runtime);
    const omission = "- … 1 more paths retained in checkpoint metadata.";
    const emptyBytes = Buffer.byteLength(emptyNotes, "utf8");
    expect(emptyBytes).toBeLessThanOrEqual(DEFAULT_CONFIG.notesMaxBytes);
    expect(emptyBytes
      + Buffer.byteLength(omission, "utf8")
      - Buffer.byteLength("- None.", "utf8"))
      .toBeGreaterThan(DEFAULT_CONFIG.notesMaxBytes);

    runtime.harnessFacts.modifiedFiles.add("src/a.ts");
    const notes = renderNotes(nearBoundaryPayload, runtime);
    expect(Buffer.byteLength(notes, "utf8")).toBeGreaterThan(DEFAULT_CONFIG.notesMaxBytes);
    const workingSet = notes.slice(notes.indexOf("## Working Set\n"), notes.indexOf("\n\n<!--"));
    expect(workingSet).toBe(`## Working Set\n${omission}`);
  });

  it("bounds a huge Unicode working set without cutting paths or codepoints", () => {
    const runtime = createRuntime("manual");
    const paths = Array.from({ length: 250 }, (_, index) =>
      `src/${"界".repeat(12)}/${String(index).padStart(3, "0")}-😀.ts`,
    );
    runtime.harnessFacts.modifiedFiles = new Set(paths);

    const notes = renderNotes(payload, runtime);
    expect(Buffer.byteLength(notes, "utf8")).toBeLessThanOrEqual(DEFAULT_CONFIG.notesMaxBytes);

    const workingSet = notes.slice(notes.indexOf("## Working Set\n"), notes.indexOf("\n\n<!--"));
    const listedPaths = workingSet.split("\n").slice(1)
      .filter((line) => line.startsWith("- `"))
      .map((line) => line.slice(3, -1));
    const sortedPaths = [...paths].sort();
    expect(listedPaths).toEqual(sortedPaths.slice(0, listedPaths.length));

    const omission = /- … (\d+) more paths retained in checkpoint metadata\./.exec(workingSet);
    expect(omission).not.toBeNull();
    expect(Number(omission?.[1])).toBe(sortedPaths.length - listedPaths.length);
  });
});

describe("activity classification", () => {
  it("marks successful edits as both high-signal and continuity-relevant", () => {
    expect(classifyToolResult("edit", { path: "src/a.ts" }, false)).toEqual({
      continuityRelevant: true,
      highSignal: true,
      modifiedPath: "src/a.ts",
    });
  });

  it("does not claim a failed write changed continuity or modified a file", () => {
    expect(classifyToolResult("write", { path: "src/a.ts" }, true)).toEqual({
      continuityRelevant: false,
      highSignal: true,
      modifiedPath: undefined,
    });
  });

  it("records verification commands without inventing exit codes", () => {
    expect(classifyToolResult("bash", { command: "pnpm test" }, false)).toMatchObject({
      continuityRelevant: true,
      highSignal: true,
      verification: "pnpm test",
    });
  });

  it("separates ordinary continuity exploration from high-signal activation", () => {
    for (const toolName of ["read", "grep", "find", "web_search", "ctx_execute", "Agent", "get_subagent_result"]) {
      expect(classifyToolResult(toolName, { path: "src/a.ts" }, false)).toEqual({
        continuityRelevant: true,
        highSignal: false,
      });
    }
    expect(classifyToolResult("bash", { command: "rg TODO src" }, false)).toEqual({
      continuityRelevant: true,
      highSignal: false,
    });
  });

  it("does not treat a failed lookup as continuity-relevant", () => {
    expect(classifyToolResult("bash", { command: "rg missing src" }, true)).toEqual({
      continuityRelevant: false,
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

  it("emits re-entry once, then exposes an already-due checkpoint reminder", () => {
    const runtime = createRuntime("manual");
    runtime.reentryRequired = true;
    runtime.dirty = true;
    runtime.checkpointDue = true;
    const pi = { getActiveTools: () => ["checkpoint_notes"] };

    expect(selectReminder(pi, runtime)).toContain("[TASK NOTES RE-ENTRY]");
    expect(runtime.reentryRequired).toBe(false);
    expect(selectReminder(pi, runtime)).toContain("[TASK NOTES CHECKPOINT DUE]");
  });

  it("honors an explicit checkpoint request even when Notes are clean", () => {
    const runtime = createRuntime("manual");
    runtime.dirty = false;
    runtime.checkpointDue = true;
    const pi = { getActiveTools: () => ["checkpoint_notes"] };

    expect(selectReminder(pi, runtime)).toContain("[TASK NOTES CHECKPOINT DUE]");
  });
});
