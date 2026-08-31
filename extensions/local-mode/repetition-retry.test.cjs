const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	MAX_REPETITION_RETRIES,
	REPETITION_RETRY_INSTRUCTION,
	runRepetitionRetry,
} = jiti("./repetition-retry-core.ts");

function assistant(overrides = {}) {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "qwen38-main",
		model: "qwen3.8-27b",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

async function* streamOf(events) {
	for (const event of events) yield event;
}

function repetitionEvents(text = "bad bad bad") {
	const partial = assistant({
		content: [{ type: "text", text }],
		stopReason: "error",
		rawStopReason: "repetition",
		errorMessage: "Provider finish_reason: repetition",
	});
	return [
		{ type: "start", partial },
		{ type: "text_delta", contentIndex: 0, delta: text, partial },
		{ type: "error", reason: "error", error: partial },
	];
}

function successEvents(text = "continued") {
	const partial = assistant({ content: [{ type: "text", text }] });
	return [
		{ type: "start", partial },
		{ type: "text_delta", contentIndex: 0, delta: text, partial },
		{ type: "done", reason: "stop", message: partial },
	];
}

test("retries repetition and returns only the successful attempt", async () => {
	const messages = [{ role: "user", content: "hello", timestamp: 1 }];
	const tools = [{ name: "lookup", description: "lookup", parameters: { type: "object" } }];
	const context = { systemPrompt: "base", messages, tools };
	const calls = [];
	const events = await runRepetitionRetry(
		context,
		{ samplingParams: { top_p: 0.9 } },
		(attemptContext, options) => {
			calls.push({ context: attemptContext, options });
			return streamOf(
				calls.length === 1 ? repetitionEvents() : successEvents(),
			);
		},
	);

	assert.equal(calls.length, 2);
	assert.strictEqual(calls[0].context, context);
	assert.strictEqual(calls[1].context.messages, messages);
	assert.strictEqual(calls[1].context.tools, tools);
	assert.equal(calls[1].context.systemPrompt, `base\n\n${REPETITION_RETRY_INSTRUCTION}`);
	assert.equal(calls[0].options.samplingParams.skip_reading_prefix_cache, undefined);
	assert.deepEqual(calls[1].options.samplingParams, {
		top_p: 0.9,
		skip_reading_prefix_cache: true,
	});
	assert.deepEqual(events.map((event) => event.type), ["start", "text_delta", "done"]);
	assert.equal(events[1].delta, "continued");
});

test("stops after five retries and discards final partial content", async () => {
	let calls = 0;
	const events = await runRepetitionRetry(
		{ messages: [] },
		undefined,
		() => {
			calls += 1;
			return streamOf(repetitionEvents(`failed-${calls}`));
		},
	);
	assert.equal(calls, MAX_REPETITION_RETRIES + 1);
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "error");
	assert.equal(events[0].error.rawStopReason, "repetition");
	assert.deepEqual(events[0].error.content, []);
});

test("does not retry a non-repetition provider error", async () => {
	let calls = 0;
	const error = assistant({
		stopReason: "error",
		rawStopReason: "server_error",
		errorMessage: "server error",
	});
	const events = await runRepetitionRetry(
		{ messages: [] },
		undefined,
		() => {
			calls += 1;
			return streamOf([
				{ type: "start", partial: error },
				{ type: "error", reason: "error", error },
			]);
		},
	);
	assert.equal(calls, 1);
	assert.deepEqual(events.map((event) => event.type), ["start", "error"]);
});

test("does not retry after caller aborts", async () => {
	const controller = new AbortController();
	let calls = 0;
	const events = await runRepetitionRetry(
		{ messages: [] },
		{ signal: controller.signal },
		() => {
			calls += 1;
			controller.abort();
			return streamOf(repetitionEvents());
		},
	);
	assert.equal(calls, 1);
	assert.equal(events[0].type, "error");
	assert.deepEqual(events[0].error.content, []);
});

test("snapshots mutable partial events while buffering", async () => {
	const partial = assistant({ content: [{ type: "text", text: "first" }] });
	async function* mutableStream() {
		yield { type: "start", partial };
		partial.content[0].text = "second";
		yield { type: "text_delta", contentIndex: 0, delta: "second", partial };
		yield { type: "done", reason: "stop", message: partial };
	}
	const events = await runRepetitionRetry(
		{ messages: [] },
		undefined,
		mutableStream,
	);
	assert.equal(events[0].partial.content[0].text, "first");
	assert.equal(events[1].partial.content[0].text, "second");
});

test("registers the retry caller for every local provider, including the 9B subagent", () => {
	const source = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		source,
		/for \(const provider of \["qwen38-main", "qwen38-subagent", "qwopus-subagent"\]\)[\s\S]*?registerProvider\(provider,[\s\S]*?streamSimple: createRepetitionRetryStream/,
	);
});
