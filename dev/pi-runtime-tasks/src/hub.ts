import { runtimeTaskOwnerContext } from "./owner.js";
import type {
  RuntimeTaskHub,
  RuntimeTaskOutput,
  RuntimeTaskOwner,
  RuntimeTaskProvider,
  RuntimeTaskRecord,
  RuntimeTaskRegistry,
  RuntimeTaskStatus,
} from "./types.js";

export const RUNTIME_TASK_REGISTRY_KEY = Symbol.for("pi-runtime-tasks:registry:v2");
export const DEFAULT_MAX_READ_BYTES = 64 * 1024;
export const MAX_READ_BYTES = 256 * 1024;

export function isTerminalRuntimeTaskStatus(status: RuntimeTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "killed";
}

function sameOwner(left: RuntimeTaskOwner | undefined, right: RuntimeTaskOwner): boolean {
  return left?.goalId === right.goalId && left.goalGeneration === right.goalGeneration;
}

export class RuntimeTaskHubImpl implements RuntimeTaskHub {
  private readonly providers = new Map<string, RuntimeTaskProvider>();
  private defaultOwner: RuntimeTaskOwner | undefined;

  constructor(readonly sessionId: string) {}

  registerProvider(provider: RuntimeTaskProvider): () => void {
    const existing = this.providers.get(provider.name);
    if (existing && existing !== provider) {
      throw new Error(`Runtime task provider already registered: ${provider.name}`);
    }

    this.providers.set(provider.name, provider);
    return () => {
      if (this.providers.get(provider.name) === provider) {
        this.providers.delete(provider.name);
      }
    };
  }

  list(owner?: RuntimeTaskOwner): RuntimeTaskRecord[] {
    return [...this.providers.values()]
      .flatMap(provider => provider.list())
      .filter(record => !owner || sameOwner(record.owner, owner))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): RuntimeTaskRecord | undefined {
    for (const provider of this.providers.values()) {
      const record = provider.get(id);
      if (record) return record;
    }
    return undefined;
  }

  async wait(id: string, signal?: AbortSignal): Promise<RuntimeTaskRecord | undefined> {
    for (const provider of this.providers.values()) {
      if (provider.get(id)) return provider.wait(id, signal);
    }
    return undefined;
  }

  async kill(id: string): Promise<boolean> {
    for (const provider of this.providers.values()) {
      if (!provider.get(id)) continue;
      return provider.kill ? Boolean(await provider.kill(id)) : false;
    }
    return false;
  }

  readOutput(
    id: string,
    offset = 0,
    maxBytes = DEFAULT_MAX_READ_BYTES,
  ): RuntimeTaskOutput | undefined {
    const safeOffset = Math.max(0, Math.floor(offset));
    const safeMaxBytes = Math.min(MAX_READ_BYTES, Math.max(1, Math.floor(maxBytes)));
    for (const provider of this.providers.values()) {
      if (!provider.get(id)) continue;
      return provider.readOutput?.(id, safeOffset, safeMaxBytes);
    }
    return undefined;
  }

  hasRunning(owner?: RuntimeTaskOwner): boolean {
    return this.list(owner).some(record => !isTerminalRuntimeTaskStatus(record.status));
  }

  currentOwner(): RuntimeTaskOwner | undefined {
    const lookup = runtimeTaskOwnerContext().current(this.sessionId);
    return lookup.scoped ? lookup.owner : this.defaultOwner;
  }

  setDefaultOwner(owner: RuntimeTaskOwner | undefined): void {
    this.defaultOwner = owner ? { ...owner } : undefined;
  }

  clearDefaultOwner(expected?: RuntimeTaskOwner): void {
    if (expected && !sameOwner(this.defaultOwner, expected)) return;
    this.defaultOwner = undefined;
  }

  withOwner<T>(owner: RuntimeTaskOwner | undefined, fn: () => T): T {
    return runtimeTaskOwnerContext().run(this.sessionId, owner, fn);
  }
}

class RuntimeTaskRegistryImpl implements RuntimeTaskRegistry {
  private readonly sessions = new Map<string, RuntimeTaskHub>();

  createSession(sessionId: string): RuntimeTaskHub {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const hub = new RuntimeTaskHubImpl(sessionId);
    this.sessions.set(sessionId, hub);
    return hub;
  }

  getSession(sessionId: string): RuntimeTaskHub | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string, hub: RuntimeTaskHub): void {
    if (this.sessions.get(sessionId) === hub) {
      this.sessions.delete(sessionId);
    }
  }
}

export function runtimeTaskRegistry(): RuntimeTaskRegistry {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[RUNTIME_TASK_REGISTRY_KEY] as RuntimeTaskRegistry | undefined;
  if (existing) return existing;

  const registry = new RuntimeTaskRegistryImpl();
  root[RUNTIME_TASK_REGISTRY_KEY] = registry;
  return registry;
}
