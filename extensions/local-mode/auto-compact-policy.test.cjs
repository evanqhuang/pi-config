const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(__filename);
const {
	AUTO_COMPACT_POLICY_EVENT,
	AUTO_COMPACT_POLICY_REQUEST_EVENT,
	autoCompactModelIdentity,
	createAutoCompactPolicyClient,
	parseAutoCompactPolicySnapshot,
} = jiti("./auto-compact-policy.ts");

function eventBus() {
	const listeners = new Map();
	const emitted = [];
	return {
		emitted,
		on(name, listener) {
			const group = listeners.get(name) ?? new Set();
			group.add(listener);
			listeners.set(name, group);
			return () => group.delete(listener);
		},
		emit(name, value) {
			emitted.push({ name, value });
			for (const listener of listeners.get(name) ?? []) listener(value);
		},
	};
}

const main = {
	api: "openai-completions",
	provider: "qwen38-main",
	id: "qwen3.8-27b",
};
const subagent = { ...main, provider: "qwen38-subagent" };

function snapshot(model = main, thresholdTokens = 136000, requestId) {
	return {
		protocolVersion: 1,
		model,
		...(requestId ? { requestId } : {}),
		thresholdTokens,
		source: "rule:Qwen main",
		configPath: "/tmp/auto-compact.json",
	};
}

test("extracts only complete model identities", () => {
	assert.deepEqual(autoCompactModelIdentity(main), main);
	assert.equal(autoCompactModelIdentity({ provider: main.provider, id: main.id }), undefined);
	assert.equal(autoCompactModelIdentity(undefined), undefined);
});

test("rejects malformed policy snapshots", () => {
	assert.equal(parseAutoCompactPolicySnapshot({}), undefined);
	assert.equal(
		parseAutoCompactPolicySnapshot(snapshot(main, -1)),
		undefined,
	);
	assert.equal(
		parseAutoCompactPolicySnapshot({ ...snapshot(), source: 42 }),
		undefined,
	);
	assert.deepEqual(parseAutoCompactPolicySnapshot(snapshot()), snapshot());
});

test("requests policy and caches only a matching requested model", () => {
	const events = eventBus();
	const client = createAutoCompactPolicyClient(events);
	client.start();
	client.request(main);

	const request = events.emitted[0];
	assert.equal(request.name, AUTO_COMPACT_POLICY_REQUEST_EVENT);
	assert.equal(request.value.protocolVersion, 1);
	assert.equal(typeof request.value.requestId, "string");
	assert.deepEqual(request.value.model, main);

	events.emit(
		AUTO_COMPACT_POLICY_EVENT,
		snapshot(subagent, 76800, request.value.requestId),
	);
	assert.equal(client.snapshotFor(subagent), undefined);

	events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot(main, 136000, request.value.requestId));
	assert.deepEqual(client.snapshotFor(main), snapshot(main, 136000, request.value.requestId));
});

test("clear drops stale snapshots and permits a replacement request", () => {
	const events = eventBus();
	const client = createAutoCompactPolicyClient(events);
	client.start();
	client.request(main);
	const firstRequestId = events.emitted.at(-1).value.requestId;
	events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot(main, 136000, firstRequestId));
	assert.ok(client.snapshotFor(main));

	client.clear();
	assert.equal(client.snapshotFor(main), undefined);
	client.request(main);
	const replacementRequestId = events.emitted.at(-1).value.requestId;
	assert.notEqual(replacementRequestId, firstRequestId);

	// The old response arrives after the replacement request. It must not
	// repopulate the snapshot for the same model.
	events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot(main, 136000, firstRequestId));
	assert.equal(client.snapshotFor(main), undefined);

	events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot(main, 120000, replacementRequestId));
	assert.equal(client.snapshotFor(main)?.thresholdTokens, 120000);

	// It must remain current even when the stale response arrives after it.
	events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot(main, 136000, firstRequestId));
	assert.equal(client.snapshotFor(main)?.thresholdTokens, 120000);
});

test("retries remain safe without a responder and stop removes the listener", () => {
	const events = eventBus();
	const client = createAutoCompactPolicyClient(events);
	client.start();
	client.start();
	client.request(main);
	client.request(main);
	assert.equal(
		events.emitted.filter((event) => event.name === AUTO_COMPACT_POLICY_REQUEST_EVENT).length,
		2,
	);
	assert.equal(client.snapshotFor(main), undefined);

	client.stop();
	events.emit(AUTO_COMPACT_POLICY_EVENT, snapshot(main, 136000));
	assert.equal(client.snapshotFor(main), undefined);
});
