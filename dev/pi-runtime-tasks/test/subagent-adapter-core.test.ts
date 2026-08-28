import { describe, expect, it } from "vitest";
import {
  extractAgentId,
  mapAgentStatus,
  toRuntimeTask,
  waitForAgent,
} from "../src/subagent-adapter/core.js";

describe("subagent runtime adapter core", () => {
  it("extracts stable agent IDs from structured details", () => {
    expect(extractAgentId({ agentId: "abc-123" }, [])).toBe("abc-123");
  });

  it("maps existing manager statuses without inventing a second lifecycle", () => {
    expect(mapAgentStatus("queued")).toBe("pending");
    expect(mapAgentStatus("steered")).toBe("completed");
    expect(mapAgentStatus("aborted")).toBe("killed");
    expect(mapAgentStatus("error")).toBe("failed");
  });

  it("projects canonical records with ownership metadata", () => {
    expect(toRuntimeTask(
      {
        id: "agent",
        type: "Explore",
        description: "inspect",
        status: "running",
        startedAt: 1,
      },
      {
        sessionId: "session",
        generation: 2,
        owner: { goalId: "goal", goalGeneration: 3 },
      },
    )).toMatchObject({
      id: "agent",
      kind: "local_agent",
      status: "running",
      generation: 2,
      owner: { goalId: "goal", goalGeneration: 3 },
    });
  });

  it("honors wait cancellation without aborting the underlying agent", async () => {
    const controller = new AbortController();
    const record = {
      id: "agent",
      description: "wait",
      status: "running",
      startedAt: 1,
      promise: new Promise<void>(() => {}),
    };
    const waiting = waitForAgent(record, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});
