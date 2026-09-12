import { readFile, readdir, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunManifest, EvalEvent } from "./core.js";
import { writeJsonAtomically, writeTextAtomically } from "./writer.js";

export interface ReportRow {
	runId: string;
	experimentKey: string;
	variant: "notes-present" | "notes-absent";
	replicate: number;
	taskId: string;
	startedAt: string;
	endedAt: string | null;
	valid: boolean;
	exclusionReasons: string[];
	completionSignal: boolean;
	elapsedMs: number | null;
	providerRequests: number;
	turns: number;
	toolCalls: number;
	tokensInput: number;
	tokensOutput: number;
	tokensTotal: number;
	cacheRead: number;
	cacheWrite: number;
	checkpointAttempts: number;
	checkpointSuccesses: number;
	checkpointFailures: number;
	checkpointSuccessRatePer100Requests: number;
	checkpointFailureRatePer100Requests: number;
	longestCheckpointFailureStreak: number;
	checkpointOnlyGenerations: number;
	reminders: number;
	remindersPer100Requests: number;
	compactionAttempts: number;
	compactionSuccesses: number;
	normalCompactionSuccesses: number;
	extensionCompactionSuccesses: number;
	compactionFailures: number;
	abortedCompactionFailures: number;
	compactionReductionPercent: number | null;
	retainedBoundaryAdvancements: number;
	postCompactionRecoveryMs: number | null;
	verification: Record<string, { attempted: number; success: number; error: number }>;
	postCompactionTraces: PostCompactionTrace[];
	model: string;
	provider: string;
	thinkingLevel: string;
}

export interface PostCompactionTrace {
	compactionIndex: number;
	traceSequence: number;
	traceKind: "thinking" | "response";
	turnIndex: number;
	requestSeq: number;
	textHash: string;
	textLength: number;
	excerpt: string;
	truncated: boolean;
}

export interface PairDelta {
	replicate: number;
	notesPresentReplicate: number;
	notesAbsentReplicate: number;
	strategy: "replicate" | "substantive-fallback";
	completionSignal: number;
	elapsedMs: number | null;
	providerRequests: number;
	toolCalls: number;
	checkpointFailures: number;
	compactionFailures: number;
}

export interface EvalReport {
	experimentKey: string | null;
	generatedAt: string;
	rows: ReportRow[];
	excluded: Array<{ runId: string; reason: string }>;
	pairs: PairDelta[];
	medians: Record<string, number | null>;
	markdown: string;
}

export interface ReportSelection {
	experimentKey?: string;
	runIds?: readonly string[];
}

const DEFAULT_ROOT = join(homedir(), ".pi", "evals");
const MIN_SUBSTANTIVE_PROVIDER_REQUESTS = 10;
const MIN_SUBSTANTIVE_TOOL_CALLS = 10;

export async function buildReport(rootDir = DEFAULT_ROOT, now = new Date(), selection: ReportSelection = {}): Promise<EvalReport> {
	const manifests = await loadManifests(rootDir);
	const groups = new Map<string, RunManifest[]>();
	for (const manifest of manifests) {
		const list = groups.get(manifest.experimentKey) ?? [];
		list.push(manifest);
		groups.set(manifest.experimentKey, list);
	}
	const experimentKey = selection.experimentKey ?? chooseLatestExperiment(groups);
	const selected = (experimentKey ? groups.get(experimentKey) ?? [] : [])
		.filter(manifest => !selection.runIds || selection.runIds.includes(manifest.runId));
	const rows: ReportRow[] = [];
	const excluded: Array<{ runId: string; reason: string }> = [];
	for (const manifest of selected) {
		const events = await loadEvents(rootDir, manifest);
		const row = aggregate(manifest, events);
		for (const reason of comparabilityReasons(manifest, selected)) {
			if (!row.exclusionReasons.includes(reason)) row.exclusionReasons.push(reason);
		}
		row.valid = row.exclusionReasons.length === 0;
		if (row.valid) rows.push(row);
		else for (const reason of row.exclusionReasons) excluded.push({ runId: row.runId, reason });
	}
	const pairs = pairRows(rows);
	const report: EvalReport = {
		experimentKey,
		generatedAt: now.toISOString(),
		rows: rows.sort((a, b) => a.replicate - b.replicate || a.variant.localeCompare(b.variant)),
		excluded,
		pairs,
		medians: medianSummary(pairs),
		markdown: renderMarkdown(experimentKey, rows, excluded, pairs),
	};
	return report;
}

export function aggregate(manifest: RunManifest, events: EvalEvent[]): ReportRow {
	const reasons: string[] = [];
	if (manifest.flags.incompleteShutdown) reasons.push("incomplete-shutdown");
	if (manifest.flags.dirtyStart) reasons.push("dirty-start");
	if (manifest.flags.modelChanged) reasons.push("model-changed");
	if (manifest.flags.configMismatch) reasons.push("mismatched-config");
	if (manifest.recorder.droppedEvents > 0) reasons.push("dropped-events");
	if (manifest.recorder.writeErrors > 0) reasons.push("writer-errors");
	if (manifest.recorder.malformedEvents > 0) reasons.push("malformed-events");
		if (manifest.recorder.disabled) reasons.push("recorder-disabled");
		if (manifest.target.commit === "unknown" || manifest.target.repository === "unknown") reasons.push("unknown-target-revision");
		if (manifest.target.dirty === "unknown") reasons.push("unknown-target-dirty-state");
		if (!manifest.endedAt) reasons.push("missing-shutdown");
	const counts = {
		providerRequests: 0,
		turns: 0,
		toolCalls: 0,
		tokensInput: 0,
		tokensOutput: 0,
		tokensTotal: 0,
		cacheRead: 0,
		cacheWrite: 0,
		checkpointAttempts: 0,
		checkpointSuccesses: 0,
		checkpointFailures: 0,
		checkpointOnlyGenerations: 0,
		reminders: 0,
		compactionAttempts: 0,
		compactionSuccesses: 0,
		normalCompactionSuccesses: 0,
		extensionCompactionSuccesses: 0,
		compactionFailures: 0,
		abortedCompactionFailures: 0,
		retainedBoundaryAdvancements: 0,
		completionSignal: false,
		longestCheckpointFailureStreak: 0,
		checkpointFailureStreak: 0,
		compactionReductionTotal: 0,
		compactionReductionCount: 0,
		postCompactionRecoveryTotal: 0,
		postCompactionRecoveryCount: 0,
	};
	const verification: ReportRow["verification"] = {};
	const postCompactionTraces: PostCompactionTrace[] = [];
	const verificationToolResults = new Set<string>();
	for (const event of events) {
		switch (event.kind) {
			case "provider_request": counts.providerRequests += 1; break;
			case "turn_end": counts.turns += 1; break;
			case "tool_execution_start": counts.toolCalls += 1; break;
			case "assistant_message":
				counts.tokensInput += number(event.inputTokens);
				counts.tokensOutput += number(event.outputTokens);
				counts.tokensTotal += number(event.totalTokens);
				counts.cacheRead += number(event.cacheRead);
				counts.cacheWrite += number(event.cacheWrite);
				break;
			case "checkpoint_attempt": counts.checkpointAttempts += 1; break;
			case "checkpoint_result":
				if (event.success === true) {
					counts.checkpointSuccesses += 1;
					counts.checkpointFailureStreak = 0;
				} else {
					counts.checkpointFailures += 1;
					counts.checkpointFailureStreak += 1;
					counts.longestCheckpointFailureStreak = Math.max(counts.longestCheckpointFailureStreak, counts.checkpointFailureStreak);
				}
				break;
			case "checkpoint_only_generation": counts.checkpointOnlyGenerations += 1; break;
			case "notes_reminder": counts.reminders += 1; break;
			case "goal_progress": if (event.status === "done") counts.completionSignal = true; break;
			case "tool_result": {
				const category = typeof event.verificationCategory === "string" && event.verificationCategory !== "null" ? event.verificationCategory : null;
				if (!category) break;
				const id = typeof event.toolCallId === "string" ? event.toolCallId : `${category}:${verificationToolResults.size}`;
				if (verificationToolResults.has(id)) break;
				verificationToolResults.add(id);
				const item = verification[category] ?? { attempted: 0, success: 0, error: 0 };
				item.attempted += 1;
				if (event.isError === true && event.verificationExpectedNonMatch !== true) item.error += 1;
				else item.success += 1;
				verification[category] = item;
				break;
			}
			case "post_compaction_trace": {
				if (typeof event.compactionIndex !== "number"
					|| typeof event.traceSequence !== "number"
					|| (event.traceKind !== "thinking" && event.traceKind !== "response")
					|| typeof event.turnIndex !== "number"
					|| typeof event.requestSeq !== "number"
					|| typeof event.textHash !== "string"
					|| typeof event.textLength !== "number"
					|| typeof event.excerpt !== "string"
					|| typeof event.truncated !== "boolean") break;
				postCompactionTraces.push({
					compactionIndex: event.compactionIndex,
					traceSequence: event.traceSequence,
					traceKind: event.traceKind,
					turnIndex: event.turnIndex,
					requestSeq: event.requestSeq,
					textHash: event.textHash,
					textLength: event.textLength,
					excerpt: event.excerpt,
					truncated: event.truncated,
				});
				break;
			}
			case "compaction_attempt": counts.compactionAttempts += 1; break;
			case "compaction_success":
				counts.compactionSuccesses += 1;
				if (event.fromExtension === true) counts.extensionCompactionSuccesses += 1;
				else counts.normalCompactionSuccesses += 1;
				if (typeof event.reductionPercent === "number") {
					counts.compactionReductionTotal += event.reductionPercent;
					counts.compactionReductionCount += 1;
				}
				if (event.firstKeptEntryAdvanced === true) counts.retainedBoundaryAdvancements += 1;
				break;
			case "compaction_failure":
				counts.compactionFailures += 1;
				if (event.aborted === true) counts.abortedCompactionFailures += 1;
				break;
			case "compaction_recovery":
				if (typeof event.latencyMs === "number") {
					counts.postCompactionRecoveryTotal += event.latencyMs;
					counts.postCompactionRecoveryCount += 1;
				}
				break;
			case "verification": break;
		}
	}
	const ended = manifest.endedAt ? Date.parse(manifest.endedAt) : NaN;
	const started = Date.parse(manifest.startedAt);
	return {
		runId: manifest.runId,
		experimentKey: manifest.experimentKey,
		variant: manifest.variant,
		replicate: manifest.replicate,
		taskId: manifest.taskId,
		startedAt: manifest.startedAt,
		endedAt: manifest.endedAt ?? null,
		valid: reasons.length === 0,
		exclusionReasons: reasons,
		completionSignal: counts.completionSignal,
		elapsedMs: Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
		providerRequests: counts.providerRequests,
		turns: counts.turns,
		toolCalls: counts.toolCalls,
		tokensInput: counts.tokensInput,
		tokensOutput: counts.tokensOutput,
		tokensTotal: counts.tokensTotal,
		cacheRead: counts.cacheRead,
		cacheWrite: counts.cacheWrite,
		checkpointAttempts: counts.checkpointAttempts,
		checkpointSuccesses: counts.checkpointSuccesses,
		checkpointFailures: counts.checkpointFailures,
		checkpointSuccessRatePer100Requests: per100(counts.checkpointSuccesses, counts.providerRequests),
		checkpointFailureRatePer100Requests: per100(counts.checkpointFailures, counts.providerRequests),
		longestCheckpointFailureStreak: counts.longestCheckpointFailureStreak,
		checkpointOnlyGenerations: counts.checkpointOnlyGenerations,
		reminders: counts.reminders,
		remindersPer100Requests: per100(counts.reminders, counts.providerRequests),
		compactionAttempts: counts.compactionAttempts,
		compactionSuccesses: counts.compactionSuccesses,
		normalCompactionSuccesses: counts.normalCompactionSuccesses,
		extensionCompactionSuccesses: counts.extensionCompactionSuccesses,
		compactionFailures: counts.compactionFailures,
		abortedCompactionFailures: counts.abortedCompactionFailures,
		compactionReductionPercent: counts.compactionReductionCount ? counts.compactionReductionTotal / counts.compactionReductionCount : null,
		retainedBoundaryAdvancements: counts.retainedBoundaryAdvancements,
		postCompactionRecoveryMs: counts.postCompactionRecoveryCount ? counts.postCompactionRecoveryTotal / counts.postCompactionRecoveryCount : null,
		verification,
		postCompactionTraces,
		model: manifest.model.id,
		provider: manifest.model.provider,
		thinkingLevel: manifest.model.thinkingLevel,
	};
}

export function pairRows(rows: ReportRow[]): PairDelta[] {
	const substantive = rows.filter(isSubstantiveRun);
	const byReplicate = new Map<number, Partial<Record<ReportRow["variant"], ReportRow>>>();
	for (const row of substantive) {
		const pair = byReplicate.get(row.replicate) ?? {};
		if (!pair[row.variant]) pair[row.variant] = row;
		byReplicate.set(row.replicate, pair);
	}
	const pairs: PairDelta[] = [];
	const used = new Set<string>();
	for (const [replicate, pair] of byReplicate) {
		const on = pair["notes-present"];
		const off = pair["notes-absent"];
		if (!on || !off) continue;
		used.add(on.runId);
		used.add(off.runId);
		pairs.push(makePair(on, off, "replicate"));
	}
	const unmatchedOn = substantive.filter(row => row.variant === "notes-present" && !used.has(row.runId)).sort(byStartTime);
	const unmatchedOff = substantive.filter(row => row.variant === "notes-absent" && !used.has(row.runId)).sort(byStartTime);
	for (let index = 0; index < Math.min(unmatchedOn.length, unmatchedOff.length); index += 1) {
		pairs.push(makePair(unmatchedOn[index], unmatchedOff[index], "substantive-fallback"));
	}
	return pairs.sort((a, b) => a.replicate - b.replicate);
}

export function isSubstantiveRun(row: ReportRow): boolean {
	return row.providerRequests >= MIN_SUBSTANTIVE_PROVIDER_REQUESTS || row.toolCalls >= MIN_SUBSTANTIVE_TOOL_CALLS;
}

function makePair(on: ReportRow, off: ReportRow, strategy: PairDelta["strategy"]): PairDelta {
	return {
		replicate: on.replicate,
		notesPresentReplicate: on.replicate,
		notesAbsentReplicate: off.replicate,
		strategy,
		completionSignal: Number(on.completionSignal) - Number(off.completionSignal),
		elapsedMs: delta(on.elapsedMs, off.elapsedMs),
		providerRequests: on.providerRequests - off.providerRequests,
		toolCalls: on.toolCalls - off.toolCalls,
		checkpointFailures: on.checkpointFailures - off.checkpointFailures,
		compactionFailures: on.compactionFailures - off.compactionFailures,
	};
}

function byStartTime(left: ReportRow, right: ReportRow): number {
	return (Date.parse(left.startedAt) || 0) - (Date.parse(right.startedAt) || 0);
}

export function renderCsv(rows: ReportRow[]): string {
	const fields: Array<keyof ReportRow> = ["runId", "experimentKey", "variant", "replicate", "taskId", "valid", "completionSignal", "elapsedMs", "providerRequests", "turns", "toolCalls", "tokensInput", "tokensOutput", "tokensTotal", "cacheRead", "cacheWrite", "checkpointAttempts", "checkpointSuccesses", "checkpointFailures", "checkpointSuccessRatePer100Requests", "checkpointFailureRatePer100Requests", "longestCheckpointFailureStreak", "checkpointOnlyGenerations", "reminders", "remindersPer100Requests", "compactionAttempts", "compactionSuccesses", "normalCompactionSuccesses", "extensionCompactionSuccesses", "compactionFailures", "abortedCompactionFailures", "compactionReductionPercent", "retainedBoundaryAdvancements", "postCompactionRecoveryMs", "model", "provider", "thinkingLevel"];
	return [fields.join(","), ...rows.map(row => fields.map(field => csvValue(row[field])).join(","))].join("\n") + "\n";
}

export function renderMarkdown(experimentKey: string | null, rows: ReportRow[], excluded: Array<{ runId: string; reason: string }>, pairs: PairDelta[]): string {
	const lines = [`# Eval metrics report`, ``, `Experiment: ${experimentKey ?? "none"}`, ``, `Completion signals are observational and do not prove feature correctness. Verification outcomes are reported separately.`, ``, `| Arm | Replicate | Completion | Requests | Tools | Checkpoint failures | Compaction failures |`, `| --- | ---: | ---: | ---: | ---: | ---: | ---: |`];
	for (const row of rows) lines.push(`| ${row.variant} | ${row.replicate} | ${row.completionSignal ? "yes" : "no"} | ${row.providerRequests} | ${row.toolCalls} | ${row.checkpointFailures} | ${row.compactionFailures} |`);
	lines.push("", `Valid pairs: ${pairs.length}`);
	if (pairs.length) {
		lines.push("", "## Notes-present minus Notes-absent", "", "Pairs prefer matching replicate IDs. When an arm has short accidental attempts, substantive runs (at least 10 requests or tools) are paired by start order and labeled as fallback.", "", "| Strategy | Notes replicate | No-notes replicate | Completion | Elapsed ms | Requests | Tools | Checkpoint failures | Compaction failures |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
		for (const pair of pairs) lines.push(`| ${pair.strategy} | ${pair.notesPresentReplicate} | ${pair.notesAbsentReplicate} | ${pair.completionSignal} | ${pair.elapsedMs ?? "n/a"} | ${pair.providerRequests} | ${pair.toolCalls} | ${pair.checkpointFailures} | ${pair.compactionFailures} |`);
	}
	const traceRows = rows.filter(row => row.postCompactionTraces.length > 0);
	if (traceRows.length) {
		lines.push("", "## Post-compaction transcript excerpts", "", "These excerpts are bounded and redacted. Full Pi session files remain at the `sessionFile` paths in each run manifest.");
		for (const row of traceRows) {
			lines.push("", `### ${row.variant} replicate ${row.replicate}`);
			for (const trace of row.postCompactionTraces) {
				const excerpt = trace.excerpt.replace(/\|/gu, "\\|");
				lines.push(`- C${trace.compactionIndex}.${trace.traceSequence} **${trace.traceKind}** (turn ${trace.turnIndex}, request ${trace.requestSeq}, ${trace.textLength} chars${trace.truncated ? ", truncated" : ""}): ${excerpt}`);
			}
		}
	}
	if (excluded.length) lines.push("", `Excluded runs: ${excluded.length}`, ...excluded.slice(0, 20).map(item => `- ${item.runId}: ${item.reason}`));
	return `${lines.join("\n")}\n`;
}

export async function writeReport(report: EvalReport, rootDir = DEFAULT_ROOT): Promise<{ json: string; csv: string; markdown: string }> {
	const directory = join(rootDir, "reports");
	await mkdir(directory, { recursive: true });
	const stamp = report.generatedAt.replace(/[^0-9]/gu, "").slice(0, 14) || "latest";
	const prefix = join(directory, `${report.experimentKey ?? "no-complete-pair"}-${stamp}`);
	const paths = { json: `${prefix}.json`, csv: `${prefix}.csv`, markdown: `${prefix}.md` };
	await writeJsonAtomically(paths.json, { ...report, markdown: undefined });
	await writeTextAtomically(paths.csv, renderCsv(report.rows));
	await writeTextAtomically(paths.markdown, report.markdown);
	return paths;
}

async function loadManifests(root: string): Promise<RunManifest[]> {
	const output: RunManifest[] = [];
	const experiments = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const experiment of experiments) {
		if (!experiment.isDirectory() || experiment.name === "reports" || experiment.name.startsWith(".")) continue;
		const variants = await readdir(join(root, experiment.name), { withFileTypes: true }).catch(() => []);
		for (const variant of variants) {
			if (!variant.isDirectory()) continue;
			const runs = await readdir(join(root, experiment.name, variant.name), { withFileTypes: true }).catch(() => []);
			for (const run of runs) {
				if (!run.isDirectory()) continue;
				try {
					const manifest = JSON.parse(await readFile(join(root, experiment.name, variant.name, run.name, "manifest.json"), "utf8")) as RunManifest;
					if (manifest.kind === "run-manifest") output.push(manifest);
				} catch {
					// Incomplete atomic writes are ignored and never paired.
				}
			}
		}
	}
	return output;
}

async function loadEvents(root: string, manifest: RunManifest): Promise<EvalEvent[]> {
	const files = await findRunDirectory(root, manifest);
	if (!files) return [];
	const text = await readFile(join(files, "events.jsonl"), "utf8").catch(() => "");
	const events: EvalEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as EvalEvent;
			if (event.version === 1 && typeof event.kind === "string") events.push(event);
		} catch {
			// Malformed lines are reflected in the manifest writer counter when known.
		}
	}
	return events;
}

async function findRunDirectory(root: string, manifest: RunManifest): Promise<string | undefined> {
	const variants = await readdir(join(root, manifest.experimentKey, manifest.variant), { withFileTypes: true }).catch(() => []);
	for (const variant of variants) {
		if (!variant.isDirectory()) continue;
		const path = join(root, manifest.experimentKey, manifest.variant, variant.name);
		const candidate = await readFile(join(path, "manifest.json"), "utf8").catch(() => "");
		try {
			if ((JSON.parse(candidate) as RunManifest).runId === manifest.runId) return path;
		} catch {
			// Ignore incomplete directories.
		}
	}
	return undefined;
}

function chooseLatestExperiment(groups: Map<string, RunManifest[]>): string | null {
	let selected: { key: string; timestamp: number } | undefined;
	for (const [key, manifests] of groups) {
		const arms = new Set(manifests.filter(manifest => baseExclusionReasons(manifest).length === 0).map(manifest => manifest.variant));
		if (!arms.has("notes-present") || !arms.has("notes-absent")) continue;
		const timestamp = Math.max(...manifests.map(manifest => Date.parse(manifest.startedAt) || 0));
		if (!selected || timestamp > selected.timestamp) selected = { key, timestamp };
	}
	return selected?.key ?? null;
}

function baseExclusionReasons(manifest: RunManifest): string[] {
	const reasons: string[] = [];
	if (manifest.flags.incompleteShutdown || !manifest.endedAt) reasons.push("incomplete-shutdown");
	if (manifest.flags.dirtyStart) reasons.push("dirty-start");
	if (manifest.flags.modelChanged) reasons.push("model-changed");
	if (manifest.flags.configMismatch) reasons.push("mismatched-config");
	if (manifest.recorder.droppedEvents > 0 || manifest.recorder.writeErrors > 0 || manifest.recorder.malformedEvents > 0 || manifest.recorder.disabled) reasons.push("recorder-compromised");
	if (manifest.target.commit === "unknown" || manifest.target.repository === "unknown" || manifest.target.dirty === "unknown") reasons.push("unknown-target");
	return reasons;
}

function comparabilityReasons(manifest: RunManifest, selected: RunManifest[]): string[] {
	const reference = selected.find(candidate => candidate.runId !== manifest.runId);
	if (!reference) return [];
	const reasons: string[] = [];
	if (manifest.taskHash !== reference.taskHash) reasons.push("mismatched-task-hash");
	if (manifest.target.commit !== reference.target.commit) reasons.push("mismatched-target-start-commit");
	if (manifest.model.provider !== reference.model.provider || manifest.model.id !== reference.model.id || manifest.model.thinkingLevel !== reference.model.thinkingLevel) reasons.push("mismatched-model-config");
	if (manifest.compactionFingerprint !== reference.compactionFingerprint) reasons.push("mismatched-compaction-config");
	if (manifest.variant === "notes-present" && !manifest.notesToolPresent) reasons.push("invalid-notes-arm");
	if (manifest.variant === "notes-absent" && manifest.notesToolPresent) reasons.push("invalid-notes-arm");
	return reasons;
}

function medianSummary(pairs: PairDelta[]): Record<string, number | null> {
	return {
		completionSignal: median(pairs.map(pair => pair.completionSignal)),
		elapsedMs: median(pairs.map(pair => pair.elapsedMs).filter((value): value is number => value !== null)),
		providerRequests: median(pairs.map(pair => pair.providerRequests)),
		toolCalls: median(pairs.map(pair => pair.toolCalls)),
		checkpointFailures: median(pairs.map(pair => pair.checkpointFailures)),
		compactionFailures: median(pairs.map(pair => pair.compactionFailures)),
	};
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function per100(value: number, denominator: number): number {
	return denominator > 0 ? Math.round((value / denominator) * 10000) / 100 : 0;
}

function delta(left: number | null, right: number | null): number | null {
	return left === null || right === null ? null : left - right;
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function csvValue(value: unknown): string {
	const text = value === null || value === undefined ? "" : String(value);
	return /[",\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

if (process.argv[1]?.endsWith("report.ts")) {
	void (async () => {
		const report = await buildReport();
		const paths = await writeReport(report);
		console.log(JSON.stringify({ experimentKey: report.experimentKey, rows: report.rows.length, pairs: report.pairs.length, excluded: report.excluded.length, paths }, null, 2));
	})();
}
