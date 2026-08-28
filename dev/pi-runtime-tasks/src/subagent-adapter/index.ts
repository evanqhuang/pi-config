import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  extractAgentId,
  readAgentOutput,
  toRuntimeTask,
  waitForAgent,
  type AgentRecordLike,
  type AgentRuntimeMetadata,
  type RuntimeTaskOwner,
} from "./core.js";

interface RuntimeTaskHub {
  registerProvider(provider: RuntimeTaskProvider): () => void;
  currentOwner(): RuntimeTaskOwner | undefined;
  setDefaultOwner(owner: RuntimeTaskOwner | undefined): void;
}

interface RuntimeTaskRegistry {
  getSession(sessionId: string): RuntimeTaskHub | undefined;
}

interface RuntimeTaskProvider {
  name: string;
  list(): ReturnType<typeof toRuntimeTask>[];
  get(id: string): ReturnType<typeof toRuntimeTask> | undefined;
  wait(id: string, signal?: AbortSignal): Promise<ReturnType<typeof toRuntimeTask> | undefined>;
  kill(id: string): boolean | Promise<boolean>;
  readOutput(
    id: string,
    offset: number,
    maxBytes: number,
  ): { text: string; nextOffset: number; eof: boolean } | undefined;
}

interface SubagentRegistry {
  spawn(...args: any[]): string;
  getRecord(id: string): AgentRecordLike | undefined;
}

interface SharedAdapterState {
  metadata: Map<string, AgentRuntimeMetadata>;
}

interface RpcReply {
  success?: unknown;
  result?: unknown;
}

type SubagentRpcMethod = "stop" | "consume";

const RUNTIME_REGISTRY_KEY = Symbol.for("pi-runtime-tasks:registry:v2");
const SUBAGENT_REGISTRY_KEY = Symbol.for("pi-subagents:manager");
const ADAPTER_STATES_KEY = Symbol.for("pi-runtime-tasks:subagent-adapter-states:v2");
const SUBAGENT_RPC_TIMEOUT_MS = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAgentTool(toolName: string): boolean {
  return toolName.toLowerCase() === "agent";
}

function rpcResultSucceeded(reply: RpcReply | undefined, method: SubagentRpcMethod): boolean {
  if (reply?.success !== true || !isRecord(reply.result)) return false;
  return method === "stop"
    ? reply.result.stopped === true
    : reply.result.consumed === true;
}

function adapterStates(): WeakMap<object, SharedAdapterState> {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[ADAPTER_STATES_KEY] as WeakMap<object, SharedAdapterState> | undefined;
  if (existing) return existing;

  const states = new WeakMap<object, SharedAdapterState>();
  root[ADAPTER_STATES_KEY] = states;
  return states;
}

function sessionIdFromContext(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sessionManager = (value as { sessionManager?: { getSessionId?: () => string } }).sessionManager;
  return sessionManager?.getSessionId?.();
}

function eventAgentId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id ? id : undefined;
}

function isInternalJudge(record: AgentRecordLike): boolean {
  return record.type === "GoalJudge";
}

function remember(
  state: SharedAdapterState,
  id: string,
  sessionId: string,
  owner: RuntimeTaskOwner | undefined,
  replaceOwner: boolean,
): AgentRuntimeMetadata {
  const existing = state.metadata.get(id);
  if (existing?.sessionId === sessionId) {
    const next = replaceOwner ? { ...existing, owner } : existing;
    if (next !== existing) state.metadata.set(id, next);
    return next;
  }

  const metadata: AgentRuntimeMetadata = {
    sessionId,
    generation: (existing?.generation ?? 0) + 1,
    owner,
  };
  state.metadata.set(id, metadata);
  return metadata;
}

function ensureWrapped(
  registry: SubagentRegistry,
  runtimeRegistry: RuntimeTaskRegistry,
): SharedAdapterState {
  const states = adapterStates();
  const existing = states.get(registry as object);
  if (existing) return existing;

  const state: SharedAdapterState = { metadata: new Map() };
  const originalSpawn = registry.spawn.bind(registry);

  registry.spawn = (...args: any[]) => {
    const id = originalSpawn(...args);
    const sessionId = sessionIdFromContext(args[1]);
    if (sessionId) {
      remember(
        state,
        id,
        sessionId,
        runtimeRegistry.getSession(sessionId)?.currentOwner(),
        true,
      );
    }
    return id;
  };

  states.set(registry as object, state);
  return state;
}

function callSubagentRpc(
  pi: ExtensionAPI,
  method: SubagentRpcMethod,
  agentId: string,
): Promise<boolean> {
  const requestId = randomUUID();
  const channel = `subagents:rpc:${method}`;
  const replyChannel = `${channel}:reply:${requestId}`;

  return new Promise(resolve => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(success);
    };

    unsubscribe = pi.events.on(replyChannel, raw => {
      finish(rpcResultSucceeded(raw as RpcReply | undefined, method));
    });
    timer = setTimeout(() => finish(false), SUBAGENT_RPC_TIMEOUT_MS);
    timer.unref?.();

    try {
      pi.events.emit(channel, { requestId, agentId });
    } catch {
      finish(false);
    }
  });
}

export default function subagentRuntimeAdapter(pi: ExtensionAPI): void {
  let sessionId: string | undefined;
  let unregisterProvider: (() => void) | undefined;
  let sharedState: SharedAdapterState | undefined;
  const pendingOwners = new Map<string, RuntimeTaskOwner | undefined>();

  const runtimeRegistry = (): RuntimeTaskRegistry | undefined =>
    ((globalThis as unknown as Record<PropertyKey, unknown>)[RUNTIME_REGISTRY_KEY] as RuntimeTaskRegistry | undefined);
  const subagents = (): SubagentRegistry | undefined =>
    ((globalThis as unknown as Record<PropertyKey, unknown>)[SUBAGENT_REGISTRY_KEY] as SubagentRegistry | undefined);
  const currentHub = (): RuntimeTaskHub | undefined =>
    sessionId ? runtimeRegistry()?.getSession(sessionId) : undefined;

  const connect = (): void => {
    if (unregisterProvider || !sessionId) return;
    const runtime = runtimeRegistry();
    const hub = runtime?.getSession(sessionId);
    const registry = subagents();
    if (!runtime || !hub || !registry) return;

    const state = ensureWrapped(registry, runtime);
    sharedState = state;

    const metadataFor = (id: string): AgentRuntimeMetadata | undefined => {
      const metadata = state.metadata.get(id);
      return metadata?.sessionId === sessionId ? metadata : undefined;
    };
    const recordFor = (id: string): AgentRecordLike | undefined => {
      if (!metadataFor(id)) return undefined;
      const record = registry.getRecord(id);
      return record && !isInternalJudge(record) ? record : undefined;
    };

    unregisterProvider = hub.registerProvider({
      name: "subagents",
      list: () => [...state.metadata.entries()]
        .filter(([, metadata]) => metadata.sessionId === sessionId)
        .map(([id, metadata]) => {
          const record = registry.getRecord(id);
          return record && !isInternalJudge(record) ? toRuntimeTask(record, metadata) : undefined;
        })
        .filter((record): record is NonNullable<typeof record> => Boolean(record)),
      get: id => {
        const metadata = metadataFor(id);
        const record = recordFor(id);
        return metadata && record ? toRuntimeTask(record, metadata) : undefined;
      },
      wait: async (id, signal) => {
        const metadata = metadataFor(id);
        const record = recordFor(id);
        if (!metadata || !record) return undefined;

        await waitForAgent(record, signal);
        const consumed = await callSubagentRpc(pi, "consume", id);
        if (!consumed) {
          // The canonical manager re-checks this flag when its held nudge fires.
          // This fallback still suppresses duplication if an older RPC surface
          // is present but does not implement the consume method.
          record.resultConsumed = true;
        }
        return toRuntimeTask(record, metadata);
      },
      kill: async id => {
        const record = recordFor(id);
        if (!record || (record.status !== "running" && record.status !== "queued")) return false;

        if (await callSubagentRpc(pi, "stop", id)) return true;
        if (!record.abortController) return false;
        record.abortController.abort();
        return true;
      },
      readOutput: (id, offset, maxBytes) => {
        const record = recordFor(id);
        return record ? readAgentOutput(record, offset, maxBytes) : undefined;
      },
    });
  };

  const rememberStarted = (data: unknown): void => {
    const id = eventAgentId(data);
    const registry = subagents();
    const hub = currentHub();
    if (!id || !registry || !hub || !sessionId) return;

    connect();
    if (!sharedState || sharedState.metadata.has(id)) return;
    const record = registry.getRecord(id);
    if (!record || isInternalJudge(record)) return;
    remember(sharedState, id, sessionId, hub.currentOwner(), false);
  };

  const armCompletionOwner = (data: unknown): void => {
    const id = eventAgentId(data);
    const registry = subagents();
    const hub = currentHub();
    if (!id || !registry || !hub || !sessionId || !sharedState) return;

    const metadata = sharedState.metadata.get(id);
    const record = registry.getRecord(id);
    if (
      metadata?.sessionId !== sessionId
      || !metadata.owner
      || !record
      || record.resultConsumed
      || isInternalJudge(record)
    ) {
      return;
    }
    hub.setDefaultOwner(metadata.owner);
  };

  pi.on("session_start", (_event, nextCtx) => {
    sessionId = nextCtx.sessionManager.getSessionId();
    connect();
    queueMicrotask(connect);
  });

  pi.on("tool_call", event => {
    if (!isAgentTool(event.toolName) || !sessionId) return;
    pendingOwners.set(event.toolCallId, currentHub()?.currentOwner());
  });

  pi.on("tool_result", event => {
    if (!isAgentTool(event.toolName) || !sessionId) return;
    const captured = pendingOwners.has(event.toolCallId);
    const owner = pendingOwners.get(event.toolCallId);
    pendingOwners.delete(event.toolCallId);
    if (event.isError) return;

    connect();
    const id = extractAgentId(event.details, event.content);
    if (!id || !sharedState) return;
    remember(sharedState, id, sessionId, owner, captured);
  });

  const unsubscribeRuntimeReady = pi.events.on("runtime-tasks:ready", connect);
  const unsubscribeSubagentsReady = pi.events.on("subagents:ready", connect);
  const unsubscribeStarted = pi.events.on("subagents:started", rememberStarted);
  const unsubscribeCompleted = pi.events.on("subagents:completed", armCompletionOwner);
  const unsubscribeFailed = pi.events.on("subagents:failed", armCompletionOwner);

  pi.on("session_shutdown", () => {
    unregisterProvider?.();
    if (sharedState && sessionId) {
      for (const [id, metadata] of sharedState.metadata) {
        if (metadata.sessionId === sessionId) sharedState.metadata.delete(id);
      }
    }

    pendingOwners.clear();
    unregisterProvider = undefined;
    sharedState = undefined;
    sessionId = undefined;
    unsubscribeRuntimeReady();
    unsubscribeSubagentsReady();
    unsubscribeStarted();
    unsubscribeCompleted();
    unsubscribeFailed();
  });
}
