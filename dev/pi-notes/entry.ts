import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import notesExtension from "./index.js";

const CHILD_SESSION_CONTEXT_PROBE = Symbol.for("pi-subagents:child-context:v1");

/**
 * pi-subagents-local exposes its child marker only while loading/building a
 * child session. Capture that fact at extension factory invocation time; later
 * tool/event callbacks run outside the AsyncLocalStorage scope.
 */
export function isSubagentChildLoad(): boolean {
  const registry = globalThis as unknown as Record<PropertyKey, unknown>;
  const probe = registry[CHILD_SESSION_CONTEXT_PROBE];
  return typeof probe === "function" && (probe as () => boolean)() === true;
}

export default function notesExtensionEntry(pi: ExtensionAPI): void {
  if (isSubagentChildLoad()) return;
  notesExtension(pi);
}
