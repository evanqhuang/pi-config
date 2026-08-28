import { describe, expect, it } from "vitest";
import {
  CHILD_SESSION_CONTEXT_PROBE,
  CHILD_SESSION_CONTEXT_PROBE_KEY,
  inChildSessionContext,
  runInChildSessionContext,
} from "../src/child-context.js";

const globalRegistry = globalThis as unknown as Record<PropertyKey, unknown>;

describe("runInChildSessionContext process-global probe", () => {
  it("publishes a versioned callable probe that is false in normal execution", () => {
    expect(CHILD_SESSION_CONTEXT_PROBE_KEY).toBe("pi-subagents:child-context:v1");
    expect(CHILD_SESSION_CONTEXT_PROBE).toBe(Symbol.for(CHILD_SESSION_CONTEXT_PROBE_KEY));

    const probe = globalRegistry[CHILD_SESSION_CONTEXT_PROBE];
    expect(probe).toBeTypeOf("function");
    expect((probe as () => boolean)()).toBe(false);
    expect(inChildSessionContext()).toBe(false);
  });

  it("reports true inside a child context", async () => {
    await runInChildSessionContext(async () => {
      const probe = globalRegistry[CHILD_SESSION_CONTEXT_PROBE] as () => boolean;
      expect(probe()).toBe(true);
      expect(inChildSessionContext()).toBe(true);
    });
  });

  it("remains true for nested child contexts", async () => {
    await runInChildSessionContext(async () => {
      await runInChildSessionContext(async () => {
        const probe = globalRegistry[CHILD_SESSION_CONTEXT_PROBE] as () => boolean;
        expect(probe()).toBe(true);
        expect(inChildSessionContext()).toBe(true);
      });
    });
  });

  it("returns to false after the child context completes", async () => {
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
    });

    const probe = globalRegistry[CHILD_SESSION_CONTEXT_PROBE] as () => boolean;
    expect(probe()).toBe(false);
    expect(inChildSessionContext()).toBe(false);
  });

  it("does not leak between concurrent child and normal execution", async () => {
    let childReady!: () => void;
    const childStarted = new Promise<void>((resolve) => { childReady = resolve; });
    let releaseChild!: () => void;
    const childReleased = new Promise<void>((resolve) => { releaseChild = resolve; });

    const child = runInChildSessionContext(async () => {
      childReady();
      await childReleased;
      const probe = globalRegistry[CHILD_SESSION_CONTEXT_PROBE] as () => boolean;
      return probe();
    });

    await childStarted;
    const normal = Promise.resolve().then(() => {
      const probe = globalRegistry[CHILD_SESSION_CONTEXT_PROBE] as () => boolean;
      return probe();
    });

    expect(await normal).toBe(false);
    releaseChild();
    expect(await child).toBe(true);
    expect((globalRegistry[CHILD_SESSION_CONTEXT_PROBE] as () => boolean)()).toBe(false);
  });
});
