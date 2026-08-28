import { describe, expect, test } from "bun:test";
import chromeBackgroundGuard, { applyChromeBackgroundPolicy } from "./index";

type ToolCallHandler = (event: { toolName: string; input: unknown }) => unknown;
type CommandHandler = (args: string, ctx: { ui: { notify: (message: string, level: string) => void } }) => unknown;

function createHarness() {
	let toolCallHandler: ToolCallHandler | undefined;
	let commandHandler: CommandHandler | undefined;
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") toolCallHandler = handler;
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			if (name === "chrome-background-guard") commandHandler = command.handler;
		},
	};

	chromeBackgroundGuard(pi as never);
	if (!toolCallHandler || !commandHandler) throw new Error("Guard did not register its hook and command");

	return {
		call(toolName: string, input: unknown) {
			const event = { toolName, input };
			return { event, result: toolCallHandler?.(event) };
		},
		command(args: string) {
			return commandHandler?.(args, {
				ui: {
					notify(message: string, level: string) {
						notifications.push({ message, level });
					},
				},
			});
		},
		notifications,
	};
}

describe("applyChromeBackgroundPolicy", () => {
	test("forces all ordinary chrome tool calls into background mode", () => {
		for (const input of [{}, { background: false }, { background: true }]) {
			const state = { allowForegroundOnce: false };
			expect(applyChromeBackgroundPolicy("chrome_snapshot", input, state)).toEqual({});
			expect(input.background).toBe(true);
			expect(state.allowForegroundOnce).toBe(false);
		}
	});

	test("does not alter non-Chrome tools", () => {
		const input = { background: false };
		const state = { allowForegroundOnce: false };
		expect(applyChromeBackgroundPolicy("bash", input, state)).toEqual({});
		expect(input.background).toBe(false);
	});

	test("keeps screenshot and wait operations in background mode", () => {
		for (const toolName of ["chrome_screenshot", "chrome_wait_for"]) {
			const input = { background: false };
			expect(applyChromeBackgroundPolicy(toolName, input, { allowForegroundOnce: false })).toEqual({});
			expect(input.background).toBe(true);
		}
	});

	test("blocks Chrome operations that directly activate tabs", () => {
		const riskyCalls = [
			["chrome_tab", { action: "activate" }],
			["chrome_tab", { action: "new", url: "https://example.com" }],
			["chrome_launch", { url: "https://example.com" }],
		] as const;

		for (const [toolName, input] of riskyCalls) {
			const result = applyChromeBackgroundPolicy(toolName, input, { allowForegroundOnce: false });
			expect(result.block).toBe(true);
			expect(result.reason).toContain("/chrome-background-guard allow-once");
		}
	});

	test("fails safely for malformed Chrome inputs", () => {
		const result = applyChromeBackgroundPolicy("chrome_snapshot", null, { allowForegroundOnce: false });
		expect(result.block).toBe(true);
	});

	test("consumes a foreground allowance exactly once", () => {
		const state = { allowForegroundOnce: true };
		const first = { action: "activate" };
		expect(applyChromeBackgroundPolicy("chrome_tab", first, state)).toEqual({});
		expect(first.background).toBe(false);
		expect(state.allowForegroundOnce).toBe(false);

		const second = { action: "activate" };
		expect(applyChromeBackgroundPolicy("chrome_tab", second, state).block).toBe(true);
	});
});

describe("pi extension registration", () => {
	test("registers the guard and starts locked", () => {
		const harness = createHarness();
		harness.command("status");
		expect(harness.notifications.at(-1)?.message).toContain("locked");

		const { event, result } = harness.call("chrome_snapshot", { background: false });
		expect(event.input).toEqual({ background: true });
		expect(result).toEqual({});
	});

	test("allow-once permits one call and automatically relocks", () => {
		const harness = createHarness();
		harness.command("allow-once");
		expect(harness.notifications.at(-1)?.message).toContain("next Chrome tool call");

		expect(harness.call("chrome_tab", { action: "activate" }).result).toEqual({});
		expect(harness.call("chrome_tab", { action: "activate" }).result).toMatchObject({ block: true });
		harness.command("status");
		expect(harness.notifications.at(-1)?.message).toContain("locked");
	});

	test("allow-forever permits repeated calls until lock", () => {
		const harness = createHarness();
		harness.command("allow-forever");
		expect(harness.notifications.at(-1)?.message).toContain("until");

		expect(harness.call("chrome_tab", { action: "activate" }).result).toEqual({});
		expect(harness.call("chrome_tab", { action: "activate" }).result).toEqual({});
		harness.command("status");
		expect(harness.notifications.at(-1)?.message).toContain("forever");

		harness.command("lock");
		expect(harness.call("chrome_tab", { action: "activate" }).result).toMatchObject({ block: true });
	});

	test("lock revokes an unused allowance", () => {
		const harness = createHarness();
		harness.command("allow-once");
		harness.command("lock");
		expect(harness.call("chrome_launch", { url: "https://example.com" }).result).toMatchObject({ block: true });
	});
});
