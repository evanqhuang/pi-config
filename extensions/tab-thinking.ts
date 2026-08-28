import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { matchesKey } from "@earendil-works/pi-tui";

type TabThinkingState = {
	cycle: (() => void) | undefined;
	originalHandleInput: CustomEditor["handleInput"];
	hookVersion?: number;
};

type TabThinkingPrototype = typeof CustomEditor.prototype & {
	__hostelhawkTabThinkingState?: TabThinkingState;
};

const HOOK_VERSION = 2;
const LEGACY_ALT_TAB = "\x1b\t";
const KITTY_ALT_TAB = "\x1b[9;3u";

export function normalizeTerminalInput(data: string): string {
	return data === LEGACY_ALT_TAB ? KITTY_ALT_TAB : data;
}

function installTabThinkingHook(): TabThinkingState {
	const prototype = CustomEditor.prototype as TabThinkingPrototype;
	const existingState = prototype.__hostelhawkTabThinkingState;
	if (existingState?.hookVersion === HOOK_VERSION) {
		return existingState;
	}

	const state: TabThinkingState = existingState ?? {
		cycle: undefined,
		originalHandleInput: prototype.handleInput,
	};
	state.hookVersion = HOOK_VERSION;
	prototype.__hostelhawkTabThinkingState = state;
	prototype.handleInput = function (this: CustomEditor, data: string): void {
		const normalizedData = normalizeTerminalInput(data);
		if (state.cycle && matchesKey(normalizedData, "tab") && this.getText().trim().length === 0) {
			state.cycle();
			return;
		}

		state.originalHandleInput.call(this, normalizedData);
	};

	return state;
}

export default function (pi: ExtensionAPI) {
	const state = installTabThinkingHook();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") {
			state.cycle = undefined;
			return;
		}

		state.cycle = () => {
			const model = ctx.model;
			if (!model?.reasoning) {
				ctx.ui.notify("This model does not support thinking levels.", "info");
				return;
			}

			const levels = getSupportedThinkingLevels(model);
			const currentIndex = levels.indexOf(pi.getThinkingLevel());
			const nextLevel = levels[(currentIndex + 1) % levels.length];
			if (nextLevel) pi.setThinkingLevel(nextLevel);
		};
	});

	pi.on("session_shutdown", () => {
		state.cycle = undefined;
	});
}
