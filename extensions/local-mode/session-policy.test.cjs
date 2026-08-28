const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	LOCAL_EXPLORE_AGENT_TYPE,
	LOCAL_EXPLORE_MODEL,
	buildLocalQwenRequestPayload,
	canRequestLocalQwenDeepReasoning,
	getProcessLocalProviderPolicy,
	isSubagentSession,
	localQwenProfile,
	requiredLocalProvider,
	routeLocalExploreAgent,
	shouldPreserveExplicitLocalSubagentModel,
} = jiti("./session-policy.ts");

function context(
	provider,
	parentSession,
	sessionName = "general-purpose#1234abcd",
	modelId,
) {
	return {
		model: provider ? { provider, id: modelId } : undefined,
		sessionManager: {
			getHeader: () => ({ parentSession }),
			getSessionName: () => sessionName,
		},
	};
}

test("maps the bounded low and medium local Qwen profiles", () => {
	const ctx = context("qwen38-main", undefined, undefined, "qwen3.8-27b");
	assert.deepEqual(localQwenProfile(ctx, true, "low"), {
		thinkingLevel: "low",
		thinkingBudget: 4096,
		maxTokens: 12288,
		contextWindow: 240000,
		requiresCompaction: false,
	});
	assert.deepEqual(localQwenProfile(ctx, true, "medium"), {
		thinkingLevel: "medium",
		thinkingBudget: 8192,
		maxTokens: 20480,
		contextWindow: 240000,
		requiresCompaction: false,
	});
});

test("scales the main xhigh profile at every context boundary", () => {
	const ctx = context("qwen38-main", undefined, undefined, "qwen3.8-27b");
	for (const [contextTokens, thinkingBudget, maxTokens, requiresCompaction] of [
		[0, 65536, 98304, false],
		[99999, 65536, 98304, false],
		[100000, 49152, 65536, false],
		[139999, 49152, 65536, false],
		[140000, 32768, 49152, false],
		[174999, 32768, 49152, false],
		[175000, 49152, 56808, true],
	]) {
		assert.deepEqual(localQwenProfile(ctx, true, "xhigh", contextTokens), {
			thinkingLevel: "xhigh",
			thinkingBudget,
			maxTokens,
			contextWindow: 240000,
			requiresCompaction,
		});
	}
});

test("uses a smaller xhigh schedule for the 96K subagent", () => {
	const ctx = context(
		"qwen38-subagent",
		"/tmp/parent.jsonl",
		undefined,
		"qwen3.8-27b",
	);
	for (const [contextTokens, thinkingBudget, maxTokens, requiresCompaction] of [
		[0, 32768, 49152, false],
		[32000, 24576, 32768, false],
		[56000, 16384, 24576, false],
		[72000, 11712, 15808, true],
	]) {
		assert.deepEqual(localQwenProfile(ctx, true, "xhigh", contextTokens), {
			thinkingLevel: "xhigh",
			thinkingBudget,
			maxTokens,
			contextWindow: 96000,
			requiresCompaction,
		});
	}
});

test("clamps generation to remaining context while reserving answer space", () => {
	const ctx = context("qwen38-main", undefined, undefined, "qwen3.8-27b");
	assert.deepEqual(localQwenProfile(ctx, true, "xhigh", 230000), {
		thinkingLevel: "xhigh",
		thinkingBudget: 0,
		maxTokens: 1808,
		contextWindow: 240000,
		requiresCompaction: true,
	});
});

test("allows only automatic local Qwen sessions to request deeper reasoning", () => {
	const mainQwen = context("qwen38-main", undefined, undefined, "qwen3.8-27b");
	assert.equal(canRequestLocalQwenDeepReasoning(mainQwen, true, true), true);
	assert.equal(canRequestLocalQwenDeepReasoning(mainQwen, true, false), false);
	assert.equal(canRequestLocalQwenDeepReasoning(mainQwen, false, true), false);
	assert.equal(
		canRequestLocalQwenDeepReasoning(
			context("qwopus-subagent", undefined, undefined, "qwopus3.5-9b-coder-mtp"),
			true,
			true,
		),
		false,
	);
});

test("keeps extension provider metadata synchronized with active Pi models", () => {
	const sourceProviders = JSON.parse(
		readFileSync(join(__dirname, "local-providers.json"), "utf8"),
	);
	const activeProviders = JSON.parse(
		readFileSync(join(__dirname, "..", "..", "models.json"), "utf8"),
	).providers;
	for (const provider of ["qwen38-main", "qwen38-subagent", "qwopus-subagent"]) {
		assert.deepEqual(activeProviders[provider], sourceProviders[provider]);
	}
});

test("uses /local as an idempotent automatic-mode entrypoint", () => {
	const extensionSource = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		extensionSource,
		/async function enableAutomaticLocalMode\([\s\S]*?automaticThinkingLevel = "medium"/,
	);
	assert.match(
		extensionSource,
		/if \(action === "auto"\) \{[\s\S]*?await enableAutomaticLocalMode\(pi, state, ctx\)/,
	);
	assert.match(
		extensionSource,
		/if \(action\) \{[\s\S]*?await enableAutomaticLocalMode\(pi, state, ctx\);/,
	);
});

test("prevents local parent agents from blocking on subagent results", () => {
	const extensionSource = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		extensionSource,
		/event\.toolName !== "get_subagent_result" \|\| !state\.localOnly/,
	);
	assert.match(
		extensionSource,
		/if \(!input\.wait\) return;[\s\S]*?input\.wait = false/,
	);
});

test("keeps the before-agent event available for local system-prompt injection", () => {
	const extensionSource = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		extensionSource,
		/pi\.on\("before_agent_start", async \(event, ctx\) => \{[\s\S]*?event\.systemPrompt/,
	);
});

test("uses a one-time model-led deeper-reasoning request instead of keywords", () => {
	const extensionSource = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		extensionSource,
		/pi\.registerTool\(\{[\s\S]*?name: "request_deeper_reasoning"[\s\S]*?state\.deepReasoningRequested = true/,
	);
	assert.doesNotMatch(extensionSource, /routeLocalQwenThinkingLevel/);
});

test("returns automatic local Qwen reasoning to medium after each settled task", () => {
	const extensionSource = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		extensionSource,
		/pi\.on\("agent_settled",[\s\S]*?automaticThinkingLevel = "medium"/,
	);
	assert.doesNotMatch(
		extensionSource,
		/pi\.on\("tool_result",[\s\S]*?automaticThinkingLevel = "xhigh"/,
	);
});

test("queues context compaction after settlement and resumes the task", () => {
	const extensionSource = readFileSync(join(__dirname, "index.ts"), "utf8");
	assert.match(
		extensionSource,
		/pi\.on\("agent_settled",[\s\S]*?requestCompactionIfNeeded\(pi, state, ctx, profile\)/,
	);
	assert.doesNotMatch(
		extensionSource,
		/pi\.on\("turn_end",[\s\S]*?requestCompactionIfNeeded/,
	);
	assert.match(
		extensionSource,
		/customType: "local-mode-compaction-resume"[\s\S]*?triggerTurn: true/,
	);
});

test("builds a preserved-thinking request from the dynamic profile", () => {
	const ctx = context("qwen38-main", undefined, undefined, "qwen3.8-27b");
	const profile = localQwenProfile(ctx, true, "xhigh", 120000);
	assert.ok(profile);
	assert.deepEqual(
		buildLocalQwenRequestPayload(
			{
				model: "qwen3.8-27b",
				chat_template_kwargs: { custom_flag: true },
			},
			profile,
		),
		{
			model: "qwen3.8-27b",
			reasoning_effort: "xhigh",
			thinking_token_budget: 49152,
			max_tokens: 65536,
			chat_template_kwargs: {
				custom_flag: true,
				enable_thinking: true,
				preserve_thinking: true,
			},
		},
	);
});

test("keeps an emergency answer allowance when compaction is pending", () => {
	const ctx = context("qwen38-main", undefined, undefined, "qwen3.8-27b");
	const profile = localQwenProfile(ctx, true, "xhigh", 239000);
	assert.ok(profile);
	const payload = buildLocalQwenRequestPayload({}, profile);
	assert.equal(payload.max_tokens, 1024);
	assert.equal(payload.thinking_token_budget, 0);
});

test("normalizes unsupported local Qwen levels to medium", () => {
	assert.equal(
		localQwenProfile(
			context("qwen38-subagent", "/tmp/parent.jsonl", undefined, "qwen3.8-27b"),
			true,
			"high",
		)?.thinkingLevel,
		"medium",
	);
});

test("does not profile the local 9B model", () => {
	assert.equal(
		localQwenProfile(
			context("qwopus-subagent", "/tmp/parent.jsonl", undefined, "qwopus3.5-9b-coder-mtp"),
			true,
			"medium",
		),
		undefined,
	);
});

test("does not profile Qwen when local mode is disabled", () => {
	assert.equal(
		localQwenProfile(
			context("qwen38-subagent", "/tmp/parent.jsonl", undefined, "qwen3.8-27b"),
			false,
			"medium",
		),
		undefined,
	);
});

test("routes Explore to the read-only local 9B profile in local mode", () => {
	const input = {
		subagent_type: "Explore",
		model: "anthropic/claude-haiku-4-5",
		thinking: "low",
	};
	assert.equal(routeLocalExploreAgent(input, true), true);
	assert.deepEqual(input, {
		subagent_type: LOCAL_EXPLORE_AGENT_TYPE,
		model: LOCAL_EXPLORE_MODEL,
		thinking: "medium",
	});
});

test("leaves Explore unchanged outside local mode", () => {
	const input = { subagent_type: "Explore" };
	assert.equal(routeLocalExploreAgent(input, false), false);
	assert.deepEqual(input, { subagent_type: "Explore" });
});

test("leaves other agent types unchanged in local mode", () => {
	const input = {
		subagent_type: "Plan",
		model: "qwen38-subagent/qwen3.8-27b",
	};
	assert.equal(routeLocalExploreAgent(input, true), false);
	assert.deepEqual(input, {
		subagent_type: "Plan",
		model: "qwen38-subagent/qwen3.8-27b",
	});
});

test("preserves explicit local 27B child sessions", () => {
	assert.equal(
		shouldPreserveExplicitLocalSubagentModel(
			context("qwen38-subagent", "/tmp/parent.jsonl"),
		),
		true,
	);
});

test("preserves explicit local 9B child sessions", () => {
	assert.equal(
		shouldPreserveExplicitLocalSubagentModel(
			context("qwopus-subagent", "/tmp/parent.jsonl"),
		),
		true,
	);
});

test("does not exempt top-level local sessions", () => {
	assert.equal(
		shouldPreserveExplicitLocalSubagentModel(
			context("qwen38-subagent", undefined),
		),
		false,
	);
});

test("does not exempt the local main provider", () => {
	assert.equal(
		shouldPreserveExplicitLocalSubagentModel(
			context("qwen38-main", "/tmp/parent.jsonl"),
		),
		false,
	);
});

test("does not exempt unrelated child providers", () => {
	assert.equal(
		shouldPreserveExplicitLocalSubagentModel(
			context("openai-codex", "/tmp/parent.jsonl"),
		),
		false,
	);
});

test("distinguishes subagent children from ordinary branched sessions", () => {
	assert.equal(
		isSubagentSession(
			context("qwen38-subagent", "/tmp/parent.jsonl", "feature branch"),
		),
		false,
	);
});

test("forces a non-local child onto the dedicated 27B subagent provider", () => {
	assert.equal(
		requiredLocalProvider(
			context("openai-codex", "/tmp/parent.jsonl"),
			true,
		),
		"qwen38-subagent",
	);
});

test("forces a non-local top-level session onto the local main provider", () => {
	assert.equal(requiredLocalProvider(context("openai-codex"), true), "qwen38-main");
});

test("allows every registered local provider under local-only policy", () => {
	for (const provider of ["qwen38-main", "qwen38-subagent", "qwopus-subagent"]) {
		assert.equal(
			requiredLocalProvider(context(provider, "/tmp/parent.jsonl"), true),
			undefined,
		);
	}
});

test("does not force provider changes when local-only policy is disabled", () => {
	assert.equal(
		requiredLocalProvider(
			context("openai-codex", "/tmp/parent.jsonl"),
			false,
		),
		undefined,
	);
});

test("shares the local-only policy across extension instances", () => {
	const first = getProcessLocalProviderPolicy();
	const second = getProcessLocalProviderPolicy();
	first.enabled = true;
	assert.equal(second.enabled, true);
	first.enabled = false;
});
