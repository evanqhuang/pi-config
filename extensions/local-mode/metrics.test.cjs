const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const Module = require("node:module");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");
const { runRepetitionRetry } = createJiti(__filename)("./repetition-retry-core.ts");

// The extension's host packages are ESM-only and are not needed to exercise
// metrics. Point Jiti's CJS resolver at tiny package-specific runtime stubs.
const extensionPath = join(__dirname, "index.ts");
const stubDirectory = mkdtempSync(join(tmpdir(), "local-mode-metrics-"));
const stubs = new Map([
	["typebox", "module.exports={Type:{Object:()=>({}),String:()=>({})}};"],
	["@earendil-works/pi-coding-agent", "module.exports={CustomEditor:class CustomEditor{}};"],
	["@earendil-works/pi-ai/compat", "module.exports={createAssistantMessageEventStream(){},getApiProvider(){}};"],
]);
const resolvedStubs = new Map();
for (const [specifier, source] of stubs) {
	const path = join(stubDirectory, `${resolvedStubs.size}.cjs`);
	writeFileSync(path, source);
	resolvedStubs.set(specifier, path);
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
	return resolvedStubs.get(request) ?? originalResolve.call(this, request, parent, isMain, options);
};
const extension = createJiti(__filename)(extensionPath);
Module._resolveFilename = originalResolve;
rmSync(stubDirectory, { recursive: true, force: true });
const { calculateTokensPerSecond, default: localModeExtension } = extension;

function eventBus() {
	const listeners = new Map();
	return {
		on(name, listener) {
			const group = listeners.get(name) ?? new Set();
			group.add(listener);
			listeners.set(name, group);
			return () => group.delete(listener);
		},
		emit(name, value) {
			for (const listener of listeners.get(name) ?? []) listener(value);
		},
	};
}

function fixture() {
	let model;
	let thinkingLevel = "medium";
	let status;
	let editorFactory;
	const handlers = new Map();
	const events = eventBus();
	const pi = {
		events,
		providers: [],
		commands: new Map(),
		registerProvider(name, config) {
			this.providers.push({ name, config });
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
		registerTool() {},
		registerCommand(name, command) {
			this.commands.set(name, command);
		},
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: (level) => {
			thinkingLevel = level;
		},
		setModel: async (nextModel) => {
			model = nextModel;
			return true;
		},
		appendEntry() {},
	};
	const ctx = {
		get model() {
			return model;
		},
		modelRegistry: {
			find: (provider, id) =>
				provider === model?.provider && id === model?.id ? model : undefined,
			getAvailable: () => [],
		},
		getContextUsage: () => ({ tokens: 0 }),
		sessionManager: {
			getEntries: () => [],
			getHeader: () => ({}),
			getSessionName: () => undefined,
		},
		ui: {
			theme: {},
			fg: undefined,
			setStatus: (_name, value) => {
				status = value;
			},
			setWorkingMessage() {},
			setWorkingIndicator() {},
			getTheme: () => undefined,
			setTheme() {},
			getEditorComponent: () => editorFactory,
			setEditorComponent(factory) {
				editorFactory = factory;
			},
			notify() {},
		},
		compact() {},
	};
	ctx.ui.theme = { fg: (_color, text) => text };
	model = {
		api: "openai-completions",
		provider: "qwen38-main",
		id: "qwen3.8-27b",
		contextWindow: 170000,
		maxTokens: 20480,
	};
	return {
		pi,
		ctx,
		getStatus: () => status,
		emit: (name, event = {}) => handlers.get(name)?.(event, ctx),
	};
}

function assistant(output) {
	return { role: "assistant", usage: { output } };
}

test("calculates valid speed and rejects invalid inputs", () => {
	assert.equal(calculateTokensPerSecond(500, 2500), 200);
	for (const [tokens, elapsed] of [
		[0, 1000],
		[-1, 1000],
		[100, 0],
		[100, -1],
		[100, Number.NaN],
		[100, Number.POSITIVE_INFINITY],
	]) {
		assert.equal(calculateTokensPerSecond(tokens, elapsed), undefined);
	}
});

test("reinstalls the cycle wrapper after a disabled editor replacement", async () => {
	const { pi, ctx } = fixture();
	const firstInputs = [];
	const firstFactory = () => ({ handleInput: (data) => firstInputs.push(data) });
	ctx.ui.setEditorComponent(firstFactory);
	localModeExtension(pi, () => 1000);

	await pi.commands.get("local").handler("on", ctx);
	await pi.commands.get("local").handler("off", ctx);

	const replacementInputs = [];
	const replacementFactory = () => ({
		handleInput: (data) => replacementInputs.push(data),
	});
	ctx.ui.setEditorComponent(replacementFactory);
	await pi.commands.get("local").handler("on", ctx);

	const wrapperFactory = ctx.ui.getEditorComponent();
	assert.notEqual(wrapperFactory, replacementFactory);
	const editor = wrapperFactory({}, {}, { matches: () => false });
	editor.handleInput("ordinary input");
	assert.deepEqual(replacementInputs, ["ordinary input"]);
	assert.deepEqual(firstInputs, []);
});

test("commits only successful repetition output for full-turn throughput", async () => {
	const { pi, ctx, emit, getStatus } = fixture();
	let now = 1000;
	localModeExtension(pi, () => now);
	await pi.commands.get("local").handler("on", ctx);
	await emit("turn_start");
	const turnStartedAt = now;
	const failedText = "discarded partial output";
	const failedOutput = 900;
	const successfulText = "committed output";
	const successfulOutput = 300;
	let attempts = 0;
	const streamOf = async function* (events) {
		for (const event of events) yield event;
	};
	const events = await runRepetitionRetry(
		{ messages: [{ role: "user", content: "hello" }] },
		undefined,
		() => {
			attempts += 1;
			if (attempts === 1) {
				now = 2000;
				const partial = {
					...assistant(failedOutput),
					content: [{ type: "text", text: failedText }],
				};
				return streamOf([
					{ type: "start", partial },
					{ type: "text_delta", contentIndex: 0, delta: failedText, partial },
					{
						type: "error",
						reason: "error",
						error: {
							...partial,
							stopReason: "error",
							rawStopReason: "repetition",
						},
					},
				]);
			}

			now = 4000;
			const message = {
				...assistant(successfulOutput),
				content: [{ type: "text", text: successfulText }],
			};
			return streamOf([
				{ type: "start", partial: message },
				{ type: "text_delta", contentIndex: 0, delta: successfulText, partial: message },
				{ type: "done", reason: "stop", message },
			]);
		},
	);

	assert.equal(attempts, 2);
	assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
	assert.equal(
		events.some(
			(event) =>
				event.partial?.content?.[0]?.text === failedText ||
				event.error?.content?.[0]?.text === failedText,
		),
		false,
	);
	assert.equal(
		events.some(
			(event) =>
				event.partial?.usage?.output === failedOutput ||
				event.error?.usage?.output === failedOutput,
		),
		false,
	);
	const committed = events.filter((event) => event.type === "done").map((event) => event.message);
	assert.equal(committed.length, 1);
	assert.equal(committed[0].content[0].text, successfulText);
	assert.equal(committed[0].usage.output, successfulOutput);
	assert.equal(committed.some((message) => message.content[0].text === failedText), false);
	assert.equal(committed.some((message) => message.usage.output === failedOutput), false);
	assert.equal(now - turnStartedAt, 3000);

	const rate = calculateTokensPerSecond(committed[0].usage.output, now - turnStartedAt);
	assert.equal(rate, 100);
	await emit("message_end", { message: committed[0] });
	assert.match(getStatus(), /100 tok\/s/);
});

test("imports without registering providers, then wires turn-start timing", async () => {
	const { pi, ctx, emit, getStatus } = fixture();
	assert.deepEqual(pi.providers, []);
	let now = 1000;
	localModeExtension(pi, () => now);
	assert.deepEqual(pi.providers.map(({ name }) => name), [
		"qwen38-main",
		"qwen38-subagent",
		"qwopus-subagent",
	]);
	await pi.commands.get("local").handler("on", ctx);

	await emit("turn_start");
	now = 2500;
	await emit("message_update", { message: assistant(50000) });
	const firstDisplay = getStatus();
	assert.match(firstDisplay, /33333 tok\/s/);

	// Zero, negative, and non-finite elapsed values must not erase a good value.
	now = 1000;
	await emit("message_update", { message: assistant(60000) });
	assert.equal(getStatus(), firstDisplay);
	now = Number.NaN;
	await emit("message_end", { message: assistant(60000) });
	assert.equal(getStatus(), firstDisplay);

	// A new turn starts a fresh interval and clears the prior display.
	now = 4000;
	await emit("turn_start");
	assert.doesNotMatch(getStatus(), /tok\/s/);
	now = 5000;
	await emit("message_end", { message: assistant(10000) });
	assert.match(getStatus(), /10000 tok\/s/);

	// Model selection and a new session also clear the metrics state.
	await emit("model_select");
	assert.doesNotMatch(getStatus(), /tok\/s/);
	now = 7000;
	await emit("turn_start");
	now = 8000;
	await emit("message_end", { message: assistant(10000) });
	assert.match(getStatus(), /10000 tok\/s/);
	await emit("session_start");
	assert.equal(getStatus(), undefined);
});
