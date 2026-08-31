import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const packageRoot = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const require = createRequire(`${packageRoot}/package.json`);
const { createJiti } = require("jiti");

function createPiImporter() {
	return createJiti(`${packageRoot}/dist/cli.js`, {
		moduleCache: false,
		alias: {
			"@earendil-works/pi-agent-core": `${packageRoot}/node_modules/@earendil-works/pi-agent-core/dist/index.js`,
			"@earendil-works/pi-ai": `${packageRoot}/node_modules/@earendil-works/pi-ai/dist/index.js`,
			"@earendil-works/pi-ai/compat": `${packageRoot}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-coding-agent": `${packageRoot}/dist/index.js`,
			"@earendil-works/pi-tui": `${packageRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`,
			typebox: `${packageRoot}/node_modules/typebox/build/index.mjs`,
		},
	});
}

function createRegisteredEditor(registerTabThinking) {
	const handlers = new Map();
	const thinkingLevels = [];
	const delegated = [];
	let text = "";
	let factoryCalls = 0;
	const baseEditor = {
		getText: () => text,
		handleInput: (data) => delegated.push(data),
		isVimEditor: true,
	};
	const baseFactory = (...args) => {
		factoryCalls++;
		assert.equal(args.length, 3, "the current editor factory receives Pi's editor arguments");
		return baseEditor;
	};
	let editorFactory = baseFactory;
	const ui = {
		getEditorComponent: () => editorFactory,
		setEditorComponent: (factory) => {
			editorFactory = factory;
		},
		notify: () => {},
	};
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		getThinkingLevel: () => "low",
		setThinkingLevel: (level) => thinkingLevels.push(level),
	};
	const context = { mode: "tui", model: { reasoning: true }, ui };

	registerTabThinking(pi);
	handlers.get("resources_discover")({}, context);
	handlers.get("session_start")({}, context);
	const editor = editorFactory({}, {}, {});

	return {
		editor,
		baseEditor,
		delegated,
		factoryCalls: () => factoryCalls,
		setText: (value) => {
			text = value;
		},
		thinkingLevels,
		shutdown: () => handlers.get("session_shutdown")({}, context),
	};
}

test("the registered factory preserves custom editors and cycles thinking on empty Tab", async () => {
	const jiti = createPiImporter();
	const [
		{ default: registerTabThinking, normalizeTerminalInput },
		{ normalizeLocalModelCycleInput },
		{ matchesKey, parseKey },
	] = await Promise.all([
		jiti.import("/Users/evanhuang/.pi/agent/extensions/tab-thinking.ts"),
		jiti.import("/Users/evanhuang/.pi/agent/extensions/local-mode/index.ts"),
		jiti.import("@earendil-works/pi-tui"),
	]);
	const setup = createRegisteredEditor(registerTabThinking);

	assert.equal(setup.editor, setup.baseEditor, "the active custom editor is wrapped rather than replaced");
	assert.equal(setup.editor.isVimEditor, true, "custom editor behavior remains available");
	assert.equal(setup.factoryCalls(), 1);

	for (const text of ["", " ", "   ", "\n", " \n\t "]) {
		setup.setText(text);
		setup.editor.handleInput("\t");
	}

	setup.setText("prompt");
	setup.editor.handleInput("\t");
	setup.setText(" ");
	setup.editor.handleInput("x");

	const legacyAltTab = "\x1b\t";
	const normalizedAltTab = normalizeTerminalInput(legacyAltTab);
	assert.equal(parseKey(legacyAltTab), "ctrl+alt+i", "documents the upstream legacy parsing bug");
	assert.equal(parseKey(normalizedAltTab), "alt+tab");
	assert.equal(matchesKey(normalizedAltTab, "alt+tab"), true);
	assert.equal(normalizeLocalModelCycleInput(legacyAltTab), normalizedAltTab);
	assert.equal(normalizeLocalModelCycleInput(normalizedAltTab), normalizedAltTab);
	assert.equal(matchesKey(normalizeLocalModelCycleInput(legacyAltTab), "alt+tab"), true);
	setup.setText("");
	setup.editor.handleInput(legacyAltTab);

	assert.deepEqual(setup.thinkingLevels, ["medium", "medium", "medium", "medium", "medium"]);
	assert.deepEqual(setup.delegated, ["\t", "x", normalizedAltTab]);
});

test("empty Tab remains consumed after session shutdown", async () => {
	const jiti = createPiImporter();
	const { default: registerTabThinking } = await jiti.import("/Users/evanhuang/.pi/agent/extensions/tab-thinking.ts");
	const setup = createRegisteredEditor(registerTabThinking);

	setup.shutdown();
	setup.setText("");
	setup.editor.handleInput("\t");

	assert.deepEqual(setup.thinkingLevels, []);
	assert.deepEqual(setup.delegated, []);
});
