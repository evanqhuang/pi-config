import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeTaskOwner } from "./types.js";

interface RuntimeTaskOwnerScope {
  sessionId: string;
  owner: RuntimeTaskOwner | undefined;
}

export interface RuntimeTaskOwnerLookup {
  scoped: boolean;
  owner: RuntimeTaskOwner | undefined;
}

interface RuntimeTaskOwnerContext {
  current(sessionId: string): RuntimeTaskOwnerLookup;
  run<T>(sessionId: string, owner: RuntimeTaskOwner | undefined, fn: () => T): T;
}

const OWNER_CONTEXT_KEY = Symbol.for("pi-runtime-tasks:owner-context:v2");

export function runtimeTaskOwnerContext(): RuntimeTaskOwnerContext {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[OWNER_CONTEXT_KEY] as RuntimeTaskOwnerContext | undefined;
  if (existing) return existing;

  const storage = new AsyncLocalStorage<RuntimeTaskOwnerScope>();
  const context: RuntimeTaskOwnerContext = {
    current(sessionId) {
      const scope = storage.getStore();
      if (scope?.sessionId !== sessionId) return { scoped: false, owner: undefined };
      return { scoped: true, owner: scope.owner };
    },
    run(sessionId, owner, fn) {
      return storage.run({ sessionId, owner }, fn);
    },
  };

  root[OWNER_CONTEXT_KEY] = context;
  return context;
}
