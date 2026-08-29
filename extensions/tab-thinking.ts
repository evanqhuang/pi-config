import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { matchesKey, type EditorComponent, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

type TabThinkingState = {
	cycle: (() => void) | undefined;
};

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type TabThinkingEditorOptions = {
	existingFactory: EditorFactory | undefined;
	tui: TUI;
	theme: EditorTheme;
	keybindings: KeybindingsManager;
	state: TabThinkingState;
};

const LEGACY_ALT_TAB = "\x1b\t";
const KITTY_ALT_TAB = "\x1b[9;3u";

export function normalizeTerminalInput(data: string): string {
	return data === LEGACY_ALT_TAB ? KITTY_ALT_TAB : data;
}

export function installTabThinkingInputHandler(editor: EditorComponent, state: TabThinkingState): void {
	const originalHandleInput = editor.handleInput.bind(editor);

	editor.handleInput = (data: string): void => {
		const normalizedData = normalizeTerminalInput(data);
		if (matchesKey(normalizedData, "tab") && editor.getText().trim().length === 0) {
			state.cycle?.();
			return;
		}

		originalHandleInput(normalizedData);
	};
}

export function createTabThinkingEditor({
	existingFactory,
	tui,
	theme,
	keybindings,
	state,
}: TabThinkingEditorOptions): EditorComponent {
	const editor = existingFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
	installTabThinkingInputHandler(editor, state);
	return editor;
}

export default function (pi: ExtensionAPI) {
	const state: TabThinkingState = { cycle: undefined };

	pi.on("resources_discover", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const existingFactory = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return createTabThinkingEditor({ existingFactory, tui, theme, keybindings, state });
		});
	});

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
