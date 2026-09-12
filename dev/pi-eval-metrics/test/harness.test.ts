import { describe, expect, it } from "vitest";
import { LiveActivity, assertLocalModel, loadScenarios, parseDuration } from "../harness.js";

describe("unattended benchmark harness", () => {
	it("parses per-arm timeouts", () => {
		expect(parseDuration("3h")).toBe(10_800_000);
		expect(parseDuration("90m")).toBe(5_400_000);
		expect(parseDuration("30s")).toBe(30_000);
	});

	it("rejects any non-local benchmark model", () => {
		expect(() => assertLocalModel("qwen38-main", "qwen3.8-27b")).not.toThrow();
		expect(() => assertLocalModel("openai", "gpt-5")).toThrow(/require local mode/u);
		expect(() => assertLocalModel("qwen38-subagent", "qwen3.8-27b")).toThrow(/require local mode/u);
		expect(() => assertLocalModel("qwen38-main", "qwen3.8-27b", "xhigh")).toThrow(/medium reasoning/u);
	});

	it("discovers twelve repository-aware long-horizon scenarios", async () => {
		const scenarios = await loadScenarios();
		expect(scenarios).toHaveLength(12);
		expect(scenarios.map(scenario => scenario.id)).toEqual([
			"saved-due-diligence-case-file",
			"county-record-refresh",
			"recorded-document-search-review",
			"owner-request-lifecycle",
			"agent-task-operations",
			"screening-run-comparison",
			"provenance-drift-monitor",
			"investigation-bundle-export",
			"multi-phase-architecture-investigation",
			"late-requirement-change",
			"failure-recovery-hardening",
			"implementation-review-remediation",
		]);
		expect(scenarios.slice(0, 8).every(scenario => scenario.repository === "records")).toBe(true);
		expect(scenarios.slice(8).every(scenario => scenario.repository === "hostelhawk")).toBe(true);
		expect(scenarios.every(scenario => scenario.promptHash.length === 64 && scenario.prompt.includes("Completion protocol"))).toBe(true);
	});

	it("summarizes live JSON activity without printing response bodies", () => {
		const output: string[] = [];
		const activity = new LiveActivity("case/arm", line => output.push(line));
		activity.consumeLine(JSON.stringify({ type: "turn_start" }));
		activity.consumeLine(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } }));
		activity.consumeLine(JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }));
		activity.consumeLine(JSON.stringify({ type: "compaction_start" }));
		activity.consumeLine(JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "src/a.ts" } }));
		activity.consumeLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } }));
		const snapshot = activity.snapshot();
		expect(snapshot).toMatchObject({ turns: 1, tools: 2, compactions: 1, repeatedToolCalls: 1, postCompactionRediscoveries: 1, thinkingChars: 17 });
		expect(output.join("\n")).not.toContain("private reasoning");
	});
});
