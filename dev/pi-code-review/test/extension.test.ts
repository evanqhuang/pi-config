import { describe, expect, it, vi } from "vitest";
import registerCodeReview, {
  applyReviewAgentPolicy,
  buildManagedImplementationId,
  injectReviewResult,
  latestManagedPlanPath,
  validateFindingDispositionInputs,
} from "../extensions/code-review.js";
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

  it("allows remediation workers to reference confirmed code-review findings", () => {
    const worker: Record<string, unknown> = {
      subagent_type: "ImplementationWorker",
      task: "Fix the two confirmed blockers from code review and run the focused test.",
    };
    expect(applyReviewAgentPolicy("ORCHESTRATOR", worker)).toBeUndefined();
    expect(worker.subagent_type).toBe("ImplementationWorker");
  });

  it("keeps read-only PLAN stress testing available", () => {
    expect(applyReviewAgentPolicy("PLAN", {
      subagent_type: "Plan",
      task: "Review this implementation plan for missing risks and contract gaps.",
    })).toBeUndefined();
    expect(applyReviewAgentPolicy("PLAN", {
      subagent_type: "Explore",
      task: "Review the relevant implementation paths and report evidence.",
    })).toBeUndefined();
  });

  it("binds managed identity to the checkout and plan path, not plan contents", () => {
    const first = buildManagedImplementationId("/repo", "feature", "/plans/feature.md");
    expect(buildManagedImplementationId("/repo", "feature", "/plans/feature.md")).toBe(first);
    expect(buildManagedImplementationId("/repo", "other", "/plans/feature.md")).not.toBe(first);
    expect(buildManagedImplementationId("/repo", "feature", "/plans/other.md")).not.toBe(first);
  });

  it("rejects unknown finding dispositions instead of treating them as approval", () => {
    expect(() => validateFindingDispositionInputs([{
      id: "REV-001",
      disposition: "dismissed" as never,
    }])).toThrow("Unknown finding disposition");
  });

  it("does not fall back to an older approved plan after a newer terminal plan state", () => {
    const branch = [
      { type: "custom", customType: "pi-plan-mode-plan-context", data: { status: "transition-started", planPath: "/plans/old/plan.md" } },
      { type: "custom", customType: "pi-plan-mode-plan-context", data: { status: "failed", planPath: "/plans/new/plan.md" } },
    ];
    expect(latestManagedPlanPath({ cwd: "/repo", sessionManager: { getBranch: () => branch } })).toBeUndefined();
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
