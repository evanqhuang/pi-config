import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notesExtensionEntry, { isSubagentChildLoad } from "../entry.js";
import { prepareCheckpointArguments } from "../index.js";

const CHILD_SESSION_CONTEXT_PROBE = Symbol.for("pi-subagents:child-context:v1");

function withChildProbe<T>(probe: (() => boolean) | undefined, fn: () => T): T {
  const registry = globalThis as unknown as Record<PropertyKey, unknown>;
  const previous = registry[CHILD_SESSION_CONTEXT_PROBE];
  if (probe) registry[CHILD_SESSION_CONTEXT_PROBE] = probe;
  else delete registry[CHILD_SESSION_CONTEXT_PROBE];
  try {
    return fn();
  } finally {
    if (previous === undefined) delete registry[CHILD_SESSION_CONTEXT_PROBE];
    else registry[CHILD_SESSION_CONTEXT_PROBE] = previous;
  }
}

describe("extension entry isolation", () => {
  it("detects the pi-subagents child load scope", () => {
    withChildProbe(() => true, () => {
      expect(isSubagentChildLoad()).toBe(true);
    });
  });

  it("does not register Notes tools or handlers for child sessions", () => {
    withChildProbe(() => true, () => {
      const pi = new Proxy({}, {
        get() {
          throw new Error("child Notes entry should return before touching ExtensionAPI");
        },
      }) as ExtensionAPI;

      expect(() => notesExtensionEntry(pi)).not.toThrow();
    });
  });

  it("normalizes canonical array fields serialized by the tool-call boundary", () => {
    const prepared = prepareCheckpointArguments({
      current: "Resume the task.",
      completed: '["Implemented the feature."]',
      findings: "[]",
      decisions: '["Keep the public schema strict."]',
      failed_approaches: "[]",
      blockers: "[]",
      verification: '["npm test passed"]',
      next_action: "Run the final checks.",
    });

    expect(prepared.completed).toEqual(["Implemented the feature."]);
    expect(prepared.decisions).toEqual(["Keep the public schema strict."]);
    expect(prepared.verification).toEqual(["npm test passed"]);
  });

  it("reports the first missing canonical field instead of a generic schema failure", () => {
    expect(() => prepareCheckpointArguments({
      current: "Resume the task.",
      completed: [],
      next_action: "Run the final checks.",
    })).toThrow(/findings is required/);
  });
});
