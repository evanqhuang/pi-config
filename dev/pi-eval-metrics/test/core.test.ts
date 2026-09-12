import { describe, expect, it } from "vitest";
import {
	classifyTool,
	classifyVerificationOutcome,
	detectArm,
	eventWithoutSecrets,
	makeExperimentKey,
	normalizeTaskPrompt,
	redactTraceText,
	stableStringify,
	taskIdentity,
} from "../core.js";

describe("eval core privacy and identity", () => {
	it("normalizes only line endings and surrounding whitespace", () => {
		expect(normalizeTaskPrompt("  one\r\ntwo\rthree  ")).toBe("one\ntwo\nthree");
		const identity = taskIdentity("  one\r\ntwo\rthree  ");
		expect(identity.length).toBe(13);
		expect(identity.hash).toMatch(/^[a-f0-9]{64}$/u);
		expect(identity.taskId).toBe(identity.hash.slice(0, 16));
	});

	it("keeps experiment keys deterministic and independent of Notes variant", () => {
		const input = {
			taskHash: "a",
			targetRepository: "repo",
			targetStartCommit: "commit",
			provider: "provider",
			model: "model",
			thinkingLevel: "medium",
			compactionFingerprint: "compact",
		};
		expect(makeExperimentKey(input)).toBe(makeExperimentKey({ ...input }));
		expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
	});

	it("infers the arm from registered tool metadata", () => {
		expect(detectArm([{ name: "read" }])).toEqual({ arm: "notes-absent", notesToolPresent: false });
		expect(detectArm([{ name: "checkpoint_notes", sourceInfo: { path: "/tmp/pi-notes/index.ts" } }])).toEqual({ arm: "notes-present", notesToolPresent: true });
});

	it("redacts prompts, arguments, outputs, plans, and full errors", () => {
		const event = eventWithoutSecrets("tool_result", {
			prompt: "private prompt",
			args: { secret: true },
			output: "private output",
			thinking: "private thinking",
			plan: "private plan",
			log: "private log",
			file: "private-file.ts",
			errorMessage: "private error",
			inputTokens: 10,
			isError: true,
		});
		const serialized = JSON.stringify(event);
		expect(serialized).not.toContain("private");
		expect(event.inputTokens).toBe(10);
		expect(event.isError).toBe(true);
	});

	it("classifies checkpoint and verification tools without retaining their names", () => {
		expect(classifyTool("checkpoint_notes").checkpoint).toBe(true);
		expect(classifyTool("npm test").verification).toBe("test");
		expect(classifyVerificationOutcome(false, "eslint completed with 0 errors")).toBe("success");
		expect(classifyVerificationOutcome(true, "Process exited with code 1", "npm test | grep -E '^FAIL|✕'")).toBe("success");
		expect(classifyVerificationOutcome(true, "FAIL case-files", "npm test | grep -E '^FAIL|✕'")).toBe("error");
	});

	it("redacts bounded post-compaction trace excerpts", () => {
		const trace = redactTraceText("API_KEY=super-secret https://example.test/path\n" + "x".repeat(1000));
		expect(trace.truncated).toBe(true);
		expect(trace.excerpt).not.toContain("super-secret");
		expect(trace.excerpt).not.toContain("https://example.test/path");
		expect(trace.excerpt.length).toBeLessThanOrEqual(900);
	});
});
