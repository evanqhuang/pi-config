import { describe, expect, it } from "vitest";
import { RuntimeTaskHubImpl } from "../src/hub.js";
import type { RuntimeTaskProvider, RuntimeTaskRecord } from "../src/types.js";

function provider(name: string, records: RuntimeTaskRecord[]): RuntimeTaskProvider {
  return {
    name,
    list: () => records,
    get: id => records.find(record => record.id === id),
    wait: async id => records.find(record => record.id === id),
  };
}

describe("RuntimeTaskHubImpl", () => {
  it("filters running tasks by exact goal id and generation", () => {
    const hub = new RuntimeTaskHubImpl("session-a");
    hub.registerProvider(provider("test", [
      {
        id: "owned",
        kind: "test",
        status: "running",
        description: "owned",
        startedAt: 2,
        generation: 1,
        owner: { goalId: "goal", goalGeneration: 2 },
        notified: false,
      },
      {
        id: "stale",
        kind: "test",
        status: "running",
        description: "stale",
        startedAt: 1,
        generation: 1,
        owner: { goalId: "goal", goalGeneration: 1 },
        notified: false,
      },
    ]));

    expect(hub.hasRunning({ goalId: "goal", goalGeneration: 2 })).toBe(true);
    expect(hub.list({ goalId: "goal", goalGeneration: 2 }).map(record => record.id)).toEqual(["owned"]);
  });

  it("uses async-local ownership without leaking across scopes", async () => {
    const hub = new RuntimeTaskHubImpl("session-a");
    const fallback = { goalId: "fallback", goalGeneration: 1 };
    hub.setDefaultOwner(fallback);

    await hub.withOwner({ goalId: "scoped", goalGeneration: 3 }, async () => {
      await Promise.resolve();
      expect(hub.currentOwner()).toEqual({ goalId: "scoped", goalGeneration: 3 });
    });

    expect(hub.currentOwner()).toEqual(fallback);
    hub.withOwner(undefined, () => expect(hub.currentOwner()).toBeUndefined());
    expect(hub.currentOwner()).toEqual(fallback);
  });

  it("rejects a second provider with the same name", () => {
    const hub = new RuntimeTaskHubImpl("session-a");
    hub.registerProvider(provider("duplicate", []));
    expect(() => hub.registerProvider(provider("duplicate", []))).toThrow(/already registered/);
  });
});
