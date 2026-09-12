import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import evalMetricsEntry, { isSubagentChildLoad } from "../entry.js";

const PROBE = Symbol.for("pi-subagents:child-context:v1");

function withProbe(value: boolean, fn: () => void): void {
	const registry = globalThis as unknown as Record<PropertyKey, unknown>;
	const previous = registry[PROBE];
	registry[PROBE] = () => value;
	try { fn(); } finally {
		if (previous === undefined) delete registry[PROBE];
		else registry[PROBE] = previous;
	}
}

describe("eval extension entry isolation", () => {
	it("detects child session scope", () => {
		withProbe(true, () => expect(isSubagentChildLoad()).toBe(true));
	});

	it("does not touch the API for child sessions", () => {
		withProbe(true, () => {
			const pi = new Proxy({}, { get() { throw new Error("child extension touched API"); } }) as ExtensionAPI;
			expect(() => evalMetricsEntry(pi)).not.toThrow();
		});
	});

	it("registers handlers and only a status command, never a model tool", () => {
		withProbe(false, () => {
			const handlers = new Map<string, Function>();
			let commands = 0;
			let tools = 0;
			const pi = {
				on(name: string, handler: Function) { handlers.set(name, handler); },
				registerCommand() { commands += 1; },
				registerTool() { tools += 1; },
				getAllTools: () => [],
				getActiveTools: () => [],
			} as unknown as ExtensionAPI;
			evalMetricsEntry(pi);
			expect(commands).toBe(1);
			expect(tools).toBe(0);
			expect(handlers.has("context")).toBe(false);
			expect(handlers.has("before_agent_start")).toBe(true);
		});
	});
});
