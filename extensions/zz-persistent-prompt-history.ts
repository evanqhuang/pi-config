import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	parseSkillBlock,
	SessionManager,
	type ExtensionAPI,
	type KeybindingsManager,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";

const HISTORY_VERSION = 1;
const HISTORY_FILE = join(getAgentDir(), "prompt-history.jsonl");

type HistoryRecord = {
	timestamp: number;
	text: string;
	sessionFile?: string;
};

type HistoryFileLine =
	| { type: "meta"; version: number }
	| ({ type: "prompt" } & HistoryRecord);

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const textParts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string"
		) {
			textParts.push((block as { text: string }).text);
		}
	}
	return textParts.join("");
}

function normalizeText(text: string): string {
	return text.trim();
}

function toHistoryText(text: string): string {
	const normalized = normalizeText(text);
	if (!normalized) return "";

	const skillBlock = parseSkillBlock(normalized);
	if (!skillBlock) return normalized;
	return normalizeText(skillBlock.userMessage ?? `/${skillBlock.name}`);
}

function getUserEntryText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;

	const text = toHistoryText(extractText(entry.message.content));
	return text || undefined;
}

function parseCachedHistory(): { initialized: boolean; records: HistoryRecord[] } {
	try {
		const content = readFileSync(HISTORY_FILE, "utf8");
		const records: HistoryRecord[] = [];
		let initialized = false;

		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as Partial<HistoryFileLine>;
				if (parsed.type === "meta" && parsed.version === HISTORY_VERSION) {
					initialized = true;
					continue;
				}
				if (
					parsed.type !== "prompt" ||
					typeof parsed.text !== "string" ||
					typeof parsed.timestamp !== "number"
				) {
					continue;
				}
				const text = toHistoryText(parsed.text);
				if (!text) continue;
				records.push({
					timestamp: parsed.timestamp,
					text,
					sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
				});
			} catch {
				// Ignore an incomplete or malformed line; other history remains usable.
			}
		}

		return { initialized: initialized || records.length > 0, records };
	} catch {
		return { initialized: false, records: [] };
	}
}

function serializeHistory(records: HistoryRecord[]): string {
	const lines: HistoryFileLine[] = [
		{ type: "meta", version: HISTORY_VERSION },
		...records.map((record) => ({ type: "prompt" as const, ...record })),
	];
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function bootstrapHistory(): Promise<HistoryRecord[]> {
	let sessions;
	try {
		sessions = await SessionManager.listAll();
	} catch {
		return [];
	}

	const records: HistoryRecord[] = [];
	for (const session of sessions) {
		try {
			const manager = SessionManager.open(session.path);
			for (const entry of manager.getEntries()) {
				const text = getUserEntryText(entry);
				if (!text) continue;

				const message = entry.type === "message" ? (entry.message as { timestamp?: unknown }) : undefined;
				const messageTimestamp = typeof message?.timestamp === "number" ? message.timestamp : undefined;
				const entryTimestamp = Date.parse(entry.timestamp);
				records.push({
					timestamp: messageTimestamp ?? (Number.isNaN(entryTimestamp) ? Date.now() : entryTimestamp),
					text,
					sessionFile: session.path,
				});
			}
		} catch {
			// One unreadable session should not prevent the rest of history loading.
		}
	}

	records.sort((a, b) => a.timestamp - b.timestamp);
	return records;
}

async function loadHistory(): Promise<HistoryRecord[]> {
	const cached = parseCachedHistory();
	if (cached.initialized) return cached.records;

	const bootstrapped = await bootstrapHistory();
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(HISTORY_FILE, serializeHistory(bootstrapped), { encoding: "utf8", flag: "wx" });
		return bootstrapped;
	} catch {
		// Another pi process may have initialized the file while we scanned sessions.
		const afterRace = parseCachedHistory();
		return afterRace.initialized ? afterRace.records : bootstrapped;
	}
}

function countPrompts(entries: SessionEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const text = getUserEntryText(entry);
		if (!text) continue;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	return counts;
}

function newestFirst<T>(items: readonly T[]): T[] {
	const result: T[] = [];
	for (let index = items.length - 1; index >= 0; index--) {
		result.push(items[index]);
	}
	return result;
}

type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

type HistoryEditorOptions = {
	existingFactory: EditorFactory | undefined;
	tui: TUI;
	theme: EditorTheme;
	keybindings: KeybindingsManager;
	history: readonly string[];
	initialPrompts: Map<string, number>;
	remember: (text: string) => void;
};

type HistoryState = {
	entries: string[];
	index: number;
	draft?: string;
};

type EditorWithAutocomplete = EditorComponent & {
	isShowingAutocomplete?: () => boolean;
	isOnFirstVisualLine?: () => boolean;
	isOnLastVisualLine?: () => boolean;
};

function createHistoryState(history: readonly string[]): HistoryState {
	const entries: string[] = [];
	for (const text of history) {
		if (entries.at(-1) !== text) entries.push(text);
	}
	return { entries, index: -1 };
}

function addHistoryEntry(state: HistoryState, text: string): void {
	if (state.entries[0] !== text) state.entries.unshift(text);
}

function resetHistoryBrowsing(state: HistoryState): void {
	state.index = -1;
	state.draft = undefined;
}

function installHistoryNavigation(
	editor: EditorComponent,
	keybindings: KeybindingsManager,
	state: HistoryState,
): void {
	const originalHandleInput = editor.handleInput.bind(editor);
	const originalSetText = editor.setText.bind(editor);
	const editorWithNavigation = editor as EditorWithAutocomplete;

	const navigateHistory = (direction: -1 | 1): void => {
		const nextIndex = state.index - direction;
		if (nextIndex < -1 || nextIndex >= state.entries.length) return;

		if (state.index === -1 && nextIndex >= 0) {
			state.draft = editor.getText();
		}
		state.index = nextIndex;
		originalSetText(nextIndex === -1 ? (state.draft ?? "") : state.entries[nextIndex]);
	};

	editor.setText = (text: string): void => {
		originalSetText(text);
		resetHistoryBrowsing(state);
	};

	editor.handleInput = (data: string): void => {
		const autocompleteVisible = editorWithNavigation.isShowingAutocomplete?.() ?? false;
		const cursorUp = keybindings.matches(data, "tui.editor.cursorUp");
		const cursorDown = keybindings.matches(data, "tui.editor.cursorDown");
		const atFirstVisualLine = editorWithNavigation.isOnFirstVisualLine?.() ?? true;
		const atLastVisualLine = editorWithNavigation.isOnLastVisualLine?.() ?? true;

		if (
			!autocompleteVisible &&
			(keybindings.matches(data, "tui.editor.historyPrevious") || (cursorUp && atFirstVisualLine))
		) {
			navigateHistory(-1);
			return;
		}
		if (
			!autocompleteVisible &&
			(keybindings.matches(data, "tui.editor.historyNext") || (cursorDown && atLastVisualLine))
		) {
			navigateHistory(1);
			return;
		}
		originalHandleInput(data);
	};
}

function installHistoryRecording(
	editor: EditorComponent,
	state: HistoryState,
	initialPrompts: Map<string, number>,
	remember: (text: string) => void,
): void {
	const originalAddToHistory = editor.addToHistory?.bind(editor);
	const initialPromptCounts = new Map(initialPrompts);

	editor.addToHistory = (text: string): void => {
		const normalized = toHistoryText(text);
		if (!normalized) return;

		const initialCount = initialPromptCounts.get(normalized) ?? 0;
		if (initialCount > 0) {
			if (initialCount === 1) initialPromptCounts.delete(normalized);
			else initialPromptCounts.set(normalized, initialCount - 1);
			addHistoryEntry(state, normalized);
			originalAddToHistory?.(normalized);
			return;
		}

		remember(normalized);
		addHistoryEntry(state, normalized);
		resetHistoryBrowsing(state);
		originalAddToHistory?.(normalized);
	};
}

export function createHistoryEditor({
	existingFactory,
	tui,
	theme,
	keybindings,
	history,
	initialPrompts,
	remember,
}: HistoryEditorOptions): EditorComponent {
	const editor = existingFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
	const state = createHistoryState(history);
	installHistoryNavigation(editor, keybindings, state);
	installHistoryRecording(editor, state, initialPrompts, remember);
	return editor;
}

export default async function persistentPromptHistory(pi: ExtensionAPI): Promise<void> {
	let records = await loadHistory();

	const remember = (text: string, sessionFile?: string, timestamp = Date.now()): void => {
		const normalized = toHistoryText(text);
		if (!normalized) return;

		const previous = records.at(-1);
		if (previous?.text === normalized) return;

		const record: HistoryRecord = { timestamp, text: normalized, sessionFile };
		records.push(record);
		try {
			mkdirSync(getAgentDir(), { recursive: true });
			appendFileSync(HISTORY_FILE, `${JSON.stringify({ type: "prompt", ...record })}\n`, "utf8");
		} catch {
			// History is best-effort and must never interrupt a session.
		}
	};

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "user") return;
		const text = normalizeText(extractText(event.message.content));
		if (!text || parseSkillBlock(text)) return;

		const timestamp = typeof event.message.timestamp === "number" ? event.message.timestamp : Date.now();
		remember(text, ctx.sessionManager.getSessionFile(), timestamp);
	});

	pi.on("resources_discover", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const history = newestFirst(records).map((record) => record.text);
		const initialPrompts = countPrompts(ctx.sessionManager.buildContextEntries());
		const sessionFile = ctx.sessionManager.getSessionFile();
		const existingFactory = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			return createHistoryEditor({
				existingFactory,
				tui,
				theme,
				keybindings,
				history,
				initialPrompts,
				remember: (text) => remember(text, sessionFile),
			});
		});
	});

	pi.registerCommand("clear", {
		description: "Start a new session (alias for /new)",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /clear", "warning");
				return;
			}
			await ctx.newSession({
				withSession: async (replacementCtx) => {
					if (replacementCtx.hasUI) replacementCtx.ui.notify("✓ New session started", "info");
				},
			});
		},
	});
}
