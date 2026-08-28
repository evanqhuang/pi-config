import { describe, expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({
	CustomEditor: class {},
}));
mock.module("@earendil-works/pi-ai/compat", () => ({
	getSupportedThinkingLevels: () => [],
}));
mock.module("@earendil-works/pi-tui", () => ({ matchesKey: () => false }));

const { normalizeTerminalInput } = await import("../extensions/tab-thinking.ts");

describe("normalizeTerminalInput", () => {
	test("converts Apple Terminal Option+Tab to Kitty CSI-u", () => {
		expect(normalizeTerminalInput("\x1b\t")).toBe("\x1b[9;3u");
	});

	test("leaves standard terminal input unchanged", () => {
		for (const input of ["\x1b[1;3A", "\x1b[9;3u", "\x1b[A", "hello"]) {
			expect(normalizeTerminalInput(input)).toBe(input);
		}
	});
});
