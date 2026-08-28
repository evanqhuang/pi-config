import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ChromeBackgroundGuardState {
	allowForegroundOnce: boolean;
	allowForegroundForever?: boolean;
}

export interface ChromeBackgroundPolicyResult {
	block?: boolean;
	reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const isDirectActivation = (toolName: string, input: Record<string, unknown>): boolean => {
	if (toolName === "chrome_tab") {
		return input.action === "activate" || input.action === "new";
	}
	return toolName === "chrome_launch" && typeof input.url === "string" && input.url.length > 0;
};

const foregroundBlockedReason =
	"Chrome foreground access is locked. Run /chrome-background-guard allow-once to explicitly permit one foreground Chrome call.";

export function applyChromeBackgroundPolicy(
	toolName: string,
	input: unknown,
	state: ChromeBackgroundGuardState,
): ChromeBackgroundPolicyResult {
	if (!toolName.startsWith("chrome_")) return {};

	// Consume the allowance before inspecting the call. It is a one-call capability, not a
	// promise that a malformed or failed tool invocation will leave the guard unlocked.
	const allowForeground = state.allowForegroundOnce || state.allowForegroundForever === true;
	state.allowForegroundOnce = false;

	if (!isRecord(input)) {
		return {
			block: true,
			reason: "Chrome tool input was malformed; foreground access remains locked.",
		};
	}

	if (allowForeground) {
		input.background = false;
		return {};
	}

	if (isDirectActivation(toolName, input)) {
		return { block: true, reason: foregroundBlockedReason };
	}

	// pi-chrome translates background=false into chrome.windows.update({ focused: true }).
	// Override both omitted and explicitly false values at the final tool-call boundary.
	input.background = true;
	return {};
}

export default function registerChromeBackgroundGuard(pi: ExtensionAPI): void {
	const state: ChromeBackgroundGuardState = { allowForegroundOnce: false };

	pi.on("tool_call", (event) => applyChromeBackgroundPolicy(event.toolName, event.input, state));

	pi.registerCommand("chrome-background-guard", {
		description:
			"Keep pi-chrome in background mode. Use 'allow-once' or 'allow-forever' only when you deliberately want Chrome foregrounded.",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			switch (command) {
				case "":
				case "status":
					ctx.ui.notify(
						`Chrome background guard is ${state.allowForegroundForever ? "allowing foreground forever" : state.allowForegroundOnce ? "allowing one call" : "locked"}.`,
						"info",
					);
					return;
				case "allow-once":
					state.allowForegroundOnce = true;
					state.allowForegroundForever = false;
					ctx.ui.notify("Foreground access is allowed for the next Chrome tool call, then it relocks.", "warning");
					return;
				case "allow-forever":
					state.allowForegroundOnce = false;
					state.allowForegroundForever = true;
					ctx.ui.notify("Foreground access is allowed until you run /chrome-background-guard lock.", "warning");
					return;
				case "lock":
					state.allowForegroundOnce = false;
					state.allowForegroundForever = false;
					ctx.ui.notify("Chrome foreground access locked.", "info");
					return;
				default:
					ctx.ui.notify("Use /chrome-background-guard status | allow-once | allow-forever | lock.", "warning");
			}
		},
	});
}
