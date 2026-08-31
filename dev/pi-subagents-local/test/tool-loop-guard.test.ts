import { describe, expect, it, vi } from "vitest";
import {
  canonicalize,
  createToolLoopGuard,
  hashToolAction,
  hashToolCompletion,
  TOOL_LOOP_GUARD_FAILURE,
  TOOL_LOOP_GUARD_RECOVERY_STEER,
} from "../src/tool-loop-guard.js";
import {
  getToolLoopGuard,
  installLocalModelToolLoopGuard,
  isLocalToolLoopGuardProvider,
  toolLoopFailureSince,
} from "../src/agent-runner.js";

const defaultAssistantMessage = {};
const action = (
  toolName = "read",
  args: unknown = { path: "file" },
  assistantMessage: object = defaultAssistantMessage,
) => ({ toolName, args, assistantMessage });
const completion = (result: unknown = { content: [{ type: "text", text: "same" }] }, isError = false) => ({
  result,
  isError,
});

function toolContext(
  toolName = "read",
  args: unknown = { path: "file" },
  result: unknown = { content: [{ type: "text", text: "same" }] },
  isError = false,
  assistantMessage: object = defaultAssistantMessage,
): any {
  return {
    assistantMessage,
    toolCall: { id: "call-1", name: toolName, arguments: args },
    args,
    context: {},
    result,
    isError,
  };
}

function fakeSession(
  beforeToolCall?: any,
  afterToolCall?: any,
  shouldStopAfterTurn?: any,
): any {
  return {
    agent: { beforeToolCall, afterToolCall, shouldStopAfterTurn },
    steer: vi.fn(async () => {}),
  };
}

describe("local-model tool loop guard", () => {
  it("allows two identical completions and makes the first blocked retry recoverable", () => {
    const guard = createToolLoopGuard();
    const sameAction = action();

    expect(guard.beforeToolCall(sameAction)).toBeUndefined();
    guard.afterToolCall(sameAction, completion());
    expect(guard.beforeToolCall(sameAction)).toBeUndefined();
    guard.afterToolCall(sameAction, completion());

    const blocked = guard.beforeToolCall(sameAction);
    expect(blocked).toMatchObject({ block: true, steer: TOOL_LOOP_GUARD_RECOVERY_STEER });
    expect(blocked?.terminate).toBeUndefined();
    expect(guard.awaitingFinalAnswer).toBe(true);
    expect(guard.mustStopAfterTurn).toBe(false);
    expect(guard.failureMessage).toBeUndefined();
  });

  it("treats sibling calls in the first blocked assistant message as the current batch", () => {
    const guard = createToolLoopGuard();
    const firstBatch = {};
    const repeated = action("read", { path: "same" }, firstBatch);

    guard.afterToolCall(repeated, completion());
    guard.afterToolCall(repeated, completion());
    expect(guard.beforeToolCall(repeated)?.steer).toBe(TOOL_LOOP_GUARD_RECOVERY_STEER);

    expect(guard.beforeToolCall(action("grep", { query: "different" }, firstBatch))).toBeUndefined();
    const secondBlockedInBatch = guard.beforeToolCall(repeated);
    expect(secondBlockedInBatch?.block).toBe(true);
    expect(secondBlockedInBatch?.steer).toBeUndefined();
    expect(secondBlockedInBatch?.terminate).toBeUndefined();
    expect(guard.failureVersion).toBe(0);
  });

  it("terminally blocks any tool in the next assistant message", () => {
    const guard = createToolLoopGuard();
    const firstBatch = {};
    const recoveryBatch = {};
    const repeated = action("read", { path: "same" }, firstBatch);

    guard.afterToolCall(repeated, completion());
    guard.afterToolCall(repeated, completion());
    guard.beforeToolCall(repeated);

    const terminal = guard.beforeToolCall(action("write", { path: "other" }, recoveryBatch));
    expect(terminal).toEqual({ block: true, reason: TOOL_LOOP_GUARD_FAILURE, terminate: true });
    expect(guard.mustStopAfterTurn).toBe(true);
    expect(guard.failureMessage).toBe(TOOL_LOOP_GUARD_FAILURE);
    expect(guard.failureVersion).toBe(1);

    const later = guard.beforeToolCall(action("bash", { command: "true" }, {}));
    expect(later?.terminate).toBe(true);
    expect(guard.failureVersion).toBe(2);
  });

  it("allows clean text-only recovery to remain successful", () => {
    const guard = createToolLoopGuard();
    const repeated = action();
    guard.afterToolCall(repeated, completion());
    guard.afterToolCall(repeated, completion());
    guard.beforeToolCall(repeated);

    // A text-only assistant turn does not invoke preflight at all.
    expect(guard.awaitingFinalAnswer).toBe(true);
    expect(guard.mustStopAfterTurn).toBe(false);
    expect(toolLoopFailureSince(guard, 0)).toBeUndefined();
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

  it("composes existing hooks and hashes the effective after-hook result", async () => {
    const priorBefore = vi.fn(async () => undefined);
    const override = { content: [{ type: "text", text: "overridden" }], details: { source: "existing" } };
    const priorAfter = vi.fn(async () => override);
    const priorStop = vi.fn(async () => false);
    const session = fakeSession(priorBefore, priorAfter, priorStop);
    const guard = installLocalModelToolLoopGuard(session, "qwopus-subagent");
    const signal = new AbortController().signal;
    const context = toolContext();

    expect(guard).toBeDefined();
    expect(await session.agent.beforeToolCall(context, signal)).toBeUndefined();
    expect(priorBefore).toHaveBeenCalledWith(context, signal);
    expect(await session.agent.afterToolCall(context, signal)).toBe(override);
    expect(await session.agent.afterToolCall(context, signal)).toBe(override);
    expect(priorAfter).toHaveBeenCalledWith(context, signal);
    expect((await session.agent.beforeToolCall(context, signal))?.block).toBe(true);
    expect(await session.agent.shouldStopAfterTurn({}, signal)).toBe(false);
    expect(priorStop).toHaveBeenCalledWith({}, signal);

    const blockingBefore = vi.fn(async () => ({ block: true, reason: "existing scope", terminate: true }));
    const blockedSession = fakeSession(blockingBefore);
    installLocalModelToolLoopGuard(blockedSession, "qwopus-subagent");
    const priorBlock = await blockedSession.agent.beforeToolCall(context, signal);
    expect(priorBlock).toEqual({ block: true, reason: "existing scope", terminate: true });

    const stoppingSession = fakeSession(undefined, undefined, vi.fn(async () => true));
    installLocalModelToolLoopGuard(stoppingSession, "qwen38-main");
    expect(await stoppingSession.agent.shouldStopAfterTurn({}, signal)).toBe(true);
  });

  it("lets terminal loop failure override a prior block on the recovery turn", async () => {
    const firstBatch = {};
    const recoveryBatch = {};
    const priorBlock = { block: true, reason: "existing scope" };
    const priorBefore = vi.fn(async (context: any) => (
      context.assistantMessage === recoveryBatch ? priorBlock : undefined
    ));
    const session = fakeSession(priorBefore);
    installLocalModelToolLoopGuard(session, "qwopus-subagent");
    const repeatedContext = toolContext("grep", { query: "loop" }, undefined, false, firstBatch);

    await session.agent.afterToolCall(repeatedContext);
    await session.agent.afterToolCall(repeatedContext);
    expect((await session.agent.beforeToolCall(repeatedContext))?.steer)
      .toBe(TOOL_LOOP_GUARD_RECOVERY_STEER);

    const recoveryContext = toolContext("read", { path: "different" }, undefined, false, recoveryBatch);
    expect(await session.agent.beforeToolCall(recoveryContext)).toEqual({
      block: true,
      reason: TOOL_LOOP_GUARD_FAILURE,
      terminate: true,
    });
    expect(priorBefore).toHaveBeenLastCalledWith(recoveryContext, undefined);
    expect(await session.agent.shouldStopAfterTurn({})).toBe(true);
  });

  it("contains recovery steering failures without breaking preflight", async () => {
    const session = fakeSession();
    session.steer = vi.fn(async () => { throw new Error("queue unavailable"); });
    installLocalModelToolLoopGuard(session, "qwopus-subagent");
    const context = toolContext();

    await session.agent.afterToolCall(context);
    await session.agent.afterToolCall(context);

    await expect(session.agent.beforeToolCall(context)).resolves.toMatchObject({
      block: true,
      steer: TOOL_LOOP_GUARD_RECOVERY_STEER,
    });
    expect(session.steer).toHaveBeenCalledTimes(1);
  });

  it("executes the real tool at most twice, steers once, then stops with failure", async () => {
    const session = fakeSession();
    const guard = installLocalModelToolLoopGuard(session, "qwen38-subagent");
    const firstBatch = {};
    const recoveryBatch = {};
    let executions = 0;

    const execute = async (context: any) => {
      const preflight = await session.agent.beforeToolCall(context);
      if (preflight?.block) return preflight;
      executions += 1;
      await session.agent.afterToolCall(context);
      return undefined;
    };

    expect(await execute(toolContext("grep", { query: "loop" }, undefined, false, firstBatch))).toBeUndefined();
    expect(await execute(toolContext("grep", { query: "loop" }, undefined, false, firstBatch))).toBeUndefined();
    const recoveryBlock = await execute(toolContext("grep", { query: "loop" }, undefined, false, firstBatch));
    expect(recoveryBlock?.terminate).toBeUndefined();
    expect(executions).toBe(2);
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.steer).toHaveBeenCalledWith(TOOL_LOOP_GUARD_RECOVERY_STEER);

    const sameBatchBlock = await execute(
      toolContext("grep", { query: "loop" }, undefined, false, firstBatch),
    );
    expect(sameBatchBlock?.terminate).toBeUndefined();
    expect(session.steer).toHaveBeenCalledTimes(1);

    const terminal = await execute(toolContext("read", { path: "different" }, undefined, false, recoveryBatch));
    expect(terminal?.terminate).toBe(true);
    expect(executions).toBe(2);
    expect(await session.agent.shouldStopAfterTurn({})).toBe(true);
    expect(toolLoopFailureSince(guard, 0)).toBe(TOOL_LOOP_GUARD_FAILURE);
  });

  it("retains terminal stop for mixed and parallel completion ordering", async () => {
    const guard = createToolLoopGuard();
    const firstBatch = {};
    const repeated = action("parallel", { nested: { values: [1, 2, 3] } }, firstBatch);
    const preflightResults = await Promise.all([
      Promise.resolve(guard.beforeToolCall(repeated)),
      Promise.resolve(guard.beforeToolCall(repeated)),
      Promise.resolve(guard.beforeToolCall(repeated)),
    ]);
    expect(preflightResults).toEqual([undefined, undefined, undefined]);

    guard.afterToolCall(repeated, completion({ value: "A" }));
    guard.afterToolCall(repeated, completion({ value: "A" }));
    guard.afterToolCall(repeated, completion({ value: "B" }));
    expect(guard.beforeToolCall(repeated)?.block).toBe(true);
    expect(guard.beforeToolCall(action("other", {}, {}))?.terminate).toBe(true);

    guard.afterToolCall(repeated, completion({ value: "C" }));
    expect(guard.mustStopAfterTurn).toBe(true);
    expect(guard.beforeToolCall(action("later", {}, {}))?.terminate).toBe(true);
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

  it("installs only for approved local providers and only once per session", () => {
    for (const provider of ["qwopus-subagent", "qwen38-main", "qwen38-subagent"]) {
      expect(isLocalToolLoopGuardProvider(provider)).toBe(true);
      const session = fakeSession();
      const first = installLocalModelToolLoopGuard(session, provider);
      const wrappedBefore = session.agent.beforeToolCall;
      const second = installLocalModelToolLoopGuard(session, provider);
      expect(first).toBeDefined();
      expect(second).toBe(first);
      expect(getToolLoopGuard(session)).toBe(first);
      expect(session.agent.beforeToolCall).toBe(wrappedBefore);
    }

    for (const provider of [undefined, "openai-codex", "anthropic", "google"]) {
      expect(isLocalToolLoopGuardProvider(provider)).toBe(false);
      const before = vi.fn(async () => undefined);
      const session = fakeSession(before);
      expect(installLocalModelToolLoopGuard(session, provider)).toBeUndefined();
      expect(session.agent.beforeToolCall).toBe(before);
      expect(getToolLoopGuard(session)).toBeUndefined();
    }
  });

  it("uses failure checkpoints to ignore stale resume failures", () => {
    const guard = createToolLoopGuard();
    const firstBatch = {};
    const repeated = action("read", {}, firstBatch);
    guard.afterToolCall(repeated, completion());
    guard.afterToolCall(repeated, completion());
    guard.beforeToolCall(repeated);
    guard.beforeToolCall(action("read", {}, {}));

    expect(toolLoopFailureSince(guard, 0)).toBe(TOOL_LOOP_GUARD_FAILURE);
    const resumeCheckpoint = guard.failureVersion;
    expect(toolLoopFailureSince(guard, resumeCheckpoint)).toBeUndefined();

    guard.beforeToolCall(action("read", {}, {}));
    expect(toolLoopFailureSince(guard, resumeCheckpoint)).toBe(TOOL_LOOP_GUARD_FAILURE);
  });
});
