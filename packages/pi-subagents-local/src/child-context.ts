import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
const childSessionContext = new AsyncLocalStorage<boolean>();

/**
 * Stable process-global key for consumers that load alongside this extension.
 * The version suffix makes future contract changes explicit instead of silently
 * changing the meaning of an existing Symbol.for slot.
 */
export const CHILD_SESSION_CONTEXT_PROBE_KEY = "pi-subagents:child-context:v1";
export const CHILD_SESSION_CONTEXT_PROBE = Symbol.for(CHILD_SESSION_CONTEXT_PROBE_KEY);

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

/**
 * The probe must read AsyncLocalStorage at call time. Capturing its value while
 * this module loads would leak one session's state into concurrent sessions.
 */
const childSessionContextProbe = (): boolean => inChildSessionContext();
(globalThis as unknown as Record<PropertyKey, unknown>)[CHILD_SESSION_CONTEXT_PROBE] = childSessionContextProbe;

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}
