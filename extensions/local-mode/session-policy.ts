const LOCAL_SUBAGENT_PROVIDERS = new Set([
	"qwen38-subagent",
	"qwopus-subagent",
]);
const PROCESS_POLICY_KEY = Symbol.for("pi.local-mode.provider-policy");
export const LOCAL_EXPLORE_AGENT_TYPE = "LocalExplore";
export const LOCAL_EXPLORE_MODEL = "qwopus-subagent/qwopus3.5-9b-coder-mtp";

export interface AgentInvocationInput {
	subagent_type?: string;
	model?: string;
	thinking?: string;
}

export interface ProcessLocalProviderPolicy {
	enabled: boolean;
}

export type LocalQwenThinkingLevel = "low" | "medium" | "xhigh";
export type LocalQwenProvider = "qwen38-main" | "qwen38-subagent";

export interface LocalQwenProfile {
	thinkingLevel: LocalQwenThinkingLevel;
	thinkingBudget: number;
	maxTokens: number;
	contextWindow: number;
	requiresCompaction: boolean;
}

export interface LocalQwenRequestPayload {
	chat_template_kwargs?: object;
}

interface LocalQwenProfileLimits {
	thinkingBudget: number;
	maxTokens: number;
}

const MAIN_CONTEXT_WINDOW = 240_000;
const SUBAGENT_CONTEXT_WINDOW = 96_000;
const MAIN_COMPACTION_THRESHOLD = 175_000;
const SUBAGENT_COMPACTION_THRESHOLD = 72_000;
const CONTEXT_SAFETY_RESERVE = 8_192;
const MIN_FINAL_ANSWER_TOKENS = 4_096;
const MIN_USEFUL_GENERATION_TOKENS = 8_192;

const FIXED_LOCAL_QWEN_PROFILES = {
	low: { thinkingBudget: 4_096, maxTokens: 12_288 },
	medium: { thinkingBudget: 8_192, maxTokens: 20_480 },
} satisfies Record<"low" | "medium", LocalQwenProfileLimits>;

function normalizeLocalQwenThinkingLevel(level: string): LocalQwenThinkingLevel {
	return level === "low" || level === "xhigh" ? level : "medium";
}

function xhighProfileLimits(
	provider: LocalQwenProvider,
	contextTokens: number,
): LocalQwenProfileLimits {
	if (provider === "qwen38-subagent") {
		if (contextTokens < 32_000) return { thinkingBudget: 32_768, maxTokens: 49_152 };
		if (contextTokens < 56_000) return { thinkingBudget: 24_576, maxTokens: 32_768 };
		if (contextTokens < SUBAGENT_COMPACTION_THRESHOLD) {
			return { thinkingBudget: 16_384, maxTokens: 24_576 };
		}
		return { thinkingBudget: 24_576, maxTokens: 32_768 };
	}

	if (contextTokens < 100_000) return { thinkingBudget: 65_536, maxTokens: 98_304 };
	if (contextTokens < 140_000) return { thinkingBudget: 49_152, maxTokens: 65_536 };
	if (contextTokens < MAIN_COMPACTION_THRESHOLD) {
		return { thinkingBudget: 32_768, maxTokens: 49_152 };
	}
	return { thinkingBudget: 49_152, maxTokens: 65_536 };
}

export function buildLocalQwenRequestPayload<T extends LocalQwenRequestPayload>(
	payload: T,
	profile: LocalQwenProfile,
): T & {
	reasoning_effort: LocalQwenThinkingLevel;
	thinking_token_budget: number;
	max_tokens: number;
	chat_template_kwargs: object;
} {
	const maxTokens = Math.max(1_024, profile.maxTokens);
	const thinkingBudget = Math.min(
		profile.thinkingBudget,
		Math.max(0, maxTokens - 1_024),
	);

	return {
		...payload,
		reasoning_effort: profile.thinkingLevel,
		thinking_token_budget: thinkingBudget,
		max_tokens: maxTokens,
		chat_template_kwargs: {
			...(payload.chat_template_kwargs ?? {}),
			enable_thinking: true,
			preserve_thinking: true,
		},
	};
}

interface SessionHeader {
	parentSession?: string;
}

export interface LocalSessionContext {
	model?: { provider: string; id?: string };
	sessionManager: {
		getHeader(): SessionHeader | undefined;
		getSessionName?(): string | undefined;
	};
}

export function getProcessLocalProviderPolicy(): ProcessLocalProviderPolicy {
	const processGlobals = globalThis as typeof globalThis & {
		[PROCESS_POLICY_KEY]?: ProcessLocalProviderPolicy;
	};
	return (processGlobals[PROCESS_POLICY_KEY] ??= { enabled: false });
}

/** Route the cloud-pinned built-in Explore profile to its local 9B equivalent. */
export function wouldRouteToLocalQwenSubagent(
	input: AgentInvocationInput,
	localOnly: boolean,
): boolean {
	return Boolean(
		localOnly && !input.model?.startsWith("qwopus-subagent/"),
	);
}

export function routeLocalExploreAgent(
	input: AgentInvocationInput,
	localOnly: boolean,
): boolean {
	if (
		!localOnly ||
		input.subagent_type?.toLowerCase() !== "explore"
	) {
		return false;
	}

	input.subagent_type = LOCAL_EXPLORE_AGENT_TYPE;
	input.model = LOCAL_EXPLORE_MODEL;
	input.thinking = "medium";
	return true;
}

export function isSubagentSession(ctx: LocalSessionContext): boolean {
	const parentSession = ctx.sessionManager.getHeader()?.parentSession;
	const sessionName = ctx.sessionManager.getSessionName?.();
	return Boolean(parentSession && sessionName && /#[0-9a-f]{8}$/i.test(sessionName));
}

export function canRequestLocalQwenDeepReasoning(
	ctx: LocalSessionContext,
	localOnly: boolean,
	automaticThinking: boolean,
): boolean {
	return Boolean(
		localOnly &&
			automaticThinking &&
			ctx.model?.id === "qwen3.8-27b" &&
			(ctx.model.provider === "qwen38-main" ||
				ctx.model.provider === "qwen38-subagent"),
	);
}

export function localQwenProfile(
	ctx: LocalSessionContext,
	localOnly: boolean,
	requestedLevel: string,
	contextTokens = 0,
): LocalQwenProfile | undefined {
	if (
		!localOnly ||
		ctx.model?.id !== "qwen3.8-27b" ||
		(ctx.model.provider !== "qwen38-main" &&
			ctx.model.provider !== "qwen38-subagent")
	) {
		return undefined;
	}

	const provider = ctx.model.provider;
	const thinkingLevel = normalizeLocalQwenThinkingLevel(requestedLevel);
	const normalizedContextTokens = Math.max(0, Math.floor(contextTokens));
	const contextWindow =
		provider === "qwen38-main" ? MAIN_CONTEXT_WINDOW : SUBAGENT_CONTEXT_WINDOW;
	const compactionThreshold =
		provider === "qwen38-main"
			? MAIN_COMPACTION_THRESHOLD
			: SUBAGENT_COMPACTION_THRESHOLD;
	const desired =
		thinkingLevel === "xhigh"
			? xhighProfileLimits(provider, normalizedContextTokens)
			: FIXED_LOCAL_QWEN_PROFILES[thinkingLevel];
	const availableGenerationTokens = Math.max(
		0,
		contextWindow - normalizedContextTokens - CONTEXT_SAFETY_RESERVE,
	);
	const maxTokens = Math.min(desired.maxTokens, availableGenerationTokens);
	const thinkingBudget = Math.min(
		desired.thinkingBudget,
		Math.max(0, maxTokens - MIN_FINAL_ANSWER_TOKENS),
	);

	return {
		thinkingLevel,
		thinkingBudget,
		maxTokens,
		contextWindow,
		requiresCompaction:
			normalizedContextTokens >= compactionThreshold ||
			maxTokens < MIN_USEFUL_GENERATION_TOKENS,
	};
}

export function requiredLocalProvider(
	ctx: LocalSessionContext,
	localOnly: boolean,
): "qwen38-main" | "qwen38-subagent" | undefined {
	if (!localOnly || LOCAL_SUBAGENT_PROVIDERS.has(ctx.model?.provider ?? "")) {
		return undefined;
	}
	if (ctx.model?.provider === "qwen38-main") return undefined;
	return isSubagentSession(ctx) ? "qwen38-subagent" : "qwen38-main";
}

/**
 * Child sessions created for explicitly selected local subagent providers must
 * keep that model. Local-mode state belongs to the parent session and is not
 * copied into the child, so applying top-level restoration there would reroute
 * the child before its first provider request.
 */
export function shouldPreserveExplicitLocalSubagentModel(
	ctx: LocalSessionContext,
): boolean {
	return Boolean(
		isSubagentSession(ctx) &&
			ctx.model &&
			LOCAL_SUBAGENT_PROVIDERS.has(ctx.model.provider),
	);
}
