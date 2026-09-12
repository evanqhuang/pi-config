import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	SessionCompactEvent,
	SessionStartEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolInfo,
	ToolResultEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	EVAL_SCHEMA_VERSION,
	MAX_BUFFERED_EVENTS,
	NOTES_REMINDER_TYPE,
	activeNotesTool,
	classifyTool,
	classifyVerification,
	classifyVerificationOutcome,
	compactionFingerprint,
	detectArm,
	eventWithoutSecrets,
	extractSafeResultText,
	failureCategory,
	gitSnapshot,
	isGoalCompletion,
	isSuccessfulNonCheckpointTool,
	makeExperimentKey,
	modelIdentity,
	notesRevisionFromTool,
	redactTraceText,
	reminderCategory,
	sanitizeStatus,
	sha256,
	taskIdentity,
	type EvalArm,
	type EvalEvent,
	type RunManifest,
	stableStringify,
} from "./core.js";
import { AsyncJsonlWriter, writeJsonAtomically } from "./writer.js";

const EVAL_ROOT = join(homedir(), ".pi", "evals");
const PACKAGE_DIR = resolve(new URL(".", import.meta.url).pathname);
const MAX_REMINDER_KEYS = 256;
const POST_COMPACTION_TRACE_MESSAGES = 12;
const POST_COMPACTION_TRACE_EVENTS = 24;

interface PendingEvent {
	version: typeof EVAL_SCHEMA_VERSION;
	kind: string;
	at: string;
	[key: string]: unknown;
}

export interface ExistingRun {
	manifest: RunManifest;
	manifestPath: string;
	root: string;
}

interface RunPaths {
	directory: string;
	manifest: string;
	events: string;
}

interface CompactionRecovery {
	startedAt: number;
	requestSeq: number;
	turnIndex: number;
	tokensBefore: number;
}

interface AfterProviderResponseLike {
	status: number;
}

interface SessionCompactFailedLike {
	reason: string;
	errorMessage?: string;
	aborted: boolean;
	willRetry: boolean;
	fromExtension: boolean;
}

interface RunCounters {
	providerRequests: number;
	turns: number;
	toolCalls: number;
	toolResults: number;
	assistantMessages: number;
	generations: number;
	checkpointAttempts: number;
	checkpointSuccesses: number;
	checkpointFailures: number;
	checkpointFailureStreak: number;
	longestCheckpointFailureStreak: number;
	checkpointOnlyGenerations: number;
	reminders: number;
	compactions: number;
	compactionSuccesses: number;
	compactionFailures: number;
	verification: Record<string, { attempted: number; success: number; error: number }>;
	tokensInput: number;
	tokensOutput: number;
	tokensTotal: number;
	cacheRead: number;
	cacheWrite: number;
	goalCompletionSignal: boolean;
	lastTurnIndex: number;
}

interface RecorderRun {
	manifest: RunManifest;
	paths: RunPaths;
	writer: AsyncJsonlWriter;
	counters: RunCounters;
	toolStarts: Map<string, { startedAt: number; toolName: string }>;
	currentGenerationTools: Set<string>;
	currentRequestSeq: number;
	currentTurnIndex: number;
	lastCompactionBoundary?: string;
	recovery?: CompactionRecovery;
	postCompactionTrace?: {
		compactionIndex: number;
		remainingMessages: number;
		eventCount: number;
	};
	seenReminderKeys: Set<string>;
}

export interface EvalRecorderOptions {
	rootDir?: string;
	now?: () => number;
	maxBufferedEvents?: number;
}

export function emptyCounters(): RunCounters {
	return {
		providerRequests: 0,
		turns: 0,
		toolCalls: 0,
		toolResults: 0,
		assistantMessages: 0,
		generations: 0,
		checkpointAttempts: 0,
		checkpointSuccesses: 0,
		checkpointFailures: 0,
		checkpointFailureStreak: 0,
		longestCheckpointFailureStreak: 0,
		checkpointOnlyGenerations: 0,
		reminders: 0,
		compactions: 0,
		compactionSuccesses: 0,
		compactionFailures: 0,
		verification: {},
		tokensInput: 0,
		tokensOutput: 0,
		tokensTotal: 0,
		cacheRead: 0,
		cacheWrite: 0,
		goalCompletionSignal: false,
		lastTurnIndex: 0,
	};
}

export class EvalRecorder {
	private readonly rootDir: string;
	private readonly now: () => number;
	private readonly maxBufferedEvents: number;
	private readonly pending: PendingEvent[] = [];
	private readonly pendingReminderKeys = new Set<string>();
	private runPromise: Promise<RecorderRun | undefined> | undefined;
	private discoveryPromise: Promise<void> | undefined;
	private run: RecorderRun | undefined;
	private ended = false;
	private preTaskDropped = 0;
	private sessionStart?: SessionStartEvent;

	constructor(private readonly pi: ExtensionAPI, options: EvalRecorderOptions = {}) {
		this.rootDir = options.rootDir ?? EVAL_ROOT;
		this.now = options.now ?? Date.now;
		this.maxBufferedEvents = options.maxBufferedEvents ?? MAX_BUFFERED_EVENTS;
	}

	private getSessionId(ctx: ExtensionContext): string {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return "unknown-session";
		}
	}

	private getSessionFile(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionFile();
		} catch {
			return undefined;
		}
	}

	onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): void {
		this.sessionStart = event;
		this.record("session_start", {
			reason: event.reason,
			resumed: event.reason === "resume" || event.reason === "reload",
			forked: event.reason === "fork",
		});
		this.discoveryPromise = this.discoverExisting(ctx);
		void this.discoveryPromise;
	}

	onTaskPrompt(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
		if (this.ended || this.run || this.runPromise) return;
		const prompt = taskIdentity(event.prompt);
		if (!prompt.normalized) return;
		this.runPromise = (async () => {
			await this.discoveryPromise?.catch(() => undefined);
			return this.run ?? await this.initialize(prompt, ctx);
		})().catch(() => undefined);
		void this.runPromise.then(run => {
			if (run) this.run = run;
		});
	}

	onBeforeProviderRequest(ctx: ExtensionContext): void {
		const requestSeq = this.incrementProviderRequest();
		this.record("provider_request", {
			requestSeq,
			tokens: contextTokens(ctx),
			contextPercent: contextPercent(ctx),
		});
		if (this.run?.recovery && this.run.recovery.requestSeq !== requestSeq) {
			this.record("compaction_first_request", {
				tokens: contextTokens(ctx),
				requestDistance: Math.max(0, requestSeq - this.run.recovery.requestSeq),
			});
		}
	}

	onAfterProviderResponse(event: AfterProviderResponseLike): void {
		this.record("provider_response", { requestSeq: this.currentRequestSeq(), status: event.status });
	}

	onAgentStart(): void {
		this.record("agent_start", {});
	}

	onAgentEnd(event: AgentEndEvent): void {
		this.record("agent_end", { messageCount: Array.isArray(event.messages) ? event.messages.length : 0 });
	}

	onAgentSettled(): void {
		this.record("agent_settled", {});
	}

	onTurnStart(event: { turnIndex: number; timestamp: number }): void {
		if (this.run) this.run.currentTurnIndex = event.turnIndex;
		this.record("turn_start", { turnIndex: event.turnIndex, eventTimestamp: event.timestamp });
	}

	onTurnEnd(event: TurnEndEvent): void {
		this.runCounters().turns += 1;
		this.runCounters().lastTurnIndex = event.turnIndex;
		const checkpointOnly = this.run?.currentGenerationTools.size === 1 && this.run.currentGenerationTools.has("checkpoint_notes");
		if (checkpointOnly && this.run) {
			this.run.counters.checkpointOnlyGenerations += 1;
			this.record("checkpoint_only_generation", { turnIndex: event.turnIndex, requestSeq: this.currentRequestSeq() });
		}
		this.record("turn_end", {
			turnIndex: event.turnIndex,
			toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
			stopReason: assistantStopReason(event.message),
		});
		this.run?.currentGenerationTools.clear();
	}

	onMessageEnd(event: MessageEndEvent): void {
		const message = asRecord(event.message);
		const role = typeof message.role === "string" ? message.role : "unknown";
		if (role === "assistant") {
			const usage = asRecord(message.usage);
			const content = Array.isArray(message.content) ? message.content : [];
			const toolCategories = content
				.filter(item => asRecord(item).type === "toolCall" || asRecord(item).type === "tool_use")
				.map(item => classifyTool(String(asRecord(item).name ?? "unknown")).category);
			this.runCounters().assistantMessages += 1;
			this.runCounters().generations += 1;
			this.runCounters().tokensInput += numberValue(usage.input);
			this.runCounters().tokensOutput += numberValue(usage.output);
			this.runCounters().tokensTotal += numberValue(usage.totalTokens);
			this.runCounters().cacheRead += numberValue(usage.cacheRead);
			this.runCounters().cacheWrite += numberValue(usage.cacheWrite);
			this.recordPostCompactionTrace(message);
			this.record("assistant_message", {
				provider: boundedString(message.provider),
				model: boundedString(message.model),
				stopReason: boundedString(message.stopReason),
				inputTokens: numberValue(usage.input),
				outputTokens: numberValue(usage.output),
				totalTokens: numberValue(usage.totalTokens),
				cacheRead: numberValue(usage.cacheRead),
				cacheWrite: numberValue(usage.cacheWrite),
				toolCallCount: toolCategories.length,
				toolCategories,
			});
		}
		if (message.customType === NOTES_REMINDER_TYPE) this.recordReminder(message);
	}

	onToolExecutionStart(event: ToolExecutionStartEvent): void {
		const now = this.now();
		this.run?.toolStarts.set(event.toolCallId, { startedAt: now, toolName: event.toolName });
		this.run?.currentGenerationTools.add(event.toolName);
		this.record("tool_execution_start", {
			toolCallId: boundedString(event.toolCallId),
			toolCategory: classifyTool(event.toolName).category,
			toolNameCategory: classifyTool(event.toolName).nameCategory,
		});
	}

	onToolExecutionEnd(event: ToolExecutionEndEvent): void {
		const started = this.run?.toolStarts.get(event.toolCallId);
		const durationMs = started ? Math.max(0, this.now() - started.startedAt) : undefined;
		this.run?.toolStarts.delete(event.toolCallId);
		this.record("tool_execution_end", {
			toolCallId: boundedString(event.toolCallId),
			toolCategory: classifyTool(event.toolName).category,
			toolNameCategory: classifyTool(event.toolName).nameCategory,
			durationMs,
			isError: event.isError,
		});
	}

	onToolCall(event: { toolCallId: string; toolName: string; input: unknown }): void {
		const classification = classifyTool(event.toolName);
		this.runCounters().toolCalls += 1;
		this.run?.currentGenerationTools.add(event.toolName);
		if (classification.checkpoint) {
			this.runCounters().checkpointAttempts += 1;
			this.record("checkpoint_attempt", { toolCallId: boundedString(event.toolCallId), requestSeq: this.currentRequestSeq() });
		}
		if (isGoalCompletion(event.toolName, event.input)) {
			this.runCounters().goalCompletionSignal = true;
			this.record("goal_progress", { status: "done" });
		}
	}

	onToolResult(event: ToolResultEvent): void {
		const classification = classifyTool(event.toolName);
		const safeInput = asRecord(event.input);
		const command = typeof safeInput.command === "string" ? safeInput.command : "";
		const verification = classifyVerification(command || event.toolName);
		this.runCounters().toolResults += 1;
		this.record("tool_result", {
			toolCallId: boundedString(event.toolCallId),
			toolCategory: classification.category,
			toolNameCategory: classification.nameCategory,
			isError: event.isError,
			verificationCategory: verification,
			verificationOutcome: verification ? classifyVerificationOutcome(event.isError, extractSafeResultText(event.content), command || event.toolName) : null,
			verificationExpectedNonMatch: verification ? event.isError && classifyVerificationOutcome(event.isError, extractSafeResultText(event.content), command || event.toolName) === "success" : false,
		});
		if (classification.checkpoint) {
			if (event.isError) {
				this.runCounters().checkpointFailures += 1;
				this.runCounters().checkpointFailureStreak += 1;
				this.runCounters().longestCheckpointFailureStreak = Math.max(this.runCounters().longestCheckpointFailureStreak, this.runCounters().checkpointFailureStreak);
			} else {
				this.runCounters().checkpointSuccesses += 1;
				this.runCounters().checkpointFailureStreak = 0;
			}
			this.record("checkpoint_result", { success: !event.isError, isError: event.isError });
		}
		if (verification) {
			const outcome = classifyVerificationOutcome(event.isError, extractSafeResultText(event.content), command || event.toolName);
			const summary = this.runCounters().verification[verification] ?? { attempted: 0, success: 0, error: 0 };
			summary.attempted += 1;
			if (outcome === "success") summary.success += 1;
			if (outcome === "error") summary.error += 1;
			this.runCounters().verification[verification] = summary;
			this.record("verification", { category: verification, outcome });
		}
		this.recordRecoveryIfReady(event.toolName, event.isError);
	}

	onModelSelect(event: { model: { provider?: string; id?: string }; previousModel?: { provider?: string; id?: string } }): void {
		const model = { provider: boundedString(event.model.provider), id: boundedString(event.model.id) };
		if (this.run && (model.provider !== this.run.manifest.model.provider || model.id !== this.run.manifest.model.id)) this.run.manifest.flags.modelChanged = true;
		this.record("model_change", model);
	}

	onThinkingLevel(event: { level: string; previousLevel: string }): void {
		if (this.run && event.level !== this.run.manifest.model.thinkingLevel) this.run.manifest.flags.modelChanged = true;
		this.record("thinking_change", { level: sanitizeStatus(event.level), previousLevel: sanitizeStatus(event.previousLevel) });
	}

	onBeforeCompact(event: { preparation: { firstKeptEntryId: string }; reason: string; willRetry: boolean }): void {
		this.runCounters().compactions += 1;
		this.record("compaction_attempt", {
			reason: sanitizeStatus(event.reason),
			willRetry: event.willRetry,
			retainedBoundary: boundedString(event.preparation.firstKeptEntryId),
		});
	}

	onCompact(event: SessionCompactEvent, ctx: ExtensionContext): void {
		const entry = event.compactionEntry;
		const tokensAfter = contextTokens(ctx);
		const advanced = this.run?.lastCompactionBoundary !== undefined && this.run.lastCompactionBoundary !== entry.firstKeptEntryId;
		if (this.run) {
			this.run.counters.compactionSuccesses += 1;
			this.run.lastCompactionBoundary = entry.firstKeptEntryId;
			this.run.recovery = {
				startedAt: this.now(),
				requestSeq: this.currentRequestSeq(),
				turnIndex: this.run.currentTurnIndex,
				tokensBefore: entry.tokensBefore,
			};
			this.run.postCompactionTrace = {
				compactionIndex: this.run.counters.compactions,
				remainingMessages: POST_COMPACTION_TRACE_MESSAGES,
				eventCount: 0,
			};
		}
		this.record("compaction_success", {
			reason: sanitizeStatus(event.reason),
			willRetry: event.willRetry,
			fromExtension: event.fromExtension || Boolean(entry.fromHook),
			tokensBefore: entry.tokensBefore,
			tokensAfter,
			reductionPercent: tokensAfter !== null && entry.tokensBefore > 0 ? Math.max(0, Math.round((1 - tokensAfter / entry.tokensBefore) * 10000) / 100) : null,
			retainedBoundary: boundedString(entry.firstKeptEntryId),
			firstKeptEntryAdvanced: advanced,
		});
	}

	private recordPostCompactionTrace(message: Record<string, unknown>): void {
		const trace = this.run?.postCompactionTrace;
		if (!trace || trace.remainingMessages <= 0) return;
		const content = Array.isArray(message.content) ? message.content : [];
		for (const item of content) {
			const block = asRecord(item);
			const type = typeof block.type === "string" ? block.type : "";
			const traceKind = type === "thinking" || type === "reasoning"
				? "thinking"
				: type === "text" ? "response" : null;
			if (!traceKind) continue;
			const raw = typeof block.text === "string"
				? block.text
				: typeof block.thinking === "string" ? block.thinking : "";
			if (!raw.trim()) continue;
			const excerpt = redactTraceText(raw);
			this.record("post_compaction_trace", {
				compactionIndex: trace.compactionIndex,
				traceSequence: trace.eventCount + 1,
				traceKind,
				turnIndex: this.run?.currentTurnIndex ?? 0,
				requestSeq: this.currentRequestSeq(),
				textHash: sha256(raw),
				textLength: raw.length,
				excerpt: excerpt.excerpt,
				truncated: excerpt.truncated,
			});
			trace.eventCount += 1;
			if (trace.eventCount >= POST_COMPACTION_TRACE_EVENTS) break;
		}
		trace.remainingMessages -= 1;
		if (trace.eventCount >= POST_COMPACTION_TRACE_EVENTS) trace.remainingMessages = 0;
	}

	onCompactFailed(event: SessionCompactFailedLike): void {
		this.runCounters().compactionFailures += 1;
		this.record("compaction_failure", {
			reason: sanitizeStatus(event.reason),
			aborted: event.aborted,
			willRetry: event.willRetry,
			fromExtension: event.fromExtension,
			failureCategory: failureCategory(event.errorMessage),
		});
	}

	async onShutdown(event: { reason: string }): Promise<void> {
		this.ended = true;
		await this.discoveryPromise?.catch(() => undefined);
		const run = await this.runPromise?.catch(() => undefined);
		if (run && !this.run) this.run = run;
		if (!this.run) return;
		this.record("session_shutdown", { reason: sanitizeStatus(event.reason) });
		const flushDurationMs = await this.run.writer.flush();
		this.run.writer.close();
		const stats = this.run.writer.stats;
		this.run.manifest.endedAt = new Date(this.now()).toISOString();
		this.run.manifest.flags.incompleteShutdown = false;
		this.run.manifest.recorder = {
			droppedEvents: stats.droppedEvents + this.preTaskDropped,
			writeErrors: stats.writeErrors,
			malformedEvents: stats.malformedEvents,
			flushDurationMs,
			disabled: stats.disabled,
		};
		await writeJsonAtomically(this.run.paths.manifest, this.run.manifest).catch(() => undefined);
	}

	status(): { active: boolean; root: string; runId?: string; arm?: EvalArm; path?: string; disabled?: boolean } {
		return {
			active: this.run !== undefined,
			root: this.rootDir,
			runId: this.run?.manifest.runId,
			arm: this.run?.manifest.arm,
			path: this.run?.paths.directory,
			disabled: this.run?.writer.stats.disabled,
		};
	}

	private record(kind: string, fields: Record<string, unknown>): void {
		const event = eventWithoutSecrets(kind, fields, new Date(this.now()).toISOString());
		if (!this.run) {
			if (this.pending.length >= this.maxBufferedEvents) this.preTaskDropped += 1;
			else this.pending.push(event);
			return;
		}
		this.run.writer.append(event);
	}

	private async discoverExisting(ctx: ExtensionContext): Promise<void> {
		if (this.run || this.runPromise) return;
		const sessionId = this.getSessionId(ctx);
		const existing = await findExistingManifest(this.rootDir, sessionId).catch(() => undefined);
		if (!existing) return;
		await this.updateExistingComparability(existing.manifest, ctx);
		const manifest = existing.manifest;
		manifest.flags.resumed = true;
		manifest.flags.incompleteShutdown = true;
		this.run = {
			manifest,
			paths: { directory: existing.root, manifest: existing.manifestPath, events: join(existing.root, "events.jsonl") },
			writer: new AsyncJsonlWriter(join(existing.root, "events.jsonl")),
			counters: emptyCounters(),
			toolStarts: new Map(),
			currentGenerationTools: new Set(),
			currentRequestSeq: 0,
			currentTurnIndex: 0,
			seenReminderKeys: new Set(this.pendingReminderKeys),
		};
		this.flushPendingInto(this.run);
	}

	private async initialize(identity: ReturnType<typeof taskIdentity>, ctx: ExtensionContext): Promise<RecorderRun | undefined> {
		const sessionId = this.getSessionId(ctx);
		const existing = await findExistingManifest(this.rootDir, sessionId).catch(() => undefined);
		if (existing) {
			await this.updateExistingComparability(existing.manifest, ctx);
			existing.manifest.flags.resumed = true;
			existing.manifest.flags.incompleteShutdown = true;
			const run: RecorderRun = {
				manifest: existing.manifest,
				paths: { directory: existing.root, manifest: existing.manifestPath, events: join(existing.root, "events.jsonl") },
				writer: new AsyncJsonlWriter(join(existing.root, "events.jsonl")),
				counters: emptyCounters(),
				toolStarts: new Map(),
				currentGenerationTools: new Set(),
				currentRequestSeq: 0,
				currentTurnIndex: 0,
				seenReminderKeys: new Set(this.pendingReminderKeys),
			};
			this.flushPendingInto(run);
			return run;
		}
		const tools = safeAllTools(this.pi);
		const notesTool = tools.find(tool => tool.name === "checkpoint_notes");
		const armInfo = detectArm(tools);
		const target = await gitSnapshot(ctx.cwd);
		const extensionRevision = await gitSnapshot(PACKAGE_DIR);
		const notesRevision = await notesRevisionFromTool(notesTool);
		const fingerprint = await compactionFingerprint();
		const model = modelIdentity(ctx);
		const experimentKey = makeExperimentKey({
			taskHash: identity.hash,
			targetRepository: target.repository,
			targetStartCommit: target.commit,
			provider: model.provider,
			model: model.id,
			thinkingLevel: model.thinkingLevel,
			compactionFingerprint: fingerprint,
		});
		const variant = armInfo.arm;
		const directory = await allocateRunDirectory(this.rootDir, experimentKey, variant, sessionId);
		const paths = { directory, manifest: join(directory, "manifest.json"), events: join(directory, "events.jsonl") };
		const manifest: RunManifest = {
			schemaVersion: EVAL_SCHEMA_VERSION,
			kind: "run-manifest",
			runId: sessionId,
			taskId: identity.taskId,
			taskHash: identity.hash,
			promptLength: identity.length,
			arm: variant,
			notesToolPresent: armInfo.notesToolPresent,
			notesToolActive: activeNotesTool(safeActiveTools(this.pi)),
			variant,
			replicate: Number(directory.split("/").pop()?.split("-")[0] ?? 0),
			experimentKey,
			startedAt: new Date(this.now()).toISOString(),
			sessionFile: this.getSessionFile(ctx),
			sessionStartReason: this.sessionStart?.reason,
			target,
			notesRevision,
			extensionRevision,
			model,
			compactionFingerprint: fingerprint,
			flags: {
				resumed: false,
				forked: this.sessionStart?.reason === "fork",
				dirtyStart: target.dirty === true,
				modelChanged: false,
				configMismatch: false,
				incompleteShutdown: true,
			},
			recorder: { droppedEvents: 0, writeErrors: 0, malformedEvents: 0, disabled: false },
		};
		await mkdir(directory, { recursive: true });
		await writeJsonAtomically(paths.manifest, manifest);
		const run: RecorderRun = {
			manifest,
			paths,
			writer: new AsyncJsonlWriter(paths.events),
			counters: emptyCounters(),
			toolStarts: new Map(),
			currentGenerationTools: new Set(),
			currentRequestSeq: 0,
			currentTurnIndex: 0,
			seenReminderKeys: new Set(this.pendingReminderKeys),
		};
		this.flushPendingInto(run);
		return run;
	}

	private async updateExistingComparability(manifest: RunManifest, ctx: ExtensionContext): Promise<void> {
		const model = modelIdentity(ctx);
		if (model.provider !== "unknown" && model.id !== "unknown" && (model.provider !== manifest.model.provider || model.id !== manifest.model.id || model.thinkingLevel !== manifest.model.thinkingLevel)) {
			manifest.flags.modelChanged = true;
		}
		if (detectArm(safeAllTools(this.pi)).arm !== manifest.arm) manifest.flags.configMismatch = true;
		if (manifest.compactionFingerprint !== await compactionFingerprint()) manifest.flags.configMismatch = true;
	}

	private flushPendingInto(run: RecorderRun): void {
		for (const event of this.pending.splice(0)) run.writer.append(event as EvalEvent);
		this.preTaskDropped = 0;
	}

	private recordReminder(message: Record<string, unknown>): void {
		const category = reminderCategory(message.content);
		if (!category) return;
		const rawIdentity = typeof message.timestamp === "string" || typeof message.timestamp === "number"
			? String(message.timestamp)
			: sha256(typeof message.content === "string" ? message.content : stableStringify(message.content));
		const key = `${category}:${rawIdentity}`;
		if (!this.run) {
			if (this.pendingReminderKeys.has(key)) return;
			this.pendingReminderKeys.add(key);
			this.record("notes_reminder", { category });
			return;
		}
		if (this.run.seenReminderKeys.has(key)) return;
		this.run.seenReminderKeys.add(key);
		if (this.run.seenReminderKeys.size > MAX_REMINDER_KEYS) this.run.seenReminderKeys.delete(this.run.seenReminderKeys.values().next().value as string);
		this.run.counters.reminders += 1;
		this.record("notes_reminder", { category });
	}

	private recordRecoveryIfReady(toolName: string, isError: boolean): void {
		if (!this.run?.recovery || !isSuccessfulNonCheckpointTool(toolName, isError)) return;
		const recovery = this.run.recovery;
		this.run.recovery = undefined;
		this.record("compaction_recovery", {
			latencyMs: Math.max(0, this.now() - recovery.startedAt),
			requestDistance: Math.max(0, this.currentRequestSeq() - recovery.requestSeq),
			turnDistance: Math.max(0, this.run.currentTurnIndex - recovery.turnIndex),
			tokensBefore: recovery.tokensBefore,
		});
	}

	private runCounters(): RunCounters {
		if (!this.run) return emptyCounters();
		return this.run.counters;
	}

	private incrementProviderRequest(): number {
		if (!this.run) return 0;
		this.run.counters.providerRequests += 1;
		this.run.currentRequestSeq = this.run.counters.providerRequests;
		return this.run.currentRequestSeq;
	}

	private currentRequestSeq(): number {
		return this.run?.currentRequestSeq ?? 0;
	}
}

export default function evalMetricsExtension(pi: ExtensionAPI): void {
	const recorder = new EvalRecorder(pi);
	pi.on("session_start", (event, ctx) => recorder.onSessionStart(event, ctx));
	pi.on("before_agent_start", (event, ctx) => recorder.onTaskPrompt(event, ctx));
	pi.on("before_provider_request", (_event, ctx) => recorder.onBeforeProviderRequest(ctx));
	pi.on("after_provider_response", event => recorder.onAfterProviderResponse(event));
	pi.on("agent_start", () => recorder.onAgentStart());
	pi.on("agent_end", event => recorder.onAgentEnd(event));
	pi.on("agent_settled", () => recorder.onAgentSettled());
	pi.on("turn_start", event => recorder.onTurnStart(event));
	pi.on("turn_end", event => recorder.onTurnEnd(event));
	pi.on("message_end", event => recorder.onMessageEnd(event));
	pi.on("tool_execution_start", event => recorder.onToolExecutionStart(event));
	pi.on("tool_execution_end", event => recorder.onToolExecutionEnd(event));
	pi.on("tool_call", event => recorder.onToolCall(event));
	pi.on("tool_result", event => recorder.onToolResult(event));
	pi.on("model_select", event => recorder.onModelSelect(event));
	pi.on("thinking_level_select", event => recorder.onThinkingLevel(event));
	pi.on("session_before_compact", event => recorder.onBeforeCompact(event));
	pi.on("session_compact", (event, ctx) => recorder.onCompact(event, ctx));
	pi.on("session_compact_failed", event => recorder.onCompactFailed(event));
	pi.on("session_shutdown", event => recorder.onShutdown(event));
	pi.registerCommand("eval-metrics", {
		description: "Show the automatic eval-metrics recorder status",
		handler: async (_args, ctx) => {
			const status = recorder.status();
			ctx.ui.notify(status.active ? `Eval metrics: ${status.arm ?? "unknown"} → ${status.path ?? status.root}` : `Eval metrics waiting for the first task prompt → ${status.root}`, "info");
		},
	});
}

function safeAllTools(pi: ExtensionAPI): ToolInfo[] {
	try {
		return pi.getAllTools();
	} catch {
		return [];
	}
}

function safeActiveTools(pi: ExtensionAPI): string[] {
	try {
		return pi.getActiveTools();
	} catch {
		return [];
	}
}

function contextTokens(ctx: ExtensionContext): number | null {
	try {
		return ctx.getContextUsage()?.tokens ?? null;
	} catch {
		return null;
	}
}

function contextPercent(ctx: ExtensionContext): number | null {
	try {
		return ctx.getContextUsage()?.percent ?? null;
	} catch {
		return null;
	}
}

function assistantStopReason(message: unknown): string | null {
	const value = asRecord(message).stopReason;
	return typeof value === "string" ? value.slice(0, 48) : null;
}

function boundedString(value: unknown): string | null {
	return typeof value === "string" ? value.slice(0, 128) : null;
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function findExistingManifest(root: string, sessionId: string): Promise<ExistingRun | undefined> {
	if (!sessionId) return undefined;
	const experiments = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const experiment of experiments) {
		if (!experiment.isDirectory() || experiment.name.startsWith(".")) continue;
		const variants = await readdir(join(root, experiment.name), { withFileTypes: true }).catch(() => []);
		for (const variant of variants) {
			if (!variant.isDirectory()) continue;
			const runs = await readdir(join(root, experiment.name, variant.name), { withFileTypes: true }).catch(() => []);
			for (const run of runs) {
				if (!run.isDirectory() || !run.name.endsWith(`-${sessionId}`)) continue;
				const manifestPath = join(root, experiment.name, variant.name, run.name, "manifest.json");
				try {
					const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RunManifest;
					if (manifest.runId === sessionId && manifest.kind === "run-manifest") return { manifest, manifestPath, root: join(root, experiment.name, variant.name, run.name) };
				} catch {
					// Ignore incomplete or concurrently-created directories.
				}
			}
		}
	}
	return undefined;
}

export async function allocateRunDirectory(root: string, experimentKey: string, variant: EvalArm, sessionId: string): Promise<string> {
	const variantRoot = join(root, experimentKey, variant);
	await mkdir(variantRoot, { recursive: true });
	const lockPath = join(variantRoot, ".replicate.lock");
	let locked = false;
	for (let attempt = 0; attempt < 80 && !locked; attempt += 1) {
		try {
			await mkdir(lockPath);
			locked = true;
		} catch {
			await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
		}
	}
	if (!locked) throw new Error("replicate allocation lock timeout");
	try {
		const entries = await readdir(variantRoot, { withFileTypes: true });
		let next = 1;
		for (const entry of entries) {
			const match = entry.name.match(/^(\d+)-/u);
			if (entry.isDirectory() && match) next = Math.max(next, Number(match[1]) + 1);
		}
		const directory = join(variantRoot, `${String(next).padStart(3, "0")}-${sessionId}`);
		await mkdir(directory, { recursive: false });
		return directory;
	} finally {
		await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
	}
}
