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
			"@earendil-works/pi-coding-agent": `${packageRoot}/dist/index.js`,
			"@earendil-works/pi-ai/compat": `${packageRoot}/node_modules/@earendil-works/pi-ai/dist/compat.js`,
			"@earendil-works/pi-tui": `${packageRoot}/node_modules/@earendil-works/pi-tui/dist/index.js`,
		},
	});
}

test("plain Tab cycles thinking for empty and whitespace-only editor text", async () => {
	const jiti = createPiImporter();
	const [{ default: registerTabThinking, normalizeTerminalInput }, { CustomEditor }, { matchesKey, parseKey }] = await Promise.all([
		jiti.import("/Users/evanhuang/.pi/agent/extensions/tab-thinking.ts"),
		jiti.import("@earendil-works/pi-coding-agent"),
		jiti.import("@earendil-works/pi-tui"),
	]);

	registerTabThinking({ on() {} });

	const state = CustomEditor.prototype.__hostelhawkTabThinkingState;
	assert.ok(state, "Tab-thinking hook should be installed");

	let cycles = 0;
	const delegated = [];
	state.cycle = () => cycles++;
	state.originalHandleInput = function (data) {
		delegated.push({ data, text: this.getText() });
	};

	for (const text of ["", " ", "   ", "\n", " \n\t "]) {
		CustomEditor.prototype.handleInput.call({ getText: () => text }, "\t");
	}

	CustomEditor.prototype.handleInput.call({ getText: () => "prompt" }, "\t");
	CustomEditor.prototype.handleInput.call({ getText: () => " " }, "x");

	const legacyAltTab = "\x1b\t";
	const normalizedAltTab = normalizeTerminalInput(legacyAltTab);
	assert.equal(parseKey(legacyAltTab), "ctrl+alt+i", "documents the upstream legacy parsing bug");
	assert.equal(parseKey(normalizedAltTab), "alt+tab");
	assert.equal(matchesKey(normalizedAltTab, "alt+tab"), true);
	CustomEditor.prototype.handleInput.call({ getText: () => "" }, legacyAltTab);

	assert.equal(cycles, 5, "Option+Tab must not trigger plain-Tab thinking cycling");
	assert.deepEqual(delegated, [
		{ data: "\t", text: "prompt" },
		{ data: "x", text: " " },
		{ data: normalizedAltTab, text: "" },
	]);
});

test("empty Tab is consumed while the thinking callback is unavailable", async () => {
	const jiti = createPiImporter();
	const [{ default: registerTabThinking }, { CustomEditor }] = await Promise.all([
		jiti.import("/Users/evanhuang/.pi/agent/extensions/tab-thinking.ts"),
		jiti.import("@earendil-works/pi-coding-agent"),
	]);

	registerTabThinking({ on() {} });

	const state = CustomEditor.prototype.__hostelhawkTabThinkingState;
	assert.ok(state, "Tab-thinking hook should be installed");

	state.cycle = undefined;
	let delegated = false;
	state.originalHandleInput = function () {
		delegated = true;
	};

	CustomEditor.prototype.handleInput.call({ getText: () => "" }, "\t");

	assert.equal(delegated, false, "empty Tab must not reach the original editor handler");
});
