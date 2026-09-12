import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunManifest } from "../core.js";
import { buildReport, renderCsv } from "../report.js";

function manifest(variant: RunManifest["variant"], replicate: number, runId: string, startedAt: string): RunManifest {
	return {
		schemaVersion: 1,
		kind: "run-manifest",
		runId,
		taskId: "task",
		taskHash: "a".repeat(64),
		promptLength: 10,
		arm: variant,
		notesToolPresent: variant === "notes-present",
		notesToolActive: variant === "notes-present",
		variant,
		replicate,
		experimentKey: "exp-test",
		startedAt,
		endedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
		target: { commit: "commit", dirty: false, repository: "repo" },
		notesRevision: null,
		extensionRevision: { commit: "commit", dirty: false, repository: "repo" },
		model: { provider: "qwen", id: "qwen3.8-27b", thinkingLevel: "medium" },
		compactionFingerprint: "compact",
		flags: { resumed: false, forked: false, dirtyStart: false, modelChanged: false, configMismatch: false, incompleteShutdown: false },
		recorder: { droppedEvents: 0, writeErrors: 0, malformedEvents: 0, disabled: false },
	};
}

async function writeRun(root: string, item: RunManifest, events: unknown[]): Promise<void> {
	const path = join(root, item.experimentKey, item.variant, `${String(item.replicate).padStart(3, "0")}-${item.runId}`);
	await mkdir(path, { recursive: true });
	await writeFile(join(path, "manifest.json"), `${JSON.stringify(item)}\n`);
	await writeFile(join(path, "events.jsonl"), events.map(event => JSON.stringify({ version: 1, at: item.startedAt, ...(event as Record<string, unknown>) })).join("\n") + "\n");
}

describe("automatic report pairing", () => {
	it("selects the latest complete pair, calculates rates, and excludes dirty runs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-eval-report-"));
		try {
			const oldOn = manifest("notes-present", 1, "old-on", "2020-01-01T00:00:00.000Z");
			const oldOff = manifest("notes-absent", 1, "old-off", "2020-01-01T00:00:00.000Z");
			oldOn.experimentKey = oldOff.experimentKey = "exp-old";
			await writeRun(root, oldOn, []);
			await writeRun(root, oldOff, []);
			const on = manifest("notes-present", 1, "run-on", "2024-01-01T00:00:00.000Z");
			const off = manifest("notes-absent", 1, "run-off", "2024-01-01T00:00:00.000Z");
			const dirty = manifest("notes-absent", 2, "dirty-off", "2024-01-01T00:00:01.000Z");
			dirty.flags.dirtyStart = true;
			const activity = Array.from({ length: 10 }, (_, index) => [
				{ kind: "provider_request", requestSeq: index + 1 },
				{ kind: "tool_execution_start", toolCategory: "inspection" },
			]).flat();
			await writeRun(root, on, [
				...activity,
				{ kind: "tool_result", toolCallId: "verification-1", verificationCategory: "test", isError: false },
				{ kind: "post_compaction_trace", compactionIndex: 1, traceSequence: 1, traceKind: "response", turnIndex: 4, requestSeq: 2, textHash: "hash", textLength: 12, excerpt: "continue from Notes", truncated: false },
				{ kind: "checkpoint_attempt" },
				{ kind: "checkpoint_result", success: true },
				{ kind: "goal_progress", status: "done" },
				{ kind: "verification", category: "test", outcome: "success" },
			]);
			await writeRun(root, off, activity);
			await writeRun(root, dirty, []);
			const report = await buildReport(root, new Date("2024-01-02T00:00:00.000Z"));
			expect(report.experimentKey).toBe("exp-test");
			expect(report.rows).toHaveLength(2);
			expect(report.pairs).toHaveLength(1);
			expect(report.rows.find(row => row.variant === "notes-present")?.completionSignal).toBe(true);
			expect(report.rows.find(row => row.variant === "notes-present")?.postCompactionTraces).toHaveLength(1);
			expect(report.excluded.some(item => item.runId === "dirty-off" && item.reason === "dirty-start")).toBe(true);
			expect(renderCsv(report.rows)).toContain("variant");
		const filtered = await buildReport(root, new Date("2024-01-02T00:00:00.000Z"), { experimentKey: "exp-test", runIds: ["run-on", "run-off"] });
			expect(filtered.rows.map(row => row.runId).sort()).toEqual(["run-off", "run-on"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
