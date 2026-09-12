import { describe, expect, it } from "vitest";
import { pairRows, type ReportRow } from "../report.js";

function row(variant: ReportRow["variant"], replicate: number, requests: number, startedAt: string): ReportRow {
	return {
		runId: `${variant}-${replicate}-${requests}`,
		experimentKey: "exp-test",
		variant,
		replicate,
		taskId: "task",
		startedAt,
		endedAt: startedAt,
		valid: true,
		exclusionReasons: [],
		completionSignal: false,
		elapsedMs: 100,
		providerRequests: requests,
		turns: requests,
		toolCalls: requests,
		tokensInput: 0,
		tokensOutput: 0,
		tokensTotal: 0,
		cacheRead: 0,
		cacheWrite: 0,
		checkpointAttempts: 0,
		checkpointSuccesses: 0,
		checkpointFailures: 0,
		checkpointSuccessRatePer100Requests: 0,
		checkpointFailureRatePer100Requests: 0,
		longestCheckpointFailureStreak: 0,
		checkpointOnlyGenerations: 0,
		reminders: 0,
		remindersPer100Requests: 0,
		compactionAttempts: 0,
		compactionSuccesses: 0,
		normalCompactionSuccesses: 0,
		extensionCompactionSuccesses: 0,
		compactionFailures: 0,
		abortedCompactionFailures: 0,
		compactionReductionPercent: null,
		retainedBoundaryAdvancements: 0,
		postCompactionRecoveryMs: null,
		verification: {},
		postCompactionTraces: [],
		model: "model",
		provider: "provider",
		thinkingLevel: "medium",
	};
}

describe("pair fallback", () => {
	it("skips short accidental attempts and pairs substantive runs by order", () => {
		const pairs = pairRows([
			row("notes-present", 1, 2, "2026-01-01T00:00:00.000Z"),
			row("notes-present", 2, 2, "2026-01-01T00:01:00.000Z"),
			row("notes-present", 3, 199, "2026-01-01T02:00:00.000Z"),
			row("notes-absent", 1, 231, "2026-01-01T00:02:00.000Z"),
		]);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ strategy: "substantive-fallback", notesPresentReplicate: 3, notesAbsentReplicate: 1 });
	});
});
