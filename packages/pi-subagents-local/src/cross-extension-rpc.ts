/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, and consume RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { getAgentConfig, resolveSpawnType } from "./agent-types.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { resolveAgentInvocationConfig } from "./invocation-config.js";
import { checkModelScope } from "./model-scope.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

/** Minimal AgentManager interface needed by the spawn/stop/consume RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  abort(id: string): boolean;
  /**
   * Mark a settled agent's result as read by the caller, suppressing the
   * completion notification — what `get_subagent_result` does when it returns
   * one. False when there is no such agent, or it has not settled yet.
   */
  consumeResult(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  /** Refresh the process-global card registry before a fresh RPC spawn. */
  reloadAgents?: () => void;
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubConsume: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, stop, and consume RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, reloadAgents, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{ requestId: string; type: string; prompt: string; options?: any }>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = { ...(options ?? {}) };
      // Match the Agent/mention funnel's live card reload before resolving the
      // canonical registry identity. The manager callback also performs this
      // check for in-process callers; doing it here keeps the RPC boundary safe
      // when it is unit-tested or
      // supplied a different manager implementation.
      reloadAgents?.();
      const dispatch = resolveSpawnType(type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      const freshSpawn = !normalizedOptions.resumeSessionFile;
      if (freshSpawn) {
        const invocation = resolveAgentInvocationConfig(getAgentConfig(dispatch.type), {
          model: typeof normalizedOptions.model === "string" ? normalizedOptions.model : undefined,
          thinking: normalizedOptions.thinking ?? normalizedOptions.thinkingLevel,
          max_turns: normalizedOptions.max_turns ?? normalizedOptions.maxTurns,
          run_in_background: normalizedOptions.run_in_background ?? normalizedOptions.isBackground,
          inherit_context: normalizedOptions.inherit_context ?? normalizedOptions.inheritContext,
          isolated: normalizedOptions.isolated,
          isolation: normalizedOptions.isolation,
          worktree_disposition: normalizedOptions.worktree_disposition ?? normalizedOptions.worktreeDisposition,
          snapshot_source: normalizedOptions.snapshot_source ?? normalizedOptions.snapshotSource,
        }, {
          worktreeAllowed: isWorktreeIsolationEnabled(),
          defaultRunInBackground: normalizedOptions.isBackground ?? true,
          agentType: dispatch.type,
        });
        if (invocation.policyError) throw new Error(invocation.policyError);
        normalizedOptions = {
          ...normalizedOptions,
          isolation: invocation.isolation,
          worktreeDisposition: invocation.worktreeDisposition,
          snapshotSource: invocation.snapshotSource,
          disallowedTools: invocation.disallowedTools,
          invocation: {
            ...(normalizedOptions.invocation ?? {}),
            isolation: invocation.isolation,
            worktreeDisposition: invocation.worktreeDisposition,
            snapshotSource: invocation.snapshotSource,
          },
        };
      }
      // `!= null` on purpose: a JSON-forwarding caller can serialize an unset
      // field as null, and the runner reads `options.model ?? default`, so null
      // means "inherit" — not an override to resolve or scope-check.
      const override = normalizedOptions.model;
      if (override != null) {
        const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
        // Names the override the same way in both messages below; an object
        // override would otherwise interpolate as "[object Object]".
        const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
        if (!modelRegistry) {
          throw new Error(`Model override "${label}" provided but ctx.modelRegistry is unavailable`);
        }
        let model = override;
        if (typeof override === "string") {
          const resolved = resolveModel(override, modelRegistry);
          if (typeof resolved === "string") {
            // resolveModel returns a human-readable error string when the
            // input doesn't match any available model. Surface it instead of
            // silently falling back so the caller sees the auth/typo issue.
            throw new Error(resolved);
          }
          model = resolved;
          normalizedOptions = { ...normalizedOptions, model: resolved };
        }

        // A model on the RPC payload is an orchestrator-level choice, exactly
        // like Agent({ model }) — so it gets the Agent tool's hard error, never
        // the frontmatter warn (#240). The check reads the RESOLVED model:
        // resolveModel is fuzzy, so a bare "sonnet" can land on a provider the
        // caller never named. Frontmatter-pinned and parent-inherited models are
        // resolved later, in agent-runner, and keep warn-and-proceed.
        const verdict = checkModelScope({
          model,
          cwd: cwd ?? process.cwd(),
          modelRegistry,
          callerSupplied: true,
          agentLabel: dispatch.type,
          modelInput: label,
        });
        if (verdict.kind === "error") throw new Error(verdict.message);
      }

      return { id: manager.spawn(pi, ctx, dispatch.type, prompt, normalizedOptions) };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", ({ agentId }) => {
      if (!manager.abort(agentId)) throw new Error("Agent not found");
    },
  );

  // A caller that has already shown the model an agent's result — pi-tasks'
  // TaskOutput is the one in practice — says so here, so the completion
  // notification for that same result is not delivered on top of it and does
  // not cost the parent a turn. Deliberately outside the ping version
  // handshake: an extension built against protocol v2 simply never calls it.
  const unsubConsume = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:consume", ({ agentId }) => {
      if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop, unsubConsume };
}
