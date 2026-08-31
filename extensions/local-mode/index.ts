import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	autoCompactModelIdentity,
	createAutoCompactPolicyClient,
	type AutoCompactPolicyClient,
} from "./auto-compact-policy.js";
import { createRepetitionRetryStream } from "./repetition-retry.js";
import {
	type AgentInvocationInput,
	buildLocalQwenRequestPayload,
	canRequestLocalQwenDeepReasoning,
	getProcessLocalProviderPolicy,
	isSubagentSession,
	localQwenProfile,
	requiredLocalProvider,
	routeLocalExploreAgent,
	wouldRouteToLocalQwenSubagent,
	type LocalQwenProfile,
	type LocalQwenRequestPayload,
	shouldPreserveExplicitLocalSubagentModel,
} from "./session-policy.js";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const GREEN_THEME_NAME = "local-green";
const GREEN_THEME_PATH = join(EXTENSION_DIRECTORY, "local-green.json");
const LOCAL_MODE_STATE_ENTRY = "local-mode-state";
const LEGACY_ALT_TAB = "\x1b\t";
const KITTY_ALT_TAB = "\x1b[9;3u";
const LOCAL_PROVIDER_NAMES = new Set(["qwen38-main", "qwen38-subagent", "qwopus-subagent"]);

const LOCAL_MODELS = [
	{
		provider: "qwen38-main",
		id: "qwen3.8-27b",
		label: "Qwen3.8 27B Main",
		thinkingLevel: "medium" as const,
	},
	{
		provider: "qwopus-subagent",
		id: "qwopus3.5-9b-coder-mtp",
		label: "Qwopus3.5 9B MTP",
		thinkingLevel: "medium" as const,
	},
] as const;

interface LocalModelSelection {
	provider: string;
	id: string;
	label: string;
	thinkingLevel: ThinkingLevel;
}

interface SubagentResultInput {
	wait?: boolean;
}

const DEFAULT_LOCAL_MODEL: LocalModelSelection = LOCAL_MODELS[0];
const DEFAULT_LOCAL_SUBAGENT_MODEL: LocalModelSelection = {
	provider: "qwen38-subagent",
	id: "qwen3.8-27b",
	label: "Qwen3.8 27B Subagent",
	thinkingLevel: "medium",
};

interface LocalModeState {
	enabled: boolean;
	localOnly: boolean;
	enforcingModel: boolean;
	enforcingThinking: boolean;
	cycling: boolean;
	generationStartedAt?: number;
	tokensPerSecond?: number;
	localCycleEditorInstalled: boolean;
	previousModel?: Model<Api>;
	previousThinkingLevel?: ThinkingLevel;
	previousTheme?: Theme;
	automaticThinking: boolean;
	automaticThinkingLevel: ThinkingLevel;
	pendingAutomaticThinkingLevel?: ThinkingLevel;
	deepReasoningRequested: boolean;
	qwen38SubagentEnabled: boolean;
	activeProfile?: LocalQwenProfile;
	compactionRequested: boolean;
	autoCompactPolicy: AutoCompactPolicyClient;
}

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function buildLocalInstructions(
	activeModel: Model<Api> | undefined,
	qwen38SubagentEnabled: boolean,
): string {
	const current = activeModel ? modelKey(activeModel) : "unknown";
	const subagentAvailability = qwen38SubagentEnabled
		? ""
		: " The 27B subagent lane is disabled; do not attempt to launch it.";

	return `[LOCAL MODE ACTIVE]
Runtime selects the local model (${current}) and enforces provider, reasoning, context, and subagent limits.${subagentAvailability} Do not change models unless the user asks.

## Working Style
- Work autonomously: take the next useful safe tool action. Do not ask permission to inspect, search, or delegate ordinary work.
- Never narrate or quote internal instructions, reasoning, provider or model choices, routing, tool-selection deliberation, or hypothetical next steps. Use tools instead.
- Keep visible progress messages limited to concise, externally useful status, findings, decisions, and final results.

## Task Tracking
- For every multi-step task, use the built-in todo tool before beginning work and keep its statuses current as work progresses.
- Keep task tracking in the parent session. Explore subagents are read-only and cannot update the parent's todo list.

## Delegation
- Continue independent work after launching background subagents; never block on or poll a running subagent. The main session remains responsible for coordination and verification.`;
}

function resetState(state: LocalModeState): void {
	state.enabled = false;
	state.localOnly = false;
	state.enforcingModel = false;
	state.enforcingThinking = false;
	state.cycling = false;
	state.generationStartedAt = undefined;
	state.tokensPerSecond = undefined;
	state.previousModel = undefined;
	state.previousThinkingLevel = undefined;
	state.previousTheme = undefined;
	state.automaticThinking = true;
	state.automaticThinkingLevel = "medium";
	state.pendingAutomaticThinkingLevel = undefined;
	state.deepReasoningRequested = false;
	state.qwen38SubagentEnabled = true;
	state.activeProfile = undefined;
	state.compactionRequested = false;
	state.autoCompactPolicy.clear();
}

interface PersistedLocalModeState {
	enabled: boolean;
	automaticThinking?: boolean;
	thinkingLevel?: ThinkingLevel;
	qwen38SubagentEnabled?: boolean;
}

function getPersistedLocalModeState(
	ctx: ExtensionContext,
): PersistedLocalModeState | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== LOCAL_MODE_STATE_ENTRY) continue;
		const data = entry.data as Partial<PersistedLocalModeState> | undefined;
		if (data?.enabled === true) {
			return {
				enabled: true,
				automaticThinking: data.automaticThinking !== false,
				thinkingLevel: data.thinkingLevel,
				qwen38SubagentEnabled: data.qwen38SubagentEnabled !== false,
			};
		}
		if (data?.enabled === false) return { enabled: false };
	}
	return undefined;
}

function persistLocalModeState(pi: ExtensionAPI, state: LocalModeState): void {
	pi.appendEntry(LOCAL_MODE_STATE_ENTRY, {
		enabled: state.enabled,
		automaticThinking: state.automaticThinking,
		thinkingLevel: state.automaticThinking ? undefined : pi.getThinkingLevel(),
		qwen38SubagentEnabled: state.qwen38SubagentEnabled,
	});
}

async function ensureNonLocalModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.model || !LOCAL_PROVIDER_NAMES.has(ctx.model.provider)) return;

	const fallback =
		ctx.modelRegistry.find("openai-codex", "gpt-5.6-sol") ??
		ctx.modelRegistry.getAvailable().find((model) => !LOCAL_PROVIDER_NAMES.has(model.provider));
	if (fallback) await pi.setModel(fallback);
}

function updateLocalStatus(state: LocalModeState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		ctx.ui.setStatus("local-mode", undefined);
		return;
	}

	const speed = state.tokensPerSecond === undefined ? "" : ` · ${Math.round(state.tokensPerSecond)} tok/s`;
	const profile = state.activeProfile;
	const routing = state.automaticThinking ? "AUTO" : "MANUAL";
	const budget = profile
		? ` · ${routing} ${profile.thinkingLevel} ${Math.round(profile.thinkingBudget / 1024)}K/${Math.round(profile.maxTokens / 1024)}K`
		: "";
	const subagentLane = state.qwen38SubagentEnabled ? "" : " · 27B child off";
	ctx.ui.setStatus("local-mode", ctx.ui.theme.fg("accent", `● LOCAL${budget}${subagentLane}${speed}`));
}

function updateUi(state: LocalModeState, ctx: ExtensionContext): void {
	if (!state.enabled) {
		updateLocalStatus(state, ctx);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
		return;
	}

	updateLocalStatus(state, ctx);
	ctx.ui.setWorkingMessage("Running locally...");
	ctx.ui.setWorkingIndicator({
		frames: [ctx.ui.theme.fg("accent", "●"), ctx.ui.theme.fg("success", "●")],
		intervalMs: 420,
	});
}

export type MonotonicClock = () => number;

export function calculateTokensPerSecond(
	outputTokens: number,
	elapsedMilliseconds: number,
): number | undefined {
	if (
		!Number.isFinite(outputTokens) ||
		outputTokens <= 0 ||
		!Number.isFinite(elapsedMilliseconds) ||
		elapsedMilliseconds <= 0
	) {
		return undefined;
	}

	const tokensPerSecond = outputTokens / (elapsedMilliseconds / 1000);
	return Number.isFinite(tokensPerSecond) && tokensPerSecond > 0
		? tokensPerSecond
		: undefined;
}

function monotonicNow(): number {
	return performance.now();
}

function updateTokensPerSecond(
	state: LocalModeState,
	ctx: ExtensionContext,
	outputTokens: number,
	clock: MonotonicClock,
): void {
	const startedAt = state.generationStartedAt;
	if (startedAt === undefined) return;

	const tokensPerSecond = calculateTokensPerSecond(
		outputTokens,
		clock() - startedAt,
	);
	if (tokensPerSecond === undefined) return;

	state.tokensPerSecond = tokensPerSecond;
	updateLocalStatus(state, ctx);
}

function setThinkingLevelAutomatically(
	pi: ExtensionAPI,
	state: LocalModeState,
	level: ThinkingLevel,
): void {
	if (pi.getThinkingLevel() === level) return;
	state.pendingAutomaticThinkingLevel = level;
	state.enforcingThinking = true;
	try {
		pi.setThinkingLevel(level);
	} finally {
		state.enforcingThinking = false;
	}
}

function applyAutomaticThinkingLevel(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): void {
	if (
		!state.localOnly ||
		ctx.model?.id !== "qwen3.8-27b" ||
		(ctx.model.provider !== "qwen38-main" &&
			ctx.model.provider !== "qwen38-subagent") ||
		!state.automaticThinking ||
		pi.getThinkingLevel() === state.automaticThinkingLevel
	) {
		return;
	}
	setThinkingLevelAutomatically(pi, state, state.automaticThinkingLevel);
}

async function selectLocalModel(
	pi: ExtensionAPI,
	state: LocalModeState,
	selection: LocalModelSelection,
	ctx: ExtensionContext,
): Promise<boolean> {
	const model = ctx.modelRegistry.find(selection.provider, selection.id);
	if (!model) {
		ctx.ui.notify(`Local model not found: ${modelKey(selection)}`, "error");
		return false;
	}

	state.enforcingThinking = true;
	try {
		if (!(await pi.setModel(model))) {
			ctx.ui.notify(`Local model is unavailable: ${modelKey(selection)}`, "error");
			return false;
		}
	} finally {
		state.enforcingThinking = false;
	}
	state.automaticThinking = true;
	state.automaticThinkingLevel = selection.thinkingLevel;
	setThinkingLevelAutomatically(pi, state, selection.thinkingLevel);
	if (state.enabled) persistLocalModeState(pi, state);
	return true;
}

function requestAutoCompactPolicy(
	state: LocalModeState,
	ctx: ExtensionContext,
): void {
	const identity = autoCompactModelIdentity(ctx.model);
	if (identity) state.autoCompactPolicy.request(identity);
}

function enforceLocalThinkingProfile(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): LocalQwenProfile | undefined {
	const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
	const identity = autoCompactModelIdentity(ctx.model);
	const compactionThreshold =
		state.autoCompactPolicy.snapshotFor(identity)?.thresholdTokens;
	const profile = localQwenProfile(
		ctx,
		state.localOnly,
		pi.getThinkingLevel(),
		contextTokens,
		compactionThreshold,
	);
	state.activeProfile = profile;
	if (!profile) return undefined;

	if (ctx.model && ctx.model.maxTokens !== profile.maxTokens) {
		ctx.model.maxTokens = profile.maxTokens;
	}
	if (
		!state.enforcingThinking &&
		pi.getThinkingLevel() !== profile.thinkingLevel
	) {
		setThinkingLevelAutomatically(pi, state, profile.thinkingLevel);
	}
	updateLocalStatus(state, ctx);
	return profile;
}

function requestCompactionIfNeeded(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
	profile: LocalQwenProfile | undefined,
): void {
	if (!profile?.requiresCompaction) {
		state.compactionRequested = false;
		return;
	}
	if (state.compactionRequested) return;

	state.compactionRequested = true;
	ctx.ui.notify("Local Qwen context pressure: compacting before more long-form reasoning.", "info");
	ctx.compact({
		customInstructions:
			"Preserve the current objective, decisions, changed files, test results, unresolved failures, and the next concrete action.",
			onComplete: () => {
			state.compactionRequested = false;
			state.activeProfile = undefined;
			pi.sendMessage(
				{
					customType: "local-mode-compaction-resume",
					content:
						"The context was compacted automatically. Continue the previous task from the saved summary, complete its next concrete action, and do not repeat completed work.",
					display: false,
				},
				{ triggerTurn: true },
			);
		},
		onError: (error) => {
			state.compactionRequested = false;
			ctx.ui.notify(`Local Qwen compaction failed: ${error.message}`, "warning");
		},
	});
}

async function enforceLocalProvider(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): Promise<boolean> {
	const requiredProvider = requiredLocalProvider(ctx, state.localOnly);
	if (!requiredProvider) {
		enforceLocalThinkingProfile(pi, state, ctx);
		return true;
	}
	if (state.enforcingModel) return false;

	state.enforcingModel = true;
	try {
		const selection =
			requiredProvider === "qwen38-subagent"
				? DEFAULT_LOCAL_SUBAGENT_MODEL
				: DEFAULT_LOCAL_MODEL;
		const selected = await selectLocalModel(pi, state, selection, ctx);
		if (!selected) ctx.abort();
		if (selected) enforceLocalThinkingProfile(pi, state, ctx);
		return selected;
	} finally {
		state.enforcingModel = false;
	}
}

async function cycleLocalModel(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
	direction: "forward" | "backward",
): Promise<void> {
	if (state.cycling) return;
	state.cycling = true;
	try {
		const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
		const currentIndex = LOCAL_MODELS.findIndex((model) => modelKey(model) === currentKey);
		const step = direction === "forward" ? 1 : -1;
		const nextIndex = (Math.max(currentIndex, 0) + step + LOCAL_MODELS.length) % LOCAL_MODELS.length;
		const selection = LOCAL_MODELS[nextIndex];
		if (selection && (await selectLocalModel(pi, state, selection, ctx))) {
			ctx.ui.notify(`Local model: ${modelKey(selection)}`, "info");
			updateUi(state, ctx);
		}
	} finally {
		state.cycling = false;
	}
}

export function normalizeLocalModelCycleInput(data: string): string {
	return data === LEGACY_ALT_TAB ? KITTY_ALT_TAB : data;
}

function installLocalCycleEditor(pi: ExtensionAPI, state: LocalModeState, ctx: ExtensionContext): void {
	if (state.localCycleEditorInstalled) return;

	const previousFactory = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = previousFactory
			? previousFactory(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);
		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			const normalizedData = normalizeLocalModelCycleInput(data);
			if (state.enabled && keybindings.matches(normalizedData, "app.model.cycleForward")) {
				void cycleLocalModel(pi, state, ctx, "forward");
				return;
			}
			if (state.enabled && keybindings.matches(normalizedData, "app.model.cycleBackward")) {
				void cycleLocalModel(pi, state, ctx, "backward");
				return;
			}
			handleInput(normalizedData);
		};
		return editor;
	});
	state.localCycleEditorInstalled = true;
}

function applyLocalTheme(state: LocalModeState, ctx: ExtensionContext): void {
	if (!state.enabled) return;
	const greenTheme = ctx.ui.getTheme(GREEN_THEME_NAME);
	if (greenTheme) ctx.ui.setTheme(greenTheme);
}

async function showLocalModelSelector(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): Promise<void> {
	const currentKey = ctx.model ? modelKey(ctx.model) : undefined;
	const options = LOCAL_MODELS.map((model) =>
		modelKey(model) === currentKey ? `${model.label} (active)` : model.label,
	);
	const choice = await ctx.ui.select("Choose a local model", options);
	if (!choice) return;

	const selection = LOCAL_MODELS[options.indexOf(choice)];
	if (!selection) return;

	if (await selectLocalModel(pi, state, selection, ctx)) {
		ctx.ui.notify(`Local model: ${modelKey(selection)}`, "info");
		updateUi(state, ctx);
	}
}

async function activateLocalMode(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): Promise<boolean> {
	if (state.enabled) return true;

	state.previousModel = ctx.model;
	state.previousThinkingLevel = pi.getThinkingLevel();
	state.previousTheme = ctx.ui.theme;
	if (!(await selectLocalModel(pi, state, DEFAULT_LOCAL_MODEL, ctx))) {
		resetState(state);
		return false;
	}

	state.enabled = true;
	state.localOnly = true;
	getProcessLocalProviderPolicy().enabled = true;
	installLocalCycleEditor(pi, state, ctx);
	applyLocalTheme(state, ctx);
	updateUi(state, ctx);
	ctx.ui.notify("Local mode enabled. Use /local model to switch local models.", "info");
	return true;
}

async function enableLocalMode(pi: ExtensionAPI, state: LocalModeState, ctx: ExtensionContext): Promise<void> {
	if (state.enabled) return;
	if (await activateLocalMode(pi, state, ctx)) {
		persistLocalModeState(pi, state);
	}
}

async function disableLocalMode(pi: ExtensionAPI, state: LocalModeState, ctx: ExtensionContext): Promise<void> {
	if (!state.enabled) return;

	state.enabled = false;
	state.localOnly = false;
	getProcessLocalProviderPolicy().enabled = false;
	if (state.previousModel && !(await pi.setModel(state.previousModel))) {
		ctx.ui.notify(`Could not restore model: ${modelKey(state.previousModel)}`, "warning");
	}
	if (state.previousThinkingLevel) {
		pi.setThinkingLevel(state.previousThinkingLevel);
	}
	if (state.previousTheme) {
		ctx.ui.setTheme(state.previousTheme);
	}
	await ensureNonLocalModel(pi, ctx);
	persistLocalModeState(pi, state);
	resetState(state);
	updateUi(state, ctx);
	ctx.ui.notify("Local mode disabled. Previous model and theme restored.", "info");
}

async function enableAutomaticLocalMode(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): Promise<void> {
	if (!state.enabled) await enableLocalMode(pi, state, ctx);
	if (!state.enabled) return;

	state.automaticThinking = true;
	state.automaticThinkingLevel = "medium";
	state.deepReasoningRequested = false;
	setThinkingLevelAutomatically(pi, state, "medium");
	persistLocalModeState(pi, state);
	enforceLocalThinkingProfile(pi, state, ctx);
	ctx.ui.notify("Local mode enabled with automatic medium reasoning.", "info");
}

async function handleLocalCommand(
	pi: ExtensionAPI,
	state: LocalModeState,
	args: string,
	ctx: ExtensionContext,
): Promise<void> {
	const action = args.trim().toLowerCase();
	if (action === "model" || action === "models") {
		if (!state.enabled) await enableLocalMode(pi, state, ctx);
		if (state.enabled) await showLocalModelSelector(pi, state, ctx);
		return;
	}
	if (action === "on") {
		await enableAutomaticLocalMode(pi, state, ctx);
		return;
	}
	if (action === "off") {
		await disableLocalMode(pi, state, ctx);
		return;
	}
	if (action === "auto") {
		await enableAutomaticLocalMode(pi, state, ctx);
		return;
	}
	if (action === "subagent-27b on" || action === "subagent-27b off") {
		if (!state.enabled) await enableLocalMode(pi, state, ctx);
		if (!state.enabled) return;
		state.qwen38SubagentEnabled = action.endsWith("on");
		persistLocalModeState(pi, state);
		updateUi(state, ctx);
		ctx.ui.notify(
			state.qwen38SubagentEnabled
				? "27B subagent lane enabled."
				: "27B subagent lane disabled. The main model and 9B Explore remain available.",
			"info",
		);
		return;
	}
	if (action) {
		ctx.ui.notify("Usage: /local [on|off|model|auto|subagent-27b on|subagent-27b off]", "warning");
		return;
	}

	await enableAutomaticLocalMode(pi, state, ctx);
}

export default function localModeExtension(
	pi: ExtensionAPI,
	clock: MonotonicClock = monotonicNow,
): void {
	for (const provider of ["qwen38-main", "qwen38-subagent", "qwopus-subagent"]) {
		pi.registerProvider(provider, {
			api: "openai-completions",
			streamSimple: createRepetitionRetryStream,
		});
	}

	const state: LocalModeState = {
		enabled: false,
		localOnly: false,
		enforcingModel: false,
		enforcingThinking: false,
		cycling: false,
		automaticThinking: true,
		automaticThinkingLevel: "medium",
		pendingAutomaticThinkingLevel: undefined,
		deepReasoningRequested: false,
		qwen38SubagentEnabled: true,
		compactionRequested: false,
		localCycleEditorInstalled: false,
		autoCompactPolicy: createAutoCompactPolicyClient(pi.events),
	};

	pi.on("resources_discover", (_event, ctx) => {
		setTimeout(() => applyLocalTheme(state, ctx), 0);
		return { themePaths: [GREEN_THEME_PATH] };
	});

	pi.registerTool({
		name: "request_deeper_reasoning",
		label: "Request Deeper Reasoning",
		description:
			"Request one xhigh-reasoning response after inspecting the task and relevant code.",
		promptSnippet:
			"Request xhigh reasoning once when inspected evidence shows it would materially improve correctness.",
		promptGuidelines: [
			"Use request_deeper_reasoning only after inspecting the task and relevant code; provide concise evidence of why extra reasoning materially improves correctness. Do not use it for routine edits, tool retries, or generic uncertainty.",
		],
		parameters: Type.Object({
			reason: Type.String({
				description: "Concise, code-specific reason deeper reasoning is needed.",
			}),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			if (!canRequestLocalQwenDeepReasoning(ctx, state.localOnly, state.automaticThinking)) {
				return {
					content: [{ type: "text", text: "Deeper reasoning is available only in automatic local Qwen mode." }],
					details: { applied: false, reason: "unavailable" },
				};
			}
			if (state.deepReasoningRequested) {
				return {
					content: [{ type: "text", text: "Deeper reasoning was already requested for this task." }],
					details: { applied: false, reason: "already-requested" },
				};
			}

			state.deepReasoningRequested = true;
			state.automaticThinkingLevel = "xhigh";
			applyAutomaticThinkingLevel(pi, state, ctx);
			enforceLocalThinkingProfile(pi, state, ctx);
			ctx.ui.notify("Local Qwen will use xhigh reasoning for the next response.", "info");
			return {
				content: [{ type: "text", text: `Deeper reasoning enabled for this task: ${params.reason}` }],
				details: { applied: true, reason: params.reason },
			};
		},
	});

	pi.registerCommand("local", {
		description: "Manage local mode, models, and the 27B subagent lane",
		handler: async (args, ctx) => handleLocalCommand(pi, state, args, ctx),
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "Agent") {
			const input = event.input as AgentInvocationInput;
			routeLocalExploreAgent(input, state.localOnly);
			if (
				!state.qwen38SubagentEnabled &&
				wouldRouteToLocalQwenSubagent(input, state.localOnly)
			) {
				return {
					block: true,
					reason:
						"The local 27B subagent lane is disabled. Use Explore (the local 9B lane) or run /local subagent-27b on.",
				};
			}
			return;
		}
		if (event.toolName !== "get_subagent_result" || !state.localOnly) return;

		const input = event.input as SubagentResultInput;
		if (!input.wait) return;
		input.wait = false;
		ctx.ui.notify(
			"Local mode kept the subagent result request non-blocking; continue independent work until completion.",
			"info",
		);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await enforceLocalProvider(pi, state, ctx))) return;
		requestAutoCompactPolicy(state, ctx);
		if (state.automaticThinking && ctx.model?.id === "qwen3.8-27b") {
			state.automaticThinkingLevel = "medium";
			state.deepReasoningRequested = false;
			applyAutomaticThinkingLevel(pi, state, ctx);
			enforceLocalThinkingProfile(pi, state, ctx);
		}
		if (!state.enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildLocalInstructions(ctx.model, state.qwen38SubagentEnabled)}`,
		};
	});

	pi.on("model_select", async (_event, ctx) => {
		state.autoCompactPolicy.clear();
		if (!(await enforceLocalProvider(pi, state, ctx))) return;
		requestAutoCompactPolicy(state, ctx);
		if (!state.enabled) return;
		state.generationStartedAt = undefined;
		state.tokensPerSecond = undefined;
		updateUi(state, ctx);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		const automaticChange =
			state.pendingAutomaticThinkingLevel === event.level;
		if (automaticChange) {
			state.pendingAutomaticThinkingLevel = undefined;
		} else if (
			!state.enforcingThinking &&
			state.localOnly &&
			ctx.model?.id === "qwen3.8-27b"
		) {
			state.automaticThinking = false;
			persistLocalModeState(pi, state);
		}
		enforceLocalThinkingProfile(pi, state, ctx);
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!(await enforceLocalProvider(pi, state, ctx))) return;
		requestAutoCompactPolicy(state, ctx);
		applyAutomaticThinkingLevel(pi, state, ctx);
		enforceLocalThinkingProfile(pi, state, ctx);
		if (!state.enabled) return;
		state.generationStartedAt = clock();
		state.tokensPerSecond = undefined;
		updateLocalStatus(state, ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (state.automaticThinking && state.localOnly && ctx.model?.id === "qwen3.8-27b") {
			state.automaticThinkingLevel = "medium";
			state.deepReasoningRequested = false;
			applyAutomaticThinkingLevel(pi, state, ctx);
		}
		const profile = enforceLocalThinkingProfile(pi, state, ctx);
		requestCompactionIfNeeded(pi, state, ctx, profile);
	});

	pi.on("before_provider_headers", (_event, ctx) => {
		if (
			!state.localOnly ||
			(ctx.model && LOCAL_PROVIDER_NAMES.has(ctx.model.provider))
		) {
			return;
		}
		ctx.abort();
		throw new Error("Local mode blocked a non-local provider request");
	});

	pi.on("before_provider_request", (event, ctx) => {
		requestAutoCompactPolicy(state, ctx);
		if (
			!state.localOnly ||
			ctx.model?.id !== "qwen3.8-27b" ||
			(ctx.model.provider !== "qwen38-main" &&
				ctx.model.provider !== "qwen38-subagent")
		) {
			return;
		}
		applyAutomaticThinkingLevel(pi, state, ctx);
		const profile = enforceLocalThinkingProfile(pi, state, ctx);
		if (!profile || !event.payload) return;

		return buildLocalQwenRequestPayload(
			event.payload as LocalQwenRequestPayload,
			profile,
		);
	});

	pi.on("message_update", (event, ctx) => {
		if (!state.enabled || event.message.role !== "assistant") return;
		updateTokensPerSecond(state, ctx, event.message.usage.output, clock);
	});

	pi.on("message_end", (event, ctx) => {
		if (!state.enabled || event.message.role !== "assistant") return;
		updateTokensPerSecond(state, ctx, event.message.usage.output, clock);
	});

	pi.on("session_compact", () => {
		state.compactionRequested = false;
		state.activeProfile = undefined;
	});

	pi.on("session_compact_failed", () => {
		state.compactionRequested = false;
	});

	pi.on("session_shutdown", () => {
		state.autoCompactPolicy.stop();
	});

	pi.on("session_start", async (_event, ctx) => {
		state.autoCompactPolicy.start();
		resetState(state);
		requestAutoCompactPolicy(state, ctx);
		if (isSubagentSession(ctx)) {
			state.localOnly = getProcessLocalProviderPolicy().enabled;
			if (state.localOnly) await enforceLocalProvider(pi, state, ctx);
			if (
				state.localOnly ||
				shouldPreserveExplicitLocalSubagentModel(ctx)
			) {
				updateUi(state, ctx);
				return;
			}
			updateUi(state, ctx);
			return;
		}

		getProcessLocalProviderPolicy().enabled = false;
		const persistedState = getPersistedLocalModeState(ctx);
		if (persistedState?.enabled === true) {
			await activateLocalMode(pi, state, ctx);
			state.qwen38SubagentEnabled = persistedState.qwen38SubagentEnabled !== false;
			if (
				persistedState?.automaticThinking === false &&
				persistedState.thinkingLevel
			) {
				state.automaticThinking = false;
				pi.setThinkingLevel(persistedState.thinkingLevel);
				enforceLocalThinkingProfile(pi, state, ctx);
			}
		} else {
			await ensureNonLocalModel(pi, ctx);
			updateUi(state, ctx);
		}
	});
}
