import { randomUUID } from "node:crypto";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveDefaultModel, runAgent } from "./agent-runner.js";
import { getAgentSafetyPolicy, getUnavailableAgentSafetyPolicyError } from "./agent-safety-policy.js";
import { registerAgents } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import type { SubagentType, ThinkingLevel } from "./types.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled } from "./worktree.js";

export const PI_SUBAGENTS_SERVICE_V3 = Symbol.for("pi-subagents:service:v3");
const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface EphemeralAgentOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: string;
  prompt: string;
  description?: string;
  signal?: AbortSignal;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface EphemeralAgentResult {
  output: string;
  failure?: string;
  aborted: boolean;
  steered: boolean;
}

export interface PiSubagentsServiceV3 {
  runEphemeralAgent(options: EphemeralAgentOptions): Promise<EphemeralAgentResult>;
  hasActiveAgents(): boolean;
}

interface ManagerRegistry {
  hasRunning(): boolean;
}

function managerRegistry(): ManagerRegistry | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[MANAGER_KEY] as ManagerRegistry | undefined;
}

async function shutdownEphemeralSession(session: AgentSession | undefined): Promise<void> {
  if (!session) return;
  try {
    const runner = (session as AgentSession & { extensionRunner?: { hasHandlers?(event: string): boolean; emit?(event: unknown): Promise<unknown> } }).extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown") && runner.emit) {
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, 3_000).unref()),
      ]);
    }
  } catch { /* evaluator cleanup must not mask its verdict */ }
  try { session.dispose?.(); } catch { /* ignore */ }
}

function createService(): PiSubagentsServiceV3 {
  return Object.freeze({
    hasActiveAgents(): boolean {
      return managerRegistry()?.hasRunning() ?? false;
    },

    async runEphemeralAgent(options: EphemeralAgentOptions): Promise<EphemeralAgentResult> {
      // Refresh cards just before an evaluator run so edits do not require a Pi restart.
      registerAgents(loadCustomAgents(options.ctx.cwd, false));
      const type = options.type as SubagentType;
      const policy = getAgentSafetyPolicy(type);
      const policyError = getUnavailableAgentSafetyPolicyError(type, policy, isWorktreeIsolationEnabled());
      if (policyError) throw new Error(policyError);

      const id = randomUUID().replaceAll("-", "").slice(0, 17);
      let session: AgentSession | undefined;
      let worktree: ReturnType<typeof createWorktree> | undefined;
      let cwd: string | undefined;
      let worktreeBase: string | undefined;

      if (policy?.isolation === "worktree") {
        worktree = createWorktree(options.ctx.cwd, id, {
          finalization: policy.worktreeDisposition ?? "discard",
          snapshotSource: policy.snapshotSource === true,
        });
        if (!worktree) {
          throw new Error(`Agent "${type}" requires a disposable source snapshot, but the worktree could not be created.`);
        }
        cwd = worktree.workPath;
        worktreeBase = options.ctx.cwd;
      }

      try {
        const model = options.model
          ? resolveDefaultModel(options.ctx.model, options.ctx.modelRegistry, options.model)
          : undefined;
        if (options.model && (!model || `${model.provider}/${model.id}` !== options.model)) {
          throw new Error(`Configured evaluator model "${options.model}" is unavailable.`);
        }
        const result = await runAgent(options.ctx, type, options.prompt, {
          pi: options.pi,
          agentId: id,
          signal: options.signal,
          cwd,
          worktreeBase,
          model,
          thinkingLevel: options.thinkingLevel,
          disallowedTools: policy?.disallowedTools,
        });
        session = result.session;
        return {
          output: result.responseText,
          failure: result.failure,
          aborted: result.aborted,
          steered: result.steered,
        };
      } finally {
        await shutdownEphemeralSession(session);
        if (worktree) {
          // Evaluators are never allowed to leave a branch or mutate the user's checkout.
          cleanupWorktree(options.ctx.cwd, worktree, options.description ?? type, { finalization: "discard" });
        }
      }
    },
  });
}

export function getPiSubagentsServiceV3(): PiSubagentsServiceV3 {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const existing = scope[PI_SUBAGENTS_SERVICE_V3] as PiSubagentsServiceV3 | undefined;
  if (existing) return existing;
  const service = createService();
  scope[PI_SUBAGENTS_SERVICE_V3] = service;
  return service;
}
