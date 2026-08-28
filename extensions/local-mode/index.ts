import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	CustomEditor,
	type EditorFactory,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentInvocationInput,
	buildLocalQwenRequestPayload,
	canRequestLocalQwenDeepReasoning,
	getProcessLocalProviderPolicy,
	isSubagentSession,
	localQwenProfile,
	requiredLocalProvider,
	routeLocalExploreAgent,
	type LocalQwenProfile,
	type LocalQwenRequestPayload,
	shouldPreserveExplicitLocalSubagentModel,
} from "./session-policy.js";

const EXTENSION_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const GREEN_THEME_NAME = "local-green";
const GREEN_THEME_PATH = join(EXTENSION_DIRECTORY, "local-green.json");
const LOCAL_MODE_STATE_ENTRY = "local-mode-state";
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
	previousEditorFactory?: EditorFactory;
	previousModel?: Model<Api>;
	previousThinkingLevel?: ThinkingLevel;
	previousTheme?: Theme;
	automaticThinking: boolean;
	automaticThinkingLevel: ThinkingLevel;
	pendingAutomaticThinkingLevel?: ThinkingLevel;
	deepReasoningRequested: boolean;
	activeProfile?: LocalQwenProfile;
	compactionRequested: boolean;
}

function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function buildLocalInstructions(activeModel: Model<Api> | undefined): string {
	const current = activeModel ? modelKey(activeModel) : "unknown";

	return `[LOCAL MODE ACTIVE]
The current main model is ${current}. Do not change it unless the user asks.

## Local Model Subagent Routing
- Use only the local model providers listed below for delegated work while local mode is active.
- The 27B subagent is qwen38-subagent/qwen3.8-27b with a 96K context limit.
- Qwen3.8 27B supports exactly three reasoning levels: low, medium, and xhigh. Other thinking levels are normalized to medium.
- Automatic routing starts every task at medium. After inspecting the task and relevant code, the model may call request_deeper_reasoning once when extra reasoning would materially improve correctness; the action applies xhigh on the next response. Automatic mode returns to medium after the task settles. A user's explicit thinking-level selection is preserved; /local restores automatic routing.
- The 240K main provider gives xhigh up to 64K thinking/96K total output below 100K context, 48K/64K from 100K, and 32K/48K from 140K; it requests compaction at 175K. Every request is clamped to remaining context with safety and final-answer reserves.
- The 96K 27B subagent uses a smaller xhigh schedule and requests compaction at 72K. Do not apply main-provider budgets to child sessions.
- Do not stop or force synthesis after an arbitrary number of tool turns. Checkpoint or compact based on context pressure, repeated lack of progress, or a real phase transition.
- At most one 27B subagent may run at a time. Explicitly select qwen38-subagent/qwen3.8-27b; do not let it inherit the main model.
- The 9B MTP subagent is qwopus-subagent/qwopus3.5-9b-coder-mtp with a 96K context limit.
- The 9B MTP model is text-only. Never assign it screenshots, image inspection, OCR, or other visual work; route those tasks to qwen38-subagent/qwen3.8-27b.
- Explore subagents are automatically routed to the read-only LocalExplore profile on the 9B MTP model.
- At most one 9B subagent may run at a time. It may run alongside the single 27B subagent when their objectives and file ownership are independent.
- Use the 9B lane proactively for bounded discovery, mechanical edits, focused tests, fixtures, and documentation that do not require architecture, security, data semantics, or broad integration judgment.
- Use the 27B lane for visual work and tasks requiring broader judgment.
- Give each subagent one focused objective, exact paths, explicit model selection, expected output, and a focused verification command.
- Background subagents run in parallel: continue independent work after launching one. Never call get_subagent_result with wait: true or poll a running agent; collect its result only after its completion notification.
- Keep 9B work units to 1-2 implementation files plus a focused test. Keep 27B work units to one subsystem boundary and 3-5 closely related implementation files plus focused tests.
- The main model remains responsible for coordination, review, and final verification.`;
}

function resetState(state: LocalModeState): void {
	state.enabled = false;
	state.localOnly = false;
	state.enforcingModel = false;
	state.enforcingThinking = false;
	state.cycling = false;
	state.generationStartedAt = undefined;
	state.tokensPerSecond = undefined;
	state.previousEditorFactory = undefined;
	state.previousModel = undefined;
	state.previousThinkingLevel = undefined;
	state.previousTheme = undefined;
	state.automaticThinking = true;
	state.automaticThinkingLevel = "medium";
	state.pendingAutomaticThinkingLevel = undefined;
	state.deepReasoningRequested = false;
	state.activeProfile = undefined;
	state.compactionRequested = false;
}

interface PersistedLocalModeState {
	enabled: boolean;
	automaticThinking?: boolean;
	thinkingLevel?: ThinkingLevel;
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
	ctx.ui.setStatus("local-mode", ctx.ui.theme.fg("accent", `● LOCAL${budget}${speed}`));
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

function updateTokensPerSecond(
	state: LocalModeState,
	ctx: ExtensionContext,
	outputTokens: number,
): void {
	const startedAt = state.generationStartedAt;
	if (!startedAt || !Number.isFinite(outputTokens) || outputTokens <= 0) return;

	const elapsedSeconds = (Date.now() - startedAt) / 1000;
	if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return;

	state.tokensPerSecond = outputTokens / elapsedSeconds;
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

function enforceLocalThinkingProfile(
	pi: ExtensionAPI,
	state: LocalModeState,
	ctx: ExtensionContext,
): LocalQwenProfile | undefined {
	const contextTokens = ctx.getContextUsage()?.tokens ?? 0;
	const profile = localQwenProfile(
		ctx,
		state.localOnly,
		pi.getThinkingLevel(),
		contextTokens,
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

function installLocalCycleEditor(pi: ExtensionAPI, state: LocalModeState, ctx: ExtensionContext): void {
	state.previousEditorFactory = ctx.ui.getEditorComponent();
	const previousFactory = state.previousEditorFactory;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = previousFactory
			? previousFactory(tui, theme, keybindings)
			: new CustomEditor(tui, theme, keybindings);
		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			if (keybindings.matches(data, "app.model.cycleForward")) {
				void cycleLocalModel(pi, state, ctx, "forward");
				return;
			}
			if (keybindings.matches(data, "app.model.cycleBackward")) {
				void cycleLocalModel(pi, state, ctx, "backward");
				return;
			}
			handleInput(data);
		};
		return editor;
	});
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
	const greenTheme = ctx.ui.getTheme(GREEN_THEME_NAME);
	if (greenTheme) {
		ctx.ui.setTheme(greenTheme);
	} else {
		ctx.ui.notify("Local mode theme unavailable", "warning");
	}
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
	ctx.ui.setEditorComponent(state.previousEditorFactory);
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
	if (action) {
		ctx.ui.notify("Usage: /local [on|off|model|auto]", "warning");
		return;
	}

	await enableAutomaticLocalMode(pi, state, ctx);
}

export default function localModeExtension(pi: ExtensionAPI): void {
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
		compactionRequested: false,
	};

	pi.on("resources_discover", () => ({ themePaths: [GREEN_THEME_PATH] }));

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
		description: "Enable automatic local mode or choose a local model",
		handler: async (args, ctx) => handleLocalCommand(pi, state, args, ctx),
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === "Agent") {
			routeLocalExploreAgent(event.input as AgentInvocationInput, state.localOnly);
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
		if (state.automaticThinking && ctx.model?.id === "qwen3.8-27b") {
			state.automaticThinkingLevel = "medium";
			state.deepReasoningRequested = false;
			applyAutomaticThinkingLevel(pi, state, ctx);
			enforceLocalThinkingProfile(pi, state, ctx);
		}
		if (!state.enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildLocalInstructions(ctx.model)}`,
		};
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!(await enforceLocalProvider(pi, state, ctx))) return;
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
		applyAutomaticThinkingLevel(pi, state, ctx);
		enforceLocalThinkingProfile(pi, state, ctx);
		if (!state.enabled) return;
		state.generationStartedAt = undefined;
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
		const streamEvent = event.assistantMessageEvent;
		if (
			state.generationStartedAt === undefined &&
			(streamEvent.type === "text_delta" ||
				streamEvent.type === "thinking_delta" ||
				streamEvent.type === "toolcall_delta")
		) {
			state.generationStartedAt = Date.now();
		}
		updateTokensPerSecond(state, ctx, event.message.usage.output);
	});

	pi.on("message_end", (event, ctx) => {
		if (!state.enabled || event.message.role !== "assistant") return;
		updateTokensPerSecond(state, ctx, event.message.usage.output);
	});

	pi.on("session_compact", () => {
		state.compactionRequested = false;
		state.activeProfile = undefined;
	});

	pi.on("session_compact_failed", () => {
		state.compactionRequested = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		resetState(state);
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
		const currentModel = ctx.model;
		const legacyLocalSession =
			persistedState === undefined &&
			currentModel !== undefined &&
			LOCAL_MODELS.some((model) => modelKey(model) === modelKey(currentModel));
		if (persistedState?.enabled === true || legacyLocalSession) {
			await activateLocalMode(pi, state, ctx);
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
