import { describe, expect, it } from "vitest";
import { loadScenarios, parseDuration } from "../harness.js";

describe("unattended benchmark harness", () => {
	it("parses per-arm timeouts", () => {
		expect(parseDuration("3h")).toBe(10_800_000);
		expect(parseDuration("90m")).toBe(5_400_000);
		expect(parseDuration("30s")).toBe(30_000);
	});

	it("discovers the eight stable long-horizon scenarios", async () => {
		const scenarios = await loadScenarios();
		expect(scenarios).toHaveLength(8);
		expect(scenarios.map(scenario => scenario.id)).toEqual([
			"saved-due-diligence-case-file",
			"county-record-refresh",
			"recorded-document-search-review",
			"owner-request-lifecycle",
			"agent-task-operations",
			"screening-run-comparison",
			"provenance-drift-monitor",
			"investigation-bundle-export",
		]);
		expect(scenarios.every(scenario => scenario.promptHash.length === 64 && scenario.prompt.includes("Completion protocol"))).toBe(true);
	});
});
