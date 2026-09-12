import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export const EVAL_SCHEMA_VERSION = 1 as const;
export const TASK_ID_LENGTH = 16;
export const MAX_BUFFERED_EVENTS = 128;
export const MAX_EVENT_CATEGORY_LENGTH = 48;
export const NOTES_REMINDER_TYPE = "pi-notes-reminder";
export const POST_COMPACTION_TRACE_EXCERPT_MAX = 900;

export type EvalArm = "notes-present" | "notes-absent";

export interface GitSnapshot {
	commit: string | "unknown";
	dirty: boolean | "unknown";
	repository: string | "unknown";
}

export interface NotesRevision {
	commit: string;
	dirty: boolean;
	repository: string;
	sourceHash: string;
}

export interface ModelIdentity {
	provider: string;
	id: string;
	thinkingLevel: string;
}

export interface RunManifest {
	schemaVersion: typeof EVAL_SCHEMA_VERSION;
	kind: "run-manifest";
	runId: string;
	taskId: string;
	taskHash: string;
	promptLength: number;
	arm: EvalArm;
	notesToolPresent: boolean;
	notesToolActive: boolean;
	variant: EvalArm;
	replicate: number;
	experimentKey: string;
	startedAt: string;
	endedAt?: string;
	sessionFile?: string;
	sessionStartReason?: string;
	target: GitSnapshot;
	notesRevision: NotesRevision | null;
	extensionRevision: GitSnapshot;
	model: ModelIdentity;
	compactionFingerprint: string;
	flags: {
		resumed: boolean;
		forked: boolean;
		dirtyStart: boolean;
		modelChanged: boolean;
		configMismatch: boolean;
		incompleteShutdown: boolean;
	};
	recorder: {
		droppedEvents: number;
		writeErrors: number;
		malformedEvents: number;
		flushDurationMs?: number;
		disabled: boolean;
	};
}

export interface EvalEvent {
	version: typeof EVAL_SCHEMA_VERSION;
	kind: string;
	at: string;
	[key: string]: unknown;
}

/** Allowlist event fields at the persistence boundary; raw payloads never cross it. */
export function eventWithoutSecrets(kind: string, fields: Record<string, unknown>, at = new Date().toISOString()): EvalEvent {
	const denied = /^(prompt|payload|args|input|output|thinking|plan|log|file|content|result|summary|errorMessage|details)$/iu;
	const safe: Record<string, unknown> = { version: EVAL_SCHEMA_VERSION, kind, at };
	for (const [key, value] of Object.entries(fields)) {
		if (denied.test(key)) continue;
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") safe[key] = value;
		else if (Array.isArray(value) && value.every(item => typeof item === "string")) safe[key] = value.slice(0, 32);
	}
	return safe as EvalEvent;
}

export interface ToolClassification {
	nameCategory: string;
	category: string;
	checkpoint: boolean;
	verification: string | null;
}

export interface ToolMetadataLike {
	name: string;
	sourceInfo?: { path?: string; source?: string };
}

export function normalizeTaskPrompt(prompt: string): string {
	return prompt.replace(/\r\n?/gu, "\n").trim();
}

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function taskIdentity(prompt: string): { normalized: string; hash: string; taskId: string; length: number } {
	const normalized = normalizeTaskPrompt(prompt);
	const hash = sha256(normalized);
	return { normalized, hash, taskId: hash.slice(0, TASK_ID_LENGTH), length: normalized.length };
}

export function detectArm(tools: readonly ToolMetadataLike[]): {
	arm: EvalArm;
	notesToolPresent: boolean;
} {
	const notesToolPresent = tools.some(tool => tool.name === "checkpoint_notes");
	return { arm: notesToolPresent ? "notes-present" : "notes-absent", notesToolPresent };
}

export function activeNotesTool(activeTools: readonly string[]): boolean {
	return activeTools.includes("checkpoint_notes");
}

export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function makeExperimentKey(input: {
	taskHash: string;
	targetRepository: string;
	targetStartCommit: string;
	provider: string;
	model: string;
	thinkingLevel: string;
	compactionFingerprint: string;
}): string {
	return `exp-${sha256(stableStringify(input)).slice(0, 24)}`;
}

export function classifyTool(toolName: string): ToolClassification {
	const normalized = toolName.trim().toLowerCase();
	const checkpoint = normalized === "checkpoint_notes";
	let category = "other";
	if (normalized === "bash" || normalized === "powershell") category = "shell";
	else if (["read", "grep", "find", "ls"].includes(normalized)) category = "inspection";
	else if (["edit", "write"].includes(normalized)) category = "mutation";
	else if (normalized === "goal_progress") category = "goal";
	else if (checkpoint) category = "checkpoint";
	else if (normalized.includes("test") || normalized.includes("build") || normalized.includes("lint") || normalized.includes("typecheck")) category = "verification";
	return {
		nameCategory: boundedCategory(normalized || "unknown"),
		category,
		checkpoint,
		verification: classifyVerification(toolName),
	};
}

export function classifyVerification(value: string): string | null {
	const normalized = value.toLowerCase();
	if (/\b(test|vitest|jest|pytest|cargo test|go test|npm test)\b/u.test(normalized)) return "test";
	if (/\b(build|compile|tsc|typecheck|type-check)\b/u.test(normalized)) return "build";
	if (/\b(lint|format|check|verify|validation)\b/u.test(normalized)) return "check";
	return null;
}

export function classifyVerificationOutcome(isError: boolean, resultText?: string, command = ""): "success" | "error" | "unknown" {
	if (!isError) return "success";
	if (isExpectedNoMatchProbe(command) && !hasFailureMarker(resultText)) return "success";
	return "error";
}

function isExpectedNoMatchProbe(command: string): boolean {
	return /\|\s*(?:grep|rg)\b/iu.test(command) && /(?:fail|error|exception|traceback|✕)/iu.test(command);
}

function hasFailureMarker(resultText?: string): boolean {
	return typeof resultText === "string" && /(?:^|\n)\s*(?:fail\b|✕|error:|exception|traceback)/imu.test(resultText);
}

export function boundedCategory(value: string, max = MAX_EVENT_CATEGORY_LENGTH): string {
	return value.replace(/[^a-zA-Z0-9_.:-]/gu, "_").slice(0, max) || "unknown";
}

export function failureCategory(value: unknown): string {
	if (typeof value !== "string") return "unknown";
	const text = value.toLowerCase();
	if (/abort|cancel/u.test(text)) return "aborted";
	if (/token|context|limit|overflow/u.test(text)) return "context-limit";
	if (/timeout|timed out/u.test(text)) return "timeout";
	if (/auth|permission|credential/u.test(text)) return "authorization";
	if (/network|fetch|connect|socket/u.test(text)) return "network";
	return "provider-or-extension";
}

export function reminderCategory(content: unknown): string | null {
	if (typeof content !== "string") return null;
	if (!content.includes("TASK NOTES")) return null;
	if (/REQUESTED/u.test(content)) return "explicit-request";
	if (/COMPACTION|COMPACT/u.test(content)) return "compaction";
	if (/REENTRY|RE-ENTRY/u.test(content)) return "reentry";
	if (/CHECKPOINT/u.test(content)) return "checkpoint";
	return "notes-reminder";
}

export function isSuccessfulNonCheckpointTool(toolName: string, isError: boolean): boolean {
	return !isError && !classifyTool(toolName).checkpoint;
}

export function isGoalCompletion(toolName: string, input: unknown): boolean {
	if (toolName !== "goal_progress" || !input || typeof input !== "object") return false;
	return (input as Record<string, unknown>).status === "done";
}

export function extractSafeResultText(result: unknown): string | undefined {
	if (typeof result === "string") return result.slice(0, 2000);
	if (!Array.isArray(result)) return undefined;
	const text = result
		.filter(item => item && typeof item === "object" && (item as Record<string, unknown>).type === "text")
		.map(item => (item as Record<string, unknown>).text)
		.filter((item): item is string => typeof item === "string")
		.join(" ");
	return text ? text.slice(0, 2000) : undefined;
}

export function redactTraceText(value: string, maxLength = POST_COMPACTION_TRACE_EXCERPT_MAX): { excerpt: string; truncated: boolean } {
	const home = homedir().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
	const redacted = value
		.replace(new RegExp(`(?:${home}|/Users/[^\\s/]+|/home/[^\\s/]+)`, "gu"), "~")
		.replace(/\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|cookie)\b\s*[:=]\s*[^\s,;]+/giu, match => match.replace(/([:=]).*$/u, "$1 [REDACTED]"))
		.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, "[REDACTED]")
		.replace(/https?:\/\/[^\s)]+/giu, "[URL]")
		.replace(/\s+/gu, " ")
		.trim();
	if (redacted.length <= maxLength) return { excerpt: redacted, truncated: false };
	const suffixLength = Math.min(180, Math.floor(maxLength / 4));
	const prefixLength = Math.max(0, maxLength - suffixLength - 12);
	return {
		excerpt: `${redacted.slice(0, prefixLength)} … ${redacted.slice(-suffixLength)}`,
		truncated: true,
	};
}

export async function gitSnapshot(path: string): Promise<GitSnapshot> {
	try {
		const root = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
		const commit = (await git(root, ["rev-parse", "HEAD"])).trim();
		const status = await git(root, ["status", "--porcelain"]);
		return { commit: commit || "unknown", dirty: status.trim().length > 0, repository: sha256(resolve(root)) };
	} catch {
		return { commit: "unknown", dirty: "unknown", repository: "unknown" };
	}
}

export async function notesRevisionFromTool(tool: ToolMetadataLike | undefined): Promise<NotesRevision | null> {
	const sourcePath = tool?.sourceInfo?.path;
	if (!sourcePath) return null;
	try {
		const resolved = resolve(sourcePath);
		const snapshot = await gitSnapshot(await directoryOf(resolved));
		if (snapshot.commit === "unknown" || snapshot.dirty === "unknown" || snapshot.repository === "unknown") return null;
		return {
			commit: snapshot.commit,
			dirty: snapshot.dirty,
			repository: snapshot.repository,
			sourceHash: sha256(resolved),
		};
	} catch {
		return null;
	}
}

export async function compactionFingerprint(home = homedir()): Promise<string> {
	const root = resolve(home, ".pi", "agent");
	const files = ["auto-compact.json", "auto-compact-settings.json"];
	const values: Record<string, string> = {};
	for (const file of files) {
		try {
			values[file] = await readFile(resolve(root, file), "utf8");
		} catch {
			values[file] = "missing";
		}
	}
	return sha256(stableStringify(values));
}

export function modelIdentity(ctx: { model?: { provider?: string; id?: string }; thinkingLevel?: string }): ModelIdentity {
	return {
		provider: ctx.model?.provider ?? "unknown",
		id: ctx.model?.id ?? "unknown",
		thinkingLevel: ctx.thinkingLevel ?? "unknown",
	};
}

export function sanitizeStatus(value: unknown): string {
	return boundedCategory(typeof value === "string" ? value : "unknown");
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024 });
	return result.stdout;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function directoryOf(path: string): Promise<string> {
	try {
		return (await stat(path)).isDirectory() ? path : dirname(path);
	} catch {
		return dirname(path);
	}
}
