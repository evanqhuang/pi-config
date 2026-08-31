import { describe, expect, it, vi } from "vitest";
import {
  canonicalize,
  createToolLoopGuard,
  hashToolAction,
  hashToolCompletion,
} from "../src/tool-loop-guard.js";
import {
  installLocalExploreToolLoopGuard,
  installLocalExploreToolLoopGuardForAgent,
} from "../src/agent-runner.js";

const action = (toolName = "read", args: unknown = { path: "file" }) => ({ toolName, args });
const completion = (result: unknown = { content: [{ type: "text", text: "same" }] }, isError = false) => ({
  result,
  isError,
});

function toolContext(
  toolName = "read",
  args: unknown = { path: "file" },
  result: unknown = { content: [{ type: "text", text: "same" }] },
  isError = false,
): any {
  return {
    assistantMessage: {},
    toolCall: { id: "call-1", name: toolName, arguments: args },
    args,
    context: {},
    result,
    isError,
  };
}

function fakeSession(beforeToolCall?: any, afterToolCall?: any): any {
  return { agent: { beforeToolCall, afterToolCall } };
}

describe("LocalExplore tool loop guard", () => {
  it("allows two identical completions and blocks the next identical action", () => {
    const guard = createToolLoopGuard();
    const sameAction = action();

    expect(guard.beforeToolCall(sameAction)).toBeUndefined();
    guard.afterToolCall(sameAction, completion());
    expect(guard.beforeToolCall(sameAction)).toBeUndefined();
    guard.afterToolCall(sameAction, completion());

    const blocked = guard.beforeToolCall(sameAction);
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toMatch(/change approach/i);
    expect(blocked?.reason).toMatch(/summarize/i);
  });

  it("evicts the oldest action at the cap while retaining recent threshold state", () => {
    const guard = createToolLoopGuard();
    const recentAction = action("recent", { id: "recent" });
    const evictedAction = action("evicted", { id: "evicted" });

    guard.afterToolCall(recentAction, completion());
    guard.afterToolCall(evictedAction, completion({ value: "evicted" }));
    guard.afterToolCall(evictedAction, completion({ value: "evicted" }));
    expect(guard.beforeToolCall(evictedAction)?.block).toBe(true);

    for (let index = 0; index < 126; index++) {
      guard.afterToolCall(action("filler", { index }), completion({ index }));
    }
    expect(guard.size).toBe(128);

    // Refreshing a retained action makes it recent and keeps its threshold state.
    guard.afterToolCall(recentAction, completion());
    expect(guard.beforeToolCall(recentAction)?.block).toBe(true);

    guard.afterToolCall(action("newest", { id: "newest" }), completion());
    expect(guard.size).toBe(128);
    expect(guard.beforeToolCall(evictedAction)).toBeUndefined();
    expect(guard.beforeToolCall(recentAction)?.block).toBe(true);
  });

  it("keeps tool names, nested arguments, result values, and error status distinct", () => {
    const guard = createToolLoopGuard();

    guard.afterToolCall(action("read", { query: { path: ["a", 1] } }), completion({ value: 1 }));
    guard.afterToolCall(action("read", { query: { path: ["a", 2] } }), completion({ value: 1 }));
    expect(guard.beforeToolCall(action("read", { query: { path: ["a", 1] } }))).toBeUndefined();
    expect(guard.beforeToolCall(action("write", { query: { path: ["a", 1] } }))).toBeUndefined();

    const resultGuard = createToolLoopGuard();
    const resultAction = action("search", { query: "same" });
    resultGuard.afterToolCall(resultAction, completion({ value: "first" }));
    resultGuard.afterToolCall(resultAction, completion({ value: "second" }));
    expect(resultGuard.beforeToolCall(resultAction)).toBeUndefined();
    resultGuard.afterToolCall(resultAction, completion({ value: "second" }));
    expect(resultGuard.beforeToolCall(resultAction)?.block).toBe(true);

    const errorGuard = createToolLoopGuard();
    const errorAction = action("search", { query: "error-status" });
    errorGuard.afterToolCall(errorAction, completion({ value: "same" }, false));
    errorGuard.afterToolCall(errorAction, completion({ value: "same" }, true));
    expect(errorGuard.beforeToolCall(errorAction)).toBeUndefined();
    errorGuard.afterToolCall(errorAction, completion({ value: "same" }, true));
    expect(errorGuard.beforeToolCall(errorAction)?.block).toBe(true);
  });

  it("canonicalizes object keys while preserving array order and JSON distinctions", () => {
    expect(canonicalize({ b: { y: 2, x: 1 }, a: [true, null, "1"] }))
      .toBe(canonicalize({ a: [true, null, "1"], b: { x: 1, y: 2 } }));
    expect(canonicalize({ a: [1, 2] })).not.toBe(canonicalize({ a: [2, 1] }));
    expect(canonicalize(1)).not.toBe(canonicalize("1"));
    expect(canonicalize(false)).not.toBe(canonicalize(null));
    expect(canonicalize({})).not.toBe(canonicalize([]));

    expect(hashToolAction("read", { b: 2, a: 1 }))
      .toBe(hashToolAction("read", { a: 1, b: 2 }));
    expect(hashToolCompletion({ value: 1 }, false))
      .not.toBe(hashToolCompletion({ value: 1 }, true));
  });

  it("hashes the complete input rather than a truncated prefix", () => {
    const prefix = "x".repeat(4096);
    const first = hashToolAction("large", { value: `${prefix}a` });
    const second = hashToolAction("large", { value: `${prefix}b` });

    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).not.toBe(second);
  });

  it("composes existing before and after hooks without changing their results", async () => {
    const priorBefore = vi.fn(async () => undefined);
    const override = { content: [{ type: "text", text: "overridden" }], details: { source: "existing" } };
    const priorAfter = vi.fn(async () => override);
    const session = fakeSession(priorBefore, priorAfter);
    installLocalExploreToolLoopGuard(session);
    const signal = new AbortController().signal;
    const context = toolContext();

    expect(await session.agent.beforeToolCall(context, signal)).toBeUndefined();
    expect(priorBefore).toHaveBeenCalledWith(context, signal);
    expect(await session.agent.afterToolCall(context, signal)).toBe(override);
    expect(priorAfter).toHaveBeenCalledWith(context, signal);

    const blockingBefore = vi.fn(async () => ({ block: true, reason: "existing scope", terminate: true }));
    const blockedSession = fakeSession(blockingBefore);
    installLocalExploreToolLoopGuard(blockedSession);
    const priorBlock = await blockedSession.agent.beforeToolCall(context, signal);
    expect(priorBlock).toEqual({ block: true, reason: "existing scope", terminate: true });
  });

  it("keeps an established threshold through sequential and parallel completion order", async () => {
    const sequentialGuard = createToolLoopGuard();
    const sequentialAction = action("sequential", { nested: { values: [1, 2, 3] } });

    sequentialGuard.afterToolCall(sequentialAction, completion({ value: "A" }));
    sequentialGuard.afterToolCall(sequentialAction, completion({ value: "A" }));
    sequentialGuard.afterToolCall(sequentialAction, completion({ value: "B" }));
    expect(sequentialGuard.beforeToolCall(sequentialAction)?.block).toBe(true);

    const parallelGuard = createToolLoopGuard();
    const parallelAction = action("parallel", { nested: { values: [1, 2, 3] } });
    const preflightResults = await Promise.all([
      Promise.resolve(parallelGuard.beforeToolCall(parallelAction)),
      Promise.resolve(parallelGuard.beforeToolCall(parallelAction)),
      Promise.resolve(parallelGuard.beforeToolCall(parallelAction)),
    ]);
    expect(preflightResults).toEqual([undefined, undefined, undefined]);

    parallelGuard.afterToolCall(parallelAction, completion({ value: "A" }));
    parallelGuard.afterToolCall(parallelAction, completion({ value: "A" }));
    parallelGuard.afterToolCall(parallelAction, completion({ value: "B" }));
    expect(parallelGuard.beforeToolCall(parallelAction)?.block).toBe(true);
  });

  it("keeps completion state per guard/session", () => {
    const firstSession = createToolLoopGuard();
    const secondSession = createToolLoopGuard();
    const sameAction = action();

    for (const _ of [1, 2]) firstSession.afterToolCall(sameAction, completion());
    expect(firstSession.beforeToolCall(sameAction)?.block).toBe(true);
    expect(secondSession.beforeToolCall(sameAction)).toBeUndefined();
    expect(firstSession.size).toBe(1);
    expect(secondSession.size).toBe(0);
  });

  it("does not install for a non-LocalExplore resolved identity", () => {
    const before = vi.fn(async () => undefined);
    const after = vi.fn(async () => undefined);
    const session = fakeSession(before, after);

    installLocalExploreToolLoopGuardForAgent(session, "Explore");
    expect(session.agent.beforeToolCall).toBe(before);
    expect(session.agent.afterToolCall).toBe(after);

    installLocalExploreToolLoopGuardForAgent(session, "LocalExplore");
    expect(session.agent.beforeToolCall).not.toBe(before);
  });
});
