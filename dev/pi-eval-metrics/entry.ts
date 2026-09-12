import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import evalMetricsExtension from "./index.js";

const CHILD_SESSION_CONTEXT_PROBE = Symbol.for("pi-subagents:child-context:v1");

/** Keep subagent sessions from opening duplicate eval runs. */
export function isSubagentChildLoad(): boolean {
	// SAFETY: the subagents package owns this global probe and exposes it as a
	// zero-argument predicate; the registry is intentionally untyped by design.
	const registry = globalThis as unknown as Record<PropertyKey, unknown>;
	const probe = registry[CHILD_SESSION_CONTEXT_PROBE];
	return typeof probe === "function" && (probe as () => boolean)() === true;
}

export default function evalMetricsExtensionEntry(pi: ExtensionAPI): void {
	if (isSubagentChildLoad()) return;
	evalMetricsExtension(pi);
}
