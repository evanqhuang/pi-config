import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Model = { provider: string; id: string; reasoning: boolean };
type Context = { sessionManager: any; cwd: string; model: Model | undefined; modelRegistry: any };
type Handler = (event: any, ctx: Context) => unknown;

const packageRoot = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const codingAgent = await import(`${packageRoot}/dist/index.js`);
mock.module("@earendil-works/pi-coding-agent", () => codingAgent);
const { default: registerPreferences } = await import("../extensions/last-used-preferences.ts");
const { SettingsManager, SessionManager } = codingAgent;

const model = (provider: string, id: string): Model => ({ provider, id, reasoning: true });

function context(sessionManager: any, currentModel: Model | undefined): Context {
	return {
		sessionManager,
		cwd: process.cwd(),
		model: currentModel,
		modelRegistry: { find: () => undefined },
	};
}

describe("last-used startup preferences", () => {
	let agentDir: string;
	let previousAgentDir: string | undefined;

	beforeEach(() => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		agentDir = mkdtempSync(join(tmpdir(), "pi-startup-preferences-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	test("persists root model and thinking independently, while excluding child sessions", async () => {
		const handlers = new Map<string, Handler>();
		let currentModel = model("provider-a", "model-a");
		let currentThinking = "medium";
		const pi = {
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			setModel: async (next: Model<any>) => {
				currentModel = next;
				return true;
			},
			setThinkingLevel: (level: any) => {
				currentThinking = level;
			},
		} as unknown as ExtensionAPI;
		registerPreferences(pi);

		const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
		settings.setDefaultModelAndProvider("provider-a", "model-a");
		settings.setDefaultThinkingLevel("high");
		await settings.flush();

		const root = SessionManager.inMemory(process.cwd());
		const rootContext = () => context(root, currentModel);
		await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, rootContext());
		await handlers.get("thinking_level_select")?.(
			{ type: "thinking_level_select", level: "high", previousLevel: "medium" },
			rootContext(),
		);

		const nextModel = model("provider-b", "model-b");
		currentModel = nextModel;
		// This is the automatic clamp emitted before model_select; it must not
		// replace the independent global high preference.
		await handlers.get("thinking_level_select")?.(
			{ type: "thinking_level_select", level: "low", previousLevel: "high" },
			rootContext(),
		);
		await handlers.get("model_select")?.(
			{ type: "model_select", model: nextModel, previousModel: model("provider-a", "model-a"), source: "cycle" },
			rootContext(),
		);

		const reloaded = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
		expect(reloaded.getDefaultProvider()).toBe("provider-b");
		expect(reloaded.getDefaultModel()).toBe("model-b");
		expect(reloaded.getDefaultThinkingLevel()).toBe("high");
		expect(currentThinking).toBe("high");

		const child = SessionManager.inMemory(process.cwd(), { parentSession: "/tmp/parent.jsonl" });
		const childContext = () => context(child, currentModel);
		await handlers.get("model_select")?.(
			{ type: "model_select", model: model("provider-c", "model-c"), previousModel: nextModel, source: "set" },
			childContext(),
		);
		await handlers.get("thinking_level_select")?.(
			{ type: "thinking_level_select", level: "low", previousLevel: "high" },
			childContext(),
		);

		const afterChild = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });
		expect(afterChild.getDefaultProvider()).toBe("provider-b");
		expect(afterChild.getDefaultModel()).toBe("model-b");
		expect(afterChild.getDefaultThinkingLevel()).toBe("high");
	});
});
