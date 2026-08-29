import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notesExtensionEntry, { isSubagentChildLoad } from "../entry.js";

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
});
