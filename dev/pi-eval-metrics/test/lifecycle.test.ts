import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EvalRecorder } from "../index.js";

function context(): ExtensionContext {
	return {
		cwd: tmpdir(),
		model: { provider: "test-provider", id: "test-model" } as any,
		thinkingLevel: "medium",
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		sessionManager: {
			getSessionId: () => "lifecycle-session",
			getSessionFile: () => undefined,
		} as any,
	} as ExtensionContext;
}

describe("recorder lifecycle", () => {
	it("creates a sanitized run without modifying lifecycle input", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-eval-lifecycle-"));
		try {
			const pi = {
				getAllTools: () => [{ name: "read", sourceInfo: { path: "/tmp/read.ts" } }],
				getActiveTools: () => ["read"],
			} as unknown as ExtensionAPI;
			const recorder = new EvalRecorder(pi, { rootDir: root, maxBufferedEvents: 32 });
			const ctx = context();
			const start = { type: "session_start" as const, reason: "startup" as const };
			recorder.onSessionStart(start, ctx);
			const before = JSON.stringify(start);
			recorder.onTaskPrompt({
				prompt: "private benchmark prompt that must not persist",
				images: [{ type: "image", data: "secret" }],
				systemPrompt: "private system prompt",
				systemPromptOptions: {} as any,
			} as any, ctx);
			const reminder = { message: { role: "custom", customType: "pi-notes-reminder", content: "[TASK NOTES CHECKPOINT REQUESTED]" } };
			recorder.onMessageEnd(reminder as any);
			recorder.onMessageEnd(reminder as any);
			for (let attempt = 0; attempt < 20 && !recorder.status().active; attempt += 1) {
				await new Promise(resolveDelay => setTimeout(resolveDelay, 25));
			}
			expect(recorder.status().active).toBe(true);
			recorder.onBeforeProviderRequest(ctx);
			recorder.onToolCall({ toolCallId: "call-1", toolName: "goal_progress", input: { status: "done", secret: "do not write" } });
			recorder.onToolResult({ toolCallId: "call-1", toolName: "npm test", input: { command: "npm test", secret: "do not write" }, content: [{ type: "text", text: "tests passed" }], isError: false } as any);
			recorder.onMessageEnd({ message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", name: "write", arguments: { secret: "no" } }, { type: "thinking", thinking: "no" }], usage: { input: 1, output: 2, totalTokens: 3, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" } } as any);
			recorder.onBeforeCompact({ preparation: { firstKeptEntryId: "boundary-a" }, reason: "threshold", willRetry: false });
			recorder.onCompact({ compactionEntry: { tokensBefore: 100, firstKeptEntryId: "boundary-a", fromHook: false }, reason: "threshold", willRetry: false, fromExtension: false } as any, ctx);
			recorder.onMessageEnd({ message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Resume from the durable handoff; API_KEY=secret-value" },
					{ type: "text", text: "I will continue the implementation from the preserved state." },
				],
				usage: { input: 4, output: 5, totalTokens: 9 },
			} } as any);
			recorder.onCompactFailed({ reason: "overflow", aborted: true, willRetry: true, fromExtension: true });
			await recorder.onShutdown({ reason: "quit" });
			expect(JSON.stringify(start)).toBe(before);
			const experimentDirs = await readdir(root);
			const experiment = experimentDirs.find(name => name.startsWith("exp-"));
			expect(experiment).toBeDefined();
			const variant = await readdir(join(root, experiment!, "notes-absent"));
			const runDir = join(root, experiment!, "notes-absent", variant[0]);
			const manifest = await readFile(join(runDir, "manifest.json"), "utf8");
			const events = await readFile(join(runDir, "events.jsonl"), "utf8");
			expect(manifest).not.toContain("private benchmark prompt");
			expect(events).not.toContain("secret");
			expect(events).toContain("goal_progress");
			expect(events).toContain("verification");
			expect(events).toContain("compaction_success");
			expect(events).toContain("compaction_failure");
			expect(events).toContain("post_compaction_trace");
			expect(events).not.toContain("secret-value");
			expect((events.match(/notes_reminder/g) ?? []).length).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
