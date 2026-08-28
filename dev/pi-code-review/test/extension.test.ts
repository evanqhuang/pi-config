import { describe, expect, it, vi } from "vitest";
import registerCodeReview, { applyReviewAgentPolicy, injectReviewResult } from "../extensions/code-review.js";
import type { ReviewResult } from "../src/types.js";

const result: ReviewResult = {
  status: "complete",
  effort: "low",
  summary: "Direct changed-line pass.",
  findings: [],
  failures: [],
  commented: false,
  report: "### Code review\n\nNo issues found.",
  usage: [],
};

describe("review session context", () => {
  it("injects the complete rendered report as a model-visible custom message", () => {
    const sendMessage = vi.fn();
    injectReviewResult({ sendMessage }, result);
    expect(sendMessage).toHaveBeenCalledWith({
      customType: "code-review-result",
      content: result.report,
      display: true,
      details: result,
    });
  });

  it("blocks alternate reviewer agents and normalizes explicit implementation work", () => {
    expect(applyReviewAgentPolicy("YOLO", { subagent_type: "LunaCompliance" })?.block).toBe(true);
    expect(applyReviewAgentPolicy("ORCHESTRATOR", { subagent_type: "reviewer", task: "review the diff" })?.block).toBe(true);
    expect(applyReviewAgentPolicy("ORCHESTRATOR", { subagent_type: "unknown" })?.block).toBe(true);

    const worker: Record<string, unknown> = { subagent_type: "worker", task: "implement the bounded fix" };
    expect(applyReviewAgentPolicy("ORCHESTRATOR", worker)).toBeUndefined();
    expect(worker.subagent_type).toBe("ImplementationWorker");
  });

  it("registers PLAN and implementation guidance after session startup", async () => {
    const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
    const pi = {
      on(name: string, handler: (...args: any[]) => unknown) {
        const existing = handlers.get(name) ?? [];
        existing.push(handler);
        handlers.set(name, existing);
      },
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      registerCommand() {},
      registerTool() {},
    };
    registerCodeReview(pi as any);
    expect(handlers.get("before_agent_start")).toBeUndefined();

    const branch = [{ type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } }];
    const ctx = {
      cwd: "/repo",
      sessionManager: { getBranch: () => branch },
      ui: { onTerminalInput() {}, notify() {} },
    };
    await handlers.get("session_start")?.[0]?.({}, ctx);
    const beforeStart = handlers.get("before_agent_start")?.[0];
    expect(beforeStart).toBeDefined();
    const prompt = await beforeStart?.({ systemPrompt: "base" });
    expect((prompt as { systemPrompt?: string }).systemPrompt).toContain("## Review contract");
  });
});
