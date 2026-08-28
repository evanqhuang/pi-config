import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ModelSelectEvent,
	type SessionStartEvent,
	type ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

type ModelLike = { provider: string; id: string };

type State = {
	settings?: SettingsManager;
	lastModelKey?: string;
	thinkingPreference?: ThinkingLevel;
	suppressThinkingEvent: boolean;
};

function modelKey(model: ModelLike | undefined): string | undefined {
	return model ? `${model.provider}\0${model.id}` : undefined;
}

function isRootSession(ctx: ExtensionContext): boolean {
	return ctx.sessionManager.getHeader()?.parentSession === undefined;
}

function hasArg(...names: string[]): boolean {
	const args = process.argv.slice(2);
	return args.some((arg) => names.includes(arg));
}

function hasExplicitStartupChoice(kind: "model" | "thinking"): boolean {
	if (kind === "model") return hasArg("--model");
	return hasArg("--thinking") || hasArg("--model");
}

function isFreshStartup(event: SessionStartEvent, ctx: ExtensionContext): boolean {
	if (!isRootSession(ctx) || (event.reason !== "startup" && event.reason !== "new")) return false;
	if (ctx.sessionManager.buildSessionContext().messages.length > 0) return false;
	// The initial runtime reports "startup" even when --continue/--resume/--fork
	// selected its session before extensions were bound.
	if (event.reason === "startup" && hasArg("--continue", "-c", "--resume", "-r", "--session", "--session-id", "--fork")) {
		return false;
	}
	return true;
}

function settingsFor(state: State, ctx: ExtensionContext): SettingsManager {
	return (state.settings ??= SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: false }));
}

async function persist(state: State, ctx: ExtensionContext, update: (settings: SettingsManager) => void): Promise<void> {
	try {
		const settings = settingsFor(state, ctx);
		update(settings);
		await settings.flush();
	} catch {
		// Preference persistence is best effort and must not interrupt Pi.
	}
}

export default function lastUsedPreferences(pi: ExtensionAPI): void {
	const state: State = { suppressThinkingEvent: false };

	pi.on("session_start", async (event, ctx) => {
		const settings = settingsFor(state, ctx);
		state.thinkingPreference = settings.getDefaultThinkingLevel();
		state.lastModelKey = modelKey(ctx.model);

		if (!isFreshStartup(event, ctx)) return;

		if (!hasExplicitStartupChoice("model")) {
			const provider = settings.getDefaultProvider();
			const id = settings.getDefaultModel();
			if (provider && id) {
				const savedModel = ctx.modelRegistry.find(provider, id);
				if (savedModel) {
					try {
						await pi.setModel(savedModel);
					} catch {
						// An unavailable model leaves the current model in place.
					}
				}
			}
		}

		if (!hasExplicitStartupChoice("thinking")) {
			const level = settings.getDefaultThinkingLevel();
			if (level !== undefined) pi.setThinkingLevel(level);
		}
	});

	pi.on("model_select", async (event: ModelSelectEvent, ctx) => {
		if (!isRootSession(ctx)) return;

		// AgentSession emits its automatic thinking change before model_select. A
		// root model switch must not turn that effective/clamped level into the
		// global preference. Restore the independent preference for the new model;
		// Pi itself clamps it when the model genuinely cannot support it.
		const preference = state.thinkingPreference;
		state.lastModelKey = modelKey(event.model);
		if (preference !== undefined) {
			state.suppressThinkingEvent = true;
			try {
				pi.setThinkingLevel(preference);
			} finally {
				state.suppressThinkingEvent = false;
			}
		}

		await persist(state, ctx, (settings) => settings.setDefaultModelAndProvider(event.model.provider, event.model.id));
	});

	pi.on("thinking_level_select", async (event: ThinkingLevelSelectEvent, ctx) => {
		if (!isRootSession(ctx) || state.suppressThinkingEvent) return;

		// Automatic model-switch clamping is emitted before model_select while
		// ctx.model already points at the new model.
		const currentModelKey = modelKey(ctx.model);
		if (currentModelKey !== state.lastModelKey) {
			state.lastModelKey = currentModelKey;
			return;
		}

		state.thinkingPreference = event.level;
		await persist(state, ctx, (settings) => settings.setDefaultThinkingLevel(event.level));
	});
}
