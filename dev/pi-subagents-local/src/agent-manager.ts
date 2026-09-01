/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * There are two independent concurrency pools, never one:
 *
 * - Background (`maxConcurrent`, default 10) bounds ordinary detached agents;
 *   a running foreground agent detached later is grandfathered outside this pool.
 * - Foreground (`maxConcurrentForeground`, default 0 = unlimited) bounds
 *   agents a caller is blocking on inline — `spawnAndWait`.
 *
 * Independent by design: a foreground agent blocks the parent anyway, so
 * charging it to the background pool would let a saturated pool starve the main
 * session of work it could have done itself. Excess agents in either pool are
 * queued and auto-started as slots free up. Nested children take no slot in
 * either — see `occupiesPoolSlot` / `occupiesForegroundSlot`.
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import { getAgentSafetyPolicy } from "./agent-safety-policy.js";
import { loadCustomAgents } from "./custom-agents.js";
import { assignHandle, handleBase } from "./mention.js";
import { registerAgents, resolveSpawnType } from "./agent-types.js";
import { describeModel } from "./model-resolver.js";
import type { AgentInvocation, AgentRecord, AgentTombstone, IsolationMode, MentionResolution, SubagentType, ThinkingLevel } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  toWorktreeReport,
} from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
/**
 * Fired once per assistant `message_end`, for EVERY agent this manager owns —
 * top-level and nested alike, spawns and resumes. The one place where each
 * message is seen exactly once: `AgentRecord.lifetimeUsage` is deliberately
 * double-booked into ancestors (see `nested-tools.ts`) so a hidden child's spend
 * shows up on the record a human can see, which makes those records useless as
 * a basis for anything that must not count a message twice — parent-session
 * accounting above all.
 */
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/**
 * Default max concurrent background agents.
 *
 * Raised from 4 when top-level spawns started defaulting to background
 * (`backgroundByDefault`): foreground agents bypass this pool entirely, so
 * while foreground was the default a fan-out of six ran six. With background
 * as the default every top-level agent takes a slot, and a limit of 4 would
 * have silently queued the tail of exactly the parallel fan-outs the `Agent`
 * tool description tells the model to send.
 */
const DEFAULT_MAX_CONCURRENT = 10;

/**
 * Default max concurrent foreground (blocking) agents — `0` = unlimited, the
 * extension's existing convention for "no ceiling" (`defaultMaxTurns`).
 *
 * Off by default because nothing here ever bounded foreground work, and pi
 * dispatches a message's tool calls through `Promise.all`, so an unqualified
 * fan-out of blocking `Agent` calls has always run all at once. Users who want
 * it bounded — chiefly local models, where parallel agents thrash the prompt
 * cache (#253) — opt in; everyone else keeps today's behaviour exactly.
 */
const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/**
 * How many evicted agents stay addressable by name. Only a bound on memory —
 * a session that spawns hundreds of agents shouldn't retain every one — and
 * far above the handful anyone keeps in their head.
 */
const MAX_TOMBSTONES = 100;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 * Nested children don't: their parent already holds a slot, so counting (and
 * therefore queueing) them would deadlock a parent that waits on its own child.
 *
 * Note this bounds nothing horizontally — the depth cap limits how DEEP nesting
 * goes, not how WIDE. A parent's only limit on concurrent children is that each
 * spawn costs it a turn, which is unbounded when max turns is unlimited.
 */
function occupiesPoolSlot(record: Pick<AgentRecord, "isBackground" | "parentAgentId">): boolean {
  return !!record.isBackground && record.parentAgentId === undefined;
}

/**
 * Whether a record occupies one of the `maxConcurrentForeground` slots.
 *
 * Keyed on `blocking` — a caller awaiting this record inline — rather than on
 * `isBackground === false`, because `spawn()` is also the funnel for DETACHED
 * starts (cross-extension RPC, `@handle` mentions, the registry) that may pass
 * `isBackground: false` and are documented to run immediately regardless. Those
 * block nobody, so bounding them buys nothing and would park a record with no
 * one waiting to release it.
 *
 * Nested children are excluded for the same reason as `occupiesPoolSlot`, and
 * more sharply: their parent is blocked *awaiting them*, so queueing a child
 * behind its own parent is a guaranteed deadlock rather than a possible one.
 * Enforced here rather than at the call site so no caller can reintroduce it.
 *
 * Like the background pool this bounds width at the top level only — a parent's
 * own fan-out is limited by nothing but its turn budget.
 */
function occupiesForegroundSlot(record: Pick<AgentRecord, "blocking" | "parentAgentId">): boolean {
  return !!record.blocking && record.parentAgentId === undefined;
}

/**
 * Preserve the immutable verifier policy even for an in-process caller that
 * reaches AgentManager without going through a tool or shared spawn funnel.
 * Normal callers already pass these fields from resolveAgentInvocationConfig;
 * this last boundary prevents a direct manager caller from restoring a shared
 * checkout or re-admitting a denied tool.
 */
function applySafetyPolicy(type: SubagentType, options: SpawnOptions): SpawnOptions {
  // Reopening a tombstoned conversation is a resume path, not a fresh
  // invocation. Do not create a new worktree or alter its historical tools.
  if (options.resumeSessionFile) return options;
  const policy = getAgentSafetyPolicy(type);
  if (!policy) return options;
  const disallowedTools = [...new Set([
    ...(options.disallowedTools ?? []),
    ...(policy.disallowedTools ?? []),
  ])];
  return {
    ...options,
    isolation: policy.isolation ?? options.isolation,
    worktreeDisposition: policy.worktreeDisposition ?? options.worktreeDisposition,
    snapshotSource: policy.snapshotSource ?? options.snapshotSource,
    disallowedTools,
    invocation: options.invocation
      ? {
          ...options.invocation,
          isolation: policy.isolation ?? options.invocation.isolation,
          worktreeDisposition: policy.worktreeDisposition ?? options.invocation.worktreeDisposition,
          snapshotSource: policy.snapshotSource ?? options.invocation.snapshotSource,
        }
      : policy.isolation || policy.worktreeDisposition !== undefined || policy.snapshotSource !== undefined
        ? {
            isolation: policy.isolation,
            worktreeDisposition: policy.worktreeDisposition,
            snapshotSource: policy.snapshotSource,
          }
        : options.invocation,
  };
}

/** Which concurrency pool a spawn is charged to, if any. */
type Pool = "background" | "foreground";

/** Result of a blocking spawn, including the Ctrl+B early-return outcome. */
export type SpawnAndWaitResult =
  | { id: string; record: AgentRecord; detached: false }
  | { id: string; record: AgentRecord; detached: true };

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  /**
   * Optional memorable name for this instance, becoming a second handle
   * (`@auth-audit`) alongside the type-derived one. Slugged, not validated —
   * anything unusable degrades via `handleBase` rather than failing the spawn.
   */
  name?: string;
  /**
   * Reopen this pi session file instead of starting a fresh conversation, so a
   * mention of an evicted agent continues where it left off. The historical
   * type and policy are not re-resolved for this continuation.
   */
  resumeSessionFile?: string;
  /**
   * Take an evicted agent's names back verbatim instead of allocating fresh
   * ones, so a resumed conversation keeps the handle the user just typed —
   * `handleBase(type)` cannot reproduce a numbered `explore-2`. Safe without an
   * `assignHandle` pass because tombstoned names are excluded from allocation
   * (`takenHandles`), so nothing live can be holding them.
   *
   * Internal capability, like `resumeSessionFile`: a forged handle would
   * duplicate a live agent's name and make `resolveMention` ambiguous, so
   * `spawnTopLevel` strips it from anything a caller sends.
   */
  reclaim?: { handle: string; alias?: string };
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /**
   * Skip whichever pool's queue check applies to this spawn — start immediately
   * even if the configured concurrency limit would otherwise queue it. The slot
   * is still COUNTED once the run starts, so a bypassing spawn transiently
   * exceeds the limit rather than being invisible to it.
   *
   * Used by the scheduler, so a fired job can't be deferred past its trigger
   * window, and by the `/agents` agent-file generator, which has no way to
   * cancel a wait (see its call site).
   */
  bypassQueue?: boolean;
  /**
   * A caller is awaiting this record inline (`spawnAndWait`) — what
   * `maxConcurrentForeground` bounds. Set only by `spawnAndWait`; stripped from
   * caller-supplied options by `spawnTopLevel`, since a forged `blocking` would
   * defer a detached start behind a queue its caller cannot see or release.
   */
  blocking?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Effective worktree finalization policy from invocation resolution. */
  worktreeDisposition?: "commit" | "discard";
  /** Effective source-checkout snapshot policy from invocation resolution. */
  snapshotSource?: boolean;
  /** Effective tool denylist from invocation resolution. */
  disallowedTools?: readonly string[];
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /**
   * Called synchronously once the record is in the map and its promise is set,
   * before `onSessionCreated` fires — where callers attach the output file.
   *
   * Carried on the options rather than parked on the manager for the duration
   * of a spawn: with a foreground queue, `startAgent` can run at drain time,
   * long after any such field would have been restored, and the callback would
   * silently never fire (or fire into an unrelated caller's closure).
   */
  onSpawned?: (id: string) => void;
  /**
   * Called synchronously when the spawn is queued instead of started, with how
   * many entries in its own pool are ahead of it. The foreground UI uses it to
   * say so while it waits; nothing else needs it.
   */
  onQueued?: (id: string, ahead: number) => void;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /** Nesting depth: top-level subagent = 1. */
  depth?: number;
  /** Parent agent ID for ownership-scoped nested controls. */
  parentAgentId?: string;
  /** Effective inherited nesting cap for this branch. */
  maxSubagentDepth?: number;
  /** Config-discovery root inherited by nested launches when it differs from the working directory. */
  configCwd?: string;
  /** Root session id, inherited by nested launches so transcripts stay grouped. */
  rootSessionId?: string;
}

interface ResumeOptions {
  /**
   * Run the resumed turn detached in the background: return immediately with
   * the record still "running" (or "queued" at the concurrency limit) and
   * notify on completion via onComplete, exactly like a background spawn.
   * Default (false/undefined) runs the resume inline and returns the settled
   * record — the historical behavior.
   */
  isBackground?: boolean;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * Background resume only: called synchronously when the run actually starts —
   * immediately, or later from drainQueue. Callers wire per-run side effects
   * (output-file streaming) here rather than at the call site, so a resume that
   * is stopped while still queued never leaves a subscription behind: `abort()`
   * drops a queued record without reaching `settle()`, which is what would have
   * torn that subscription down.
   */
  onStarted?: () => void;
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;
/**
 * A provider or tool can ignore an abort forever. Shutdown must not wait for
 * such a run before removing a disposable worktree, but should give normal
 * abort-aware runs time to settle and perform their ordinary cleanup first.
 */
const DISPOSAL_SETTLE_TIMEOUT_MS = 3_000;

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi emits the event
 * itself in `AgentSessionRuntime.dispose()` beforehand, and this is the one place that binds
 * extensions onto a session without going through that path. Without the emit, everything an
 * extension armed in `session_start` leaks once per spawn, and its next tick throws
 * `assertActive()` from a bare timer callback — an uncaughtException that kills pi (#242).
 */
async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    // Optional all the way down: on a pi without the getter, or a stubbed session from a
    // partial `onSessionCreated`, skip the emit — the same degrade as before this fix.
    if (runner?.hasHandlers?.("session_shutdown")) {
      // Raced, not awaited outright. `emit` runs every handler serially with no timeout of
      // its own, and dispose() is reached from pi's own `session_shutdown` with the TUI
      // already torn down — one hung handler would leave a dead terminal.
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  // Always, even on timeout: disposal is what this function ultimately exists to do.
  try { session?.dispose?.(); } catch { /* ignore */ }
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /**
   * Evicted agents that can still be reached by name, keyed by handle. Outlives
   * the 10-minute record cleanup — that timer exists to bound memory, not to
   * expire a conversation the user might still want — and is cleared alongside
   * completed records on session start/switch.
   */
  private tombstones = new Map<string, AgentTombstone>();

  /**
   * Agents waiting to start, tagged with the pool they wait on. One queue for
   * both pools: `drainQueue` picks the earliest entry whose own pool has room,
   * so neither can head-of-line-block the other, and every removal path
   * (`abort`, `abortAll`, `dispose`) stays a single filter.
   *
   * `release` wakes a caller blocked in `spawnAndWait`. Removing an entry from
   * this array MUST release it — a queued record has no promise to await, and
   * pi has no tool-execution timeout to bail the caller out.
   */
  private queue: { id: string; pool: Pool; start: () => void; release: () => void }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Number of currently running foreground (blocking) agents. */
  private runningForeground = 0;
  /**
   * Abort-triggered disposable cleanup jobs. Normally the run's settle path
   * cleans its worktree; this second path handles a provider that never
   * settles after receiving an abort, especially during shutdown.
   */
  private disposableCleanupPromises = new Map<string, Promise<void>>();
  /** Pool slots released while a run promise is still settling. */
  private releasedPoolSlots = new WeakSet<AgentRecord>();
  /** Fresh runs whose caller wiring failed in onSpawned. */
  private failedSpawnCallbacks = new WeakSet<AgentRecord>();
  /** Resolves the foreground waiter when Ctrl+B detaches a record. */
  private detachedWaiters = new Map<string, () => void>();
  /** Pool actually charged when a run starts; settings may change mid-run. */
  private chargedPools = new WeakMap<AgentRecord, Pool | undefined>();
  /** Monotonic insertion order for deterministic newest-record selection. */
  private nextSpawnOrder = 0;
  private spawnOrder = new Map<string, number>();

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** Update the max concurrent foreground (blocking) agents limit. 0 = unlimited. */
  setMaxConcurrentForeground(n: number) {
    // Floor 0, not 1: unlimited is a meaningful value here and the default.
    this.maxConcurrentForeground = Math.max(0, n);
    // Start queued agents if the new limit allows — including everything, when
    // the limit is cleared back to unlimited mid-run.
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  /**
   * Which pool a spawn is charged to, or undefined for one that is charged to
   * neither (nested children, detached non-background spawns).
   *
   * Nothing here queues when the limit is unset — `poolHasRoom` reports an
   * unlimited pool as always having room, so that alone is what keeps the
   * default path identical. The `> 0` guard is belt and braces on top: it also
   * keeps the counter from churning and the settle path from calling a drain
   * that would find nothing to do. Both are unobservable, which is why no test
   * pins them; the observable half — that the default start stays synchronous —
   * is pinned in `test/foreground-concurrency.test.ts`.
   */
  private poolFor(record: AgentRecord): Pool | undefined {
    if (occupiesPoolSlot(record)) return "background";
    if (this.maxConcurrentForeground > 0 && occupiesForegroundSlot(record)) return "foreground";
    return undefined;
  }

  private poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // A resume reopens a historical conversation. It is intentionally the one
    // path that does not consult today's card registry: the caller already has
    // the session file that defines the conversation it is continuing.
    if (!options.resumeSessionFile) {
      // AgentManager is the last shared boundary. Agent-tool, RPC, mention,
      // scheduler, and direct callers can all reach this method, so resolving
      // only in one of those callers would leave the others able to create a
      // record for a deleted, disabled, malformed, or ambiguous card. Load the
      // files immediately before resolving, and do it before allocating an id
      // or looking at either queue.
      const configCwd = options.configCwd ?? ctx.cwd;
      registerAgents(loadCustomAgents(configCwd, true));
      const dispatch = resolveSpawnType(type);
      if (!dispatch.ok) throw new Error(dispatch.message);
      type = dispatch.type;

      // Apply immutable policy only after case-insensitive resolution has
      // produced the canonical registry key. In particular, `lunacompliance`
      // must receive LunaCompliance's denylist rather than being treated as an
      // ordinary caller-supplied name.
      options = applySafetyPolicy(type, options);
    }
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      // Nested children are filtered out of every top-level surface, so no
      // handle: nothing can address them and they must not consume a name a
      // top-level sibling could otherwise take.
      handle: options.parentAgentId !== undefined
        ? undefined
        // A reclaimed handle is used as-is: it belongs to the conversation this
        // spawn is reopening, and re-deriving it would lose the numbering.
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: options.parentAgentId === undefined ? options.reclaim?.alias : undefined,
      // Overwritten below when the spawn is actually queued; a foreground spawn
      // that queues flips to "queued" there rather than being guessed at here,
      // since the pool decision needs the finished record.
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      // Whether anyone is awaiting this agent is a property of the agent, not
      // of the call that made it — and both settle paths need it long after
      // `options` has stopped being the interesting object.
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      detachedGate: new Promise<void>(resolve => this.detachedWaiters.set(id, resolve)),
    };
    this.agents.set(id, record);
    this.spawnOrder.set(id, this.nextSpawnOrder++);
    // After the insert, so `takenHandles()` already counts this record's own
    // handle — a spawn named after its own type gets `explore-2`, not a
    // duplicate `explore` that would make resolution ambiguous.
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.takenHandles());
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    const pool = this.poolFor(record);
    if (pool !== undefined && !options.bypassQueue && !this.poolHasRoom(pool)) {
      // Queue it — started when a running agent in the same pool completes.
      // Idempotent for background (already "queued"); the flip that matters is
      // a blocking foreground spawn, optimistically marked "running" above.
      record.status = "queued";
      // A queued record never reaches startAgent's signal wiring, so arm the
      // parent abort here or Esc could not release the position.
      if (!this.armQueuedAbort(id, options.signal)) return id;
      let release!: () => void;
      record.startGate = new Promise<void>(resolve => { release = resolve; });
      this.queue.push({
        id,
        pool,
        start: () => this.startAgent(id, record, args),
        release: () => release(),
      });
      options.onQueued?.(id, this.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.agents.delete(id);
      this.detachedWaiters.delete(id);
      this.spawnOrder.delete(id);
      throw err;
    }
    return id;
  }

  /**
   * Wire a parent abort signal for a record that is about to be QUEUED.
   * `startAgent` does this for running agents, and a queued record never gets
   * there, so without this Esc could not release a queue position.
   *
   * Returns false when the signal is ALREADY aborted, in which case the record
   * is stopped here and must not be enqueued: `addEventListener` never fires on
   * an aborted signal, so a `spawnAndWait` on it would wait forever — pi has no
   * tool-execution timeout to bail it out.
   *
   * The listener is left in place when the agent starts. `startAgent` adds its
   * own, so both fire on a later abort, but `abort()` on an already-stopped
   * record is a no-op — so detaching would only be tidiness, and tidiness the
   * `abortAll`/`dispose` paths could not offer anyway.
   */
  private armQueuedAbort(id: string, signal?: AbortSignal): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      const record = this.agents.get(id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      return false;
    }
    const onAbort = () => this.abort(id);
    signal.addEventListener("abort", onAbort, { once: true });
    const record = this.agents.get(id);
    if (record) {
      record.parentAbortCleanup = () => {
        signal.removeEventListener("abort", onAbort);
        record.parentAbortCleanup = undefined;
      };
    }
    return true;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    // The project switch is enforced here as well as at the tool boundary
    // because cross-extension RPC forwards its options unvalidated — a schema
    // that omits the field can't stop a caller that never saw the schema.
    let worktreeCwd: string | undefined;
    const worktreeEnabled = isWorktreeIsolationEnabled();
    const policyRequiresWorktree = getAgentSafetyPolicy(type)?.isolation === "worktree";
    if (!options.resumeSessionFile && options.isolation === "worktree" && (worktreeEnabled || policyRequiresWorktree)) {
      // A policy-required worktree must never silently downgrade when a caller
      // bypasses the resolver (for example, a programmatic manager caller).
      if (!worktreeEnabled) {
        throw new Error(
          'Cannot run with isolation: "worktree" — worktree isolation is disabled. ' +
          "Enable worktree isolation rather than running in the shared checkout.",
        );
      }
      const wt = createWorktree(baseCwd, id, {
        finalization: options.worktreeDisposition,
        snapshotSource: options.snapshotSource,
      });
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      // Older/custom worktree providers may omit the optional strategy field;
      // retain the manager's resolved policy so shutdown cleanup cannot
      // misclassify a disposable worktree as ordinary.
      if (wt.finalization === undefined && options.worktreeDisposition !== undefined) {
        wt.finalization = options.worktreeDisposition;
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    // Cleanup is part of the run's result, not best-effort teardown. Ordinary
    // finalization preserves a dirty worktree when a hook or commit check
    // fails; surface that path to callers instead of turning the failure into
    // a misleading "no changes" result. Disposable cleanup still removes its
    // worktree unconditionally inside cleanupWorktree.
    const cleanupAgentWorktree = () => {
      const worktree = record.worktree;
      if (!worktree) return undefined;
      // dispose() may have used the bounded fallback while a provider ignored
      // abort. Do not inspect/remove the same disposable worktree again when a
      // late run settlement eventually reaches this closure.
      if (record.worktreeResult?.discarded) return record.worktreeResult;
      try {
        const wtResult = cleanupWorktree(
          baseCwd,
          worktree,
          options.description,
          options.worktreeDisposition !== undefined
            ? { finalization: options.worktreeDisposition }
            : undefined,
        );
        record.worktreeResult = wtResult;
        return wtResult;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const finalization = options.worktreeDisposition
          ?? (worktree as { finalization?: "commit" | "discard" }).finalization
          ?? "commit";
        const cleanupMessage = finalization === "commit" && !detail.includes(worktree.path)
          ? `${detail}; worktree preserved at ${worktree.path}`
          : detail;
        // A failed ordinary commit means changes remain available at the
        // worktree path. Keep the record honest even though no branch exists.
        // Disposable cleanup has already attempted its unconditional removal;
        // retain the discard/source metadata even when inspection failed.
        if (finalization === "commit") record.worktreeResult = { hasChanges: true };
        else record.worktreeResult = {
          finalization: "discard",
          hasChanges: true,
          discarded: true,
          source: worktree.source,
          snapshot: worktree.snapshot,
        };
        if (record.status !== "stopped") record.status = "error";
        record.error = record.error
          ? `${record.error}\n${cleanupMessage}`
          : cleanupMessage;
        record.result = (record.result ?? "") + `\n\n---\n${cleanupMessage}`;
        return undefined;
      }
    };

    // A queued record had a listener solely to release its queue position. Remove
    // it before installing the running listener (or leaving detached work
    // uncoupled from the parent signal).
    record.parentAbortCleanup?.();
    record.status = "running";
    record.startedAt = Date.now();
    record.startGate = undefined;
    // After the worktree throw point above, so a strict-isolation failure can
    // never leak a slot the run does not hold. Resolved ONCE, here, and carried
    // to `settleRun` below: `poolFor` reads `maxConcurrentForeground`, which
    // the user can change from `/agents → Settings` mid-run, so recomputing it
    // at settle time would decrement a pool this run never charged (counter
    // underflow, limit silently lifted) or skip the decrement for one it did
    // (leaked slot — every later blocking spawn queues forever).
    const pool = this.poolFor(record);
    this.chargedPools.set(record, pool);
    if (pool === "background") this.runningBackground++;
    else if (pool === "foreground") this.runningForeground++;
    try {
      this.onStart?.(record);
    } catch (error) {
      // Startup observers are extension code too. If one rejects the start,
      // release both the acquired slot and any disposable worktree before the
      // error reaches the caller or queued-record error path.
      cleanupAgentWorktree();
      this.releasePoolSlot(record, pool);
      throw error;
    }

    // Wire parent abort signal to stop the subagent when the parent is interrupted.
    // Detached records deliberately skip this coupling, so Ctrl+B gives the
    // foreground tool back without letting its eventual signal stop the child.
    let detachParentSignal: (() => void) | undefined;
    if (options.signal && !record.detached) {
      // A queued spawn can start minutes after the caller handed us its signal,
      // by which time it may already be aborted — and addEventListener would
      // never fire, leaving a child the parent can no longer reach.
      if (options.signal.aborted) this.abort(id);
      else {
        const onParentAbort = () => this.abort(id);
        options.signal.addEventListener("abort", onParentAbort, { once: true });
        detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
      }
    }
    const detach = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      if (record.parentAbortCleanup === detach) record.parentAbortCleanup = undefined;
    };
    record.parentAbortCleanup = detach;

    // An abort may arrive from the parent signal (or an onStart callback)
    // before runAgent has been invoked. Do not launch into a worktree that the
    // abort path has already cleaned; release the slot without creating a run.
    if ((record as AgentRecord).status === "stopped") {
      detach();
      cleanupAgentWorktree();
      this.releasePoolSlot(record, pool);
      return;
    }

    let runPromise: ReturnType<typeof runAgent>;
    try {
      runPromise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      // Set iff a worktree was created (see above) — names the directory the
      // copy came from, so the prompt can tell the agent not to work there.
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      disallowedTools: options.disallowedTools,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        // Capture now, while the session object exists: after eviction this
        // path is the only thing that can reopen the conversation, and an
        // in-memory session reports undefined, which correctly means
        // "nothing to come back to".
        // Optional chaining, not defensiveness for its own sake: this is the
        // only field read off the session at creation, so an older pi or a
        // stubbed session must degrade to "not resumable" rather than throw
        // and take the whole spawn down with it.
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        // Same reason, different field: the model and thinking level are only
        // knowable once pi has resolved its defaults and clamped the level to
        // what the model supports. Writing them back here makes the record
        // authoritative, so every surface reads one place instead of each
        // re-deriving "session, else the request" for itself.
        if (session.model) {
          record.invocation ??= {};
          // Read the kept request first: a caller's level survives being clamped
          // AND, one line later, being replaced by the effective one.
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          // Guarded for the reason above: a session that reports no level keeps
          // the request rather than losing it. Overwriting unconditionally would
          // turn an older or stubbed session into a blank `thinking:` tag, which
          // is worse than the stale-but-true value it replaced.
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        try {
          options.onSessionCreated?.(session);
        } finally {
          // onSpawned runs before a real runner's session is created. If its
          // callback failed, stop and dispose a session that arrives later.
          if (this.failedSpawnCallbacks.has(record)) {
            try { session.abort?.(); } catch { /* ignore */ }
            void shutdownChildSession(session);
          }
        }
        },
      });
      if (!runPromise || typeof runPromise.then !== "function") {
        throw new Error("Agent runner did not return a promise");
      }
    } catch (error) {
      // An implementation or test double may throw before returning a
      // promise. This is still a startup failure and must not strand the
      // worktree or the pool slot acquired above.
      detach();
      cleanupAgentWorktree();
      void shutdownChildSession(record.session);
      this.releasePoolSlot(record, pool);
      throw error;
    }

    const promise = runPromise
      .then(({ responseText, session, aborted, steered, failure }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          // Precedence: a hard abort keeps "aborted"; then a failed final turn
          // (provider error that pi resolved instead of rejecting, #144) is an
          // honest "error" — not a completion with an empty or stale result.
          if (aborted) {
            record.status = "aborted";
          } else if (failure) {
            record.status = "error";
            record.error = failure;
          } else {
            record.status = steered ? "steered" : "completed";
          }
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used. A cleanup failure is recorded as an agent
        // error while leaving the ordinary worktree available for recovery.
        const wtResult = cleanupAgentWorktree();
        if (wtResult?.hasChanges && wtResult.branch) {
          // With a caller-supplied cwd the branch lives in THAT repo, not the
          // parent session's — say so, or the orchestrator merges in the wrong repo.
          const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
          record.result = (record.result ?? "") +
            `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
        }

        this.abortOwnedChildren(id);

        this.settleRun(record, true, pool);
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();

        detach();

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree on agent error as well. Disposable cleanup remains
        // unconditional; ordinary cleanup errors are surfaced and preserved.
        cleanupAgentWorktree();

        this.abortOwnedChildren(id);

        this.settleRun(record, false, pool);
        return "";
      });

    record.promise = promise;

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming
    // starts. Read off the options, so a spawn that started from a queue drain
    // still reaches the caller that queued it.
    try {
      options.onSpawned?.(id);
    } catch (error) {
      // The callback runs after the run and its worktree have started. Treat a
      // wiring failure as a failed spawn: stop the run, synchronously discard a
      // disposable checkout, release its slot, and hide the record. The runner
      // promise may still settle later, so settleRun has an idempotent release
      // guard and suppresses completion for this failed invocation.
      this.failedSpawnCallbacks.add(record);
      detach();
      this.abort(id);
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      this.cleanupDisposableRecord(record);
      this.disposableCleanupPromises.delete(record.id);
      this.abortOwnedChildren(id);
      void shutdownChildSession(record.session);
      this.releasePoolSlot(record, pool);
      this.agents.delete(id);
      this.drainQueue();
      throw error;
    }
  }

  /** Release a charged pool slot at most once, including early teardown paths. */
  private releasePoolSlot(record: AgentRecord, pool: Pool | undefined): void {
    if (this.releasedPoolSlots.has(record)) return;
    this.releasedPoolSlots.add(record);
    if (pool === "background") this.runningBackground--;
    else if (pool === "foreground") this.runningForeground--;
  }

  /**
   * The shared tail of both settle paths: release whatever pool slot the run
   * held, notify, and let the queue drain into the freed slot.
   *
   * Pool release is idempotent because the onSpawned failure path can tear
   * down a run before its promise settles; a later settle must not double-free
   * the limit.
   *
   * Foreground agents fire `onComplete` for lifecycle symmetry, with
   * `resultConsumed` set so the callback skips notifications the inline result
   * already delivered.
   *
   * @param guardCallback swallow a throwing `onComplete` (the success path does;
   *   the error path historically did not, and keeps not doing so).
   * @param pool the pool this run was CHARGED TO at start time — passed in, not
   *   recomputed, so a mid-run change to `maxConcurrentForeground` can't make
   *   the release disagree with the acquire.
   */
  private settleRun(record: AgentRecord, guardCallback: boolean, pool: Pool | undefined): void {
    if (!record.isBackground) record.resultConsumed = true;
    this.releasePoolSlot(record, pool);

    // A throwing onSpawned callback already hid this record and performed its
    // completion-side teardown. Its promise is still allowed to settle so the
    // runner can stop cleanly, but it must not notify or drain a second time.
    if (this.failedSpawnCallbacks.has(record)) return;

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
    } else {
      this.onComplete?.(record);
    }

    // The isBackground half reproduces the pre-pool condition exactly — a
    // background settle has always drained, even for a nested child that held
    // no slot — so that path is unchanged whether or not the foreground pool is
    // on. The `pool` half only adds the drain a freed FOREGROUND slot needs.
    // A drain with nothing freed is a no-op anyway, but "no-op" is a claim
    // about reachability, and matching the old condition needs no such claim.
    if (record.isBackground || pool !== undefined) this.drainQueue();
  }

  /**
   * Stop the nested children a settled parent owns. Nested records are hidden
   * from the UI and only their owner can consume them, so a child outliving its
   * parent would burn tokens unseen with no way to reach it. Grandchildren are
   * covered transitively — each abort lands in that child's own settle path.
   */
  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  /**
   * Start queued agents up to each pool's concurrency limit.
   *
   * `findIndex` on the entry's OWN pool rather than `shift`: with one queue
   * serving two independent limits, a saturated foreground pool at the head
   * would otherwise stall every background agent behind it. Taking the earliest
   * eligible entry keeps FIFO within each pool, which is what callers see.
   */
  private drainQueue() {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = this.agents.get(next.id);
      try {
        // Stale entries (aborted while queued) are skipped, not started — but
        // still released below, since nothing else will.
        if (record && record.status === "queued") next.start();
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        if (record) {
          // Mirrors settleRun: an inline caller gets this failure as a throw
          // out of spawnAndWait, so an unconsumed record would ALSO nudge the
          // session about it — the same failure reported twice.
          if (next.pool === "foreground") record.resultConsumed = true;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.onComplete?.(record);
        }
      } finally {
        next.release();
      }
    }
  }

  /**
   * Remove queued entries and wake anyone blocked on them. The single point
   * that enforces "leaving the queue releases the waiter" — a missed release is
   * an unbounded hang, not a failed call.
   */
  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue = kept;
  }

  /**
   * Detach the newest eligible top-level foreground record.
   *
   * This is deliberately one synchronous operation: selecting the record,
   * removing parent-abort coupling, changing its scheduling identity, and
   * releasing its foreground slot happen before the caller can observe the
   * result. A running record is grandfathered into background execution without
   * taking a background slot; a queued record is moved to the background queue.
   */
  detachForeground(): AgentRecord | undefined {
    let candidate: AgentRecord | undefined;
    let candidateOrder = -1;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined
        || record.blocking !== true
        || record.isBackground !== false
        || record.detached
        || (record.status !== "running" && record.status !== "queued")) continue;
      const order = this.spawnOrder.get(record.id) ?? -1;
      if (!candidate || order > candidateOrder) {
        candidate = record;
        candidateOrder = order;
      }
    }
    if (!candidate) return undefined;

    // A queued entry carries the start closure needed to migrate it. Missing
    // queue state means it raced a drain and is no longer eligible to migrate;
    // the running path below will handle it if it is now running.
    const queuedIndex = candidate.status === "queued"
      ? this.queue.findIndex(entry => entry.id === candidate!.id)
      : -1;
    if (candidate.status === "queued" && queuedIndex < 0) return undefined;

    candidate.detached = true;
    candidate.isBackground = true;
    candidate.blocking = undefined;
    candidate.resultConsumed = false;
    if (candidate.invocation) {
      candidate.invocation = { ...candidate.invocation, runInBackground: true };
    }
    candidate.parentAbortCleanup?.();

    if (queuedIndex >= 0) {
      const [entry] = this.queue.splice(queuedIndex, 1);
      entry.release();
      this.queue.push({ id: candidate.id, pool: "background", start: entry.start, release: () => {} });
    } else {
      // Release only the pool the run actually charged when it started. The
      // foreground limit can change mid-run; recomputing from current settings
      // could decrement a slot that was never acquired. Do not charge the run
      // to background now: it is grandfathered until completion.
      if (this.chargedPools.get(candidate) === "foreground") {
        this.releasePoolSlot(candidate, "foreground");
      }
    }

    this.detachedWaiters.get(candidate.id)?.();
    this.detachedWaiters.delete(candidate.id);
    this.drainQueue();
    return candidate;
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Charged to the foreground pool (`maxConcurrentForeground`), which is
   * unlimited by default; never to the background one.
   * Returns a discriminated outcome so Ctrl+B can return before the child ends.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<SpawnAndWaitResult> {
    // `blocking` is what maxConcurrentForeground bounds, and this is its only
    // source. onSpawned rides on the options rather than on a field of this
    // manager: a queued spawn starts at drain time, long after any install/
    // restore pair around this call would have put the field back.
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.agents.get(id)!;

    // Queued: nothing to await yet — the promise appears when the drain starts
    // it. The gate resolves (never rejects) on every path out of the queue,
    // start and abort alike, so a rejection can never escape into the caller's
    // tool `execute` and take down pi's whole Promise.all tool batch.
    if (record.status === "queued") await record.startGate;

    // undefined when it was aborted while queued and so never ran — the record
    // is already "stopped" with a completedAt, which is what the caller renders.
    if (record.detached) return { id, record, detached: true };
    if (record.promise) await Promise.race([record.promise, record.detachedGate!]);
    if (record.detached) return { id, record, detached: true };

    // A record that ended "error" without ever getting a promise never ran: the
    // same startup failure spawn() rethrows on the immediate path (#179). Keep
    // one contract rather than letting queue pressure decide whether a strict
    // worktree failure throws or returns as a result.
    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record, detached: false };
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    // Background resume: settle asynchronously and notify on completion exactly
    // like a background spawn, returning immediately with the record still
    // "running" — or "queued" when at the concurrency limit. Previously
    // run_in_background was ignored on resume (the Agent tool's resume branch
    // returned before its background branch, and resume() only ever awaited
    // inline), so a resumed agent always blocked the caller until it finished.
    if (options?.isBackground) {
      // Never re-enter a run that is still in flight. Detaching means the caller
      // gets control back while the record stays "running", so nothing stops the
      // model from resuming the same agent again. Starting a second run would
      // overwrite record.abortController — orphaning the live run beyond the
      // reach of `/agents` stop and abortAll() — double-count the pool slot, and
      // then reject from session.prompt() with "Agent is already processing",
      // whose settle path would abort the LIVE run's children and report a
      // failure for a run that is still going. Refuse instead, leaving the
      // record untouched; the caller decides whether to wait or steer.
      if (record.status === "running" || record.status === "queued") return undefined;

      record.isBackground = true;
      record.resultConsumed = false;
      record.result = undefined;
      record.error = undefined;
      record.completedAt = undefined;
      record.status = "queued";

      const start = () => this.startResume(id, record, prompt, signal, options);
      if (occupiesPoolSlot(record) && !this.poolHasRoom("background")) {
        // At the concurrency limit — queue it, drains when a slot frees. A
        // detached resume has no inline caller, hence nothing to release.
        this.queue.push({ id, pool: "background", start, release: () => {} });
      } else {
        start();
      }
      return record;
    }

    // Foreground resume: run inline and return the settled record.
    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;

    try {
      const { text, failure } = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
          options?.onToolActivity?.(activity);
        },
        onAssistantUsage: (usage) => {
          addUsage(record.lifetimeUsage, usage);
          this.onUsage?.(record, usage);
          options?.onAssistantUsage?.(usage);
        },
        onCompaction: (info) => {
          record.compactionCount++;
          this.onCompact?.(record, info);
          options?.onCompaction?.(info);
        },
        signal,
      });
      // Same contract as the spawn path (#144): a failed final turn is an
      // error, not a completion — but the resumed text stays available.
      record.status = failure ? "error" : "completed";
      if (failure) record.error = failure;
      record.result = text;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    // Same contract as the spawn settle paths: children spawned during the
    // resumed turn must not outlive it — nothing else can see or reach them.
    this.abortOwnedChildren(id);

    return record;
  }

  /**
   * Start a background resume run: detached, settling and notifying like
   * startAgent's background path. Invoked immediately, or from drainQueue when
   * a concurrency slot frees. The session already exists (resume reuses it), so
   * there is no onSessionCreated to hang per-run wiring off — callers use
   * `options.onStarted`, which fires on both the immediate and the drained path.
   */
  private startResume(
    id: string,
    record: AgentRecord,
    prompt: string,
    parentSignal: AbortSignal | undefined,
    options: ResumeOptions,
  ) {
    if (!record.session) return;

    record.status = "running";
    record.startedAt = Date.now();
    if (occupiesPoolSlot(record)) this.runningBackground++;
    this.onStart?.(record);

    // Fresh abort controller so /agents stop and steering target THIS run rather
    // than the previous one's settled controller.
    const abortController = new AbortController();
    record.abortController = abortController;
    // Optional, and NOT what the Agent tool passes for a detached resume: a
    // parent signal aborts on the parent's own interrupt (user Esc), which is
    // right for a foreground run whose result the caller is awaiting, and wrong
    // for a detached one — background spawns omit it for exactly this reason.
    let detachParentSignal: (() => void) | undefined;
    if (parentSignal) {
      const onParentAbort = () => this.abort(id);
      parentSignal.addEventListener("abort", onParentAbort, { once: true });
      detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
    }

    // Per-run side effects (output streaming) — see ResumeOptions.onStarted.
    // After the record is in its running shape, before the run is kicked off.
    try { options.onStarted?.(); } catch { /* ignore caller wiring errors */ }

    const settle = () => {
      detachParentSignal?.();
      detachParentSignal = undefined;
      // Final flush of streaming output file
      if (record.outputCleanup) {
        try { record.outputCleanup(); } catch { /* ignore */ }
        record.outputCleanup = undefined;
      }
      // Children spawned during the resumed turn must not outlive it.
      this.abortOwnedChildren(id);
      if (occupiesPoolSlot(record)) this.runningBackground--;
      try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      this.drainQueue();
    };

    const promise = resumeAgent(record.session, prompt, {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      signal: abortController.signal,
    })
      .then(({ text, failure }) => {
        // Don't overwrite status if externally stopped via abort().
        if (record.status !== "stopped") {
          // Same contract as the spawn path (#144): a failed final turn is an
          // error, not a completion — but the resumed text stays available.
          record.status = failure ? "error" : "completed";
          if (failure) record.error = failure;
        }
        record.result = text;
        record.completedAt ??= Date.now();
        settle();
        return text;
      })
      .catch((err) => {
        if (record.status !== "stopped") {
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        record.completedAt ??= Date.now();
        settle();
        return "";
      });

    record.promise = promise;
  }

  /**
   * Send a steering message to an agent from the UI (mirrors the steer_subagent
   * tool). A live session delivers it now — it interrupts the agent after its
   * current tool execution and appears as a user message. If the session isn't
   * ready yet, the message is queued on `pendingSteers` and flushed when the
   * session is created. Returns false if the agent can't accept steering
   * (unknown id, or no longer running/queued).
   */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  private takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    // Tombstones hold their names too: an evicted `@explore` is still
    // resurrectable, so a later Explore must become `explore-2` rather than
    // shadowing a conversation the user can still reach.
    for (const entry of this.tombstones.values()) {
      taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started (which is the one a resume should continue), then
   * falls back to an exact agent id so `@<agentId>` works too.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined) continue;
      // Handle and alias share one namespace, so at most one agent answers a
      // name and it makes no difference which of the two matched.
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
    // Only once nothing live answers: a tombstone is a conversation to reopen,
    // and reopening one while its record still exists would fork the session.
    for (const entry of this.tombstones.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  /**
   * Forget an evicted agent, by handle. For the case where its session file has
   * gone: the entry can then only ever fail, while still holding the name
   * against the type that would otherwise start a fresh agent under it.
   *
   * A *successful* resume does not drop its tombstone — the live record it
   * creates already wins in `resolveMention`, and overwrites the entry in place
   * when it is itself evicted.
   */
  dropTombstone(handle: string): void {
    this.tombstones.delete(handle);
  }

  /** Evicted agents whose conversation can still be reopened, newest first. */
  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued. No decrement — the slot was never taken —
    // and no onComplete, matching what a queued background abort has always
    // done; a blocking caller learns of the stop from its own tool result.
    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    this.scheduleDisposableCleanup(record);
    return true;
  }

  /**
   * Remove a disposable worktree and retain a truthful result even if status
   * inspection itself failed. `cleanupWorktree` force-removes in its finally
   * block; the fallback result keeps shutdown/tombstone metadata complete.
   */
  private cleanupDisposableRecord(record: AgentRecord): void {
    const worktree = record.worktree;
    const finalization = worktree?.finalization ?? record.invocation?.worktreeDisposition ?? "commit";
    if (!worktree || finalization !== "discard") return;
    if (record.worktreeResult?.discarded) return;

    const cleanupCwd = worktree.source?.cwd ?? worktree.source?.root ?? process.cwd();
    try {
      const result = cleanupWorktree(cleanupCwd, worktree, record.description, { finalization });
      record.worktreeResult = result.finalization === undefined
        ? { ...result, finalization }
        : result;
    } catch (error) {
      // A disposable cleanup error is still terminal: cleanupWorktree has
      // already attempted force removal in finally. Do not lose the fact that
      // this was a discard run just because observation failed.
      record.worktreeResult = {
        finalization: "discard",
        hasChanges: true,
        discarded: true,
        source: worktree.source,
        snapshot: worktree.snapshot,
      };
      const detail = error instanceof Error ? error.message : String(error);
      record.error = record.error ? `${record.error}\n${detail}` : detail;
    }
  }

  /**
   * Ensure an abort eventually cleans a disposable worktree. The normal
   * settle callback wins when it can; the bounded fallback prevents an
   * uncooperative provider from stranding a tracked worktree forever.
   */
  private scheduleDisposableCleanup(record: AgentRecord): void {
    const worktree = record.worktree;
    const finalization = worktree?.finalization ?? record.invocation?.worktreeDisposition ?? "commit";
    if (!worktree || finalization !== "discard") return;
    if (record.worktreeResult?.discarded || this.disposableCleanupPromises.has(record.id)) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, DISPOSAL_SETTLE_TIMEOUT_MS);
      timer.unref();
    });
    const settled = record.promise
      ? Promise.race([record.promise.then(() => undefined, () => undefined), timeout])
      : Promise.resolve();
    const cleanup = settled
      .finally(() => { if (timer) clearTimeout(timer); })
      .then(() => { this.cleanupDisposableRecord(record); });
    this.disposableCleanupPromises.set(record.id, cleanup);
    void cleanup.finally(() => {
      if (this.disposableCleanupPromises.get(record.id) === cleanup) {
        this.disposableCleanupPromises.delete(record.id);
      }
    });
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    // A stopped record can be evicted before its provider's promise settles.
    // Keep the asynchronous bounded fallback alive after removing the record;
    // otherwise a session-boundary sweep could strand its disposable worktree.
    if (record.worktree
      && (record.worktree.finalization ?? record.invocation?.worktreeDisposition ?? "commit") === "discard"
      && !record.worktreeResult?.discarded) {
      this.scheduleDisposableCleanup(record);
    }
    this.tombstone(record);
    const session = record.session;
    // Detached before the shutdown starts, so the record leaves the map at once and
    // nothing can observe a session that is half torn down.
    record.session = undefined;
    this.agents.delete(id);
    this.detachedWaiters.delete(id);
    this.spawnOrder.delete(id);
    // Fire-and-forget is right here and only here: this runs from the 60s cleanup timer
    // and from `clearCompleted()` on session boundaries, with the process staying alive,
    // so handlers get their full window. The quit path awaits instead — see dispose().
    void shutdownChildSession(session);
  }

  /**
   * Preserve enough of a departing record for `@handle` to reopen its
   * conversation later. Nothing to keep unless it has both a handle to be
   * addressed by and a session file to reopen — an in-memory session leaves no
   * transcript, so the mention would have nothing to continue from.
   */
  private tombstone(record: AgentRecord): void {
    if (!record.handle || !record.sessionFile) return;
    const entry: AgentTombstone = {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    };
    // Keep partial worktree test doubles/older builds compatible: metadata
    // reporting is additive and must not make tombstoning itself fail.
    const report = typeof toWorktreeReport === "function" ? toWorktreeReport : undefined;
    const worktree = report?.(record.worktree);
    const worktreeResult = report?.(undefined, record.worktreeResult);
    if (worktree) entry.worktree = worktree;
    if (worktreeResult) entry.worktreeResult = worktreeResult;
    this.tombstones.set(record.handle, entry);
    // Bound the memory a long session can accumulate. Oldest first, since the
    // agent someone still wants to reach is the one they used most recently.
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.tombstones.delete(oldest.handle);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // Unconditional: both callers are session boundaries (`session_start` and
    // `session_before_switch`), and `skipUnconsumed` only spares records whose
    // results the LLM has yet to read — it does not make the sweep partial in
    // the sense that matters here. A new session means new handles, or
    // `@explore` would silently reach an agent the user never started. Claude
    // Code resets its registry on `/clear` for the same reason.
    this.tombstones.clear();
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    this.dequeue(() => true);
    // Abort running agents. Go through abort() so explicit abortAll and an
    // individual stop share the same bounded disposable cleanup fallback.
    for (const record of [...this.agents.values()]) {
      if (record.status === "running" && this.abort(record.id)) count++;
    }
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      // filter(Boolean) drops queued records, which have no promise yet. Safe by
      // invariant, not by construction: a slot can only be HELD by a running
      // record, which does have one, so `pending` is never empty while anything
      // is queued. If record.promise ever starts being assigned later than
      // startAgent, this becomes a silent early return.
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  async dispose(): Promise<void> {
    clearInterval(this.cleanupInterval);
    const records = [...this.agents.values()];

    // Abort before disposing child sessions. The abort signal lets normal runs
    // finish their settle path (including disposable cleanup), while the
    // bounded wait below handles a provider that never observes the signal.
    this.abortAll();
    // Clear queue — via dequeue, so anyone blocked in spawnAndWait is woken
    // rather than left awaiting a gate nothing will ever resolve.
    this.dequeue(() => true);

    // Disposing a child session causes many in-flight runAgent promises to
    // settle, so start both waits together. The combined bounded wait avoids
    // making shutdown pay the child-handler timeout and run-settle timeout in
    // series, while still awaiting every normal path before cleanup.
    const shutdowns = records.map(record => shutdownChildSession(record.session));
    const pendingRuns = records
      .map(record => record.promise)
      .filter((promise): promise is Promise<string> => promise !== undefined);
    const settling = [...shutdowns, ...pendingRuns];
    if (settling.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>(resolve => {
        timer = setTimeout(resolve, DISPOSAL_SETTLE_TIMEOUT_MS);
        timer.unref();
      });
      await Promise.race([Promise.allSettled(settling).then(() => undefined), timeout]);
      if (timer) clearTimeout(timer);
    }

    // Every disposable record is cleaned after its run had a chance to settle.
    // This is intentionally separate from the run's callback: dispose() must
    // cover stopped, aborted, timed-out, startup-failed, and internally
    // committed runs even when their promise never reached that callback.
    for (const record of records) this.cleanupDisposableRecord(record);
    await Promise.allSettled([...this.disposableCleanupPromises.values()]);

    // No active record can retain a disposable worktree past this point.
    this.agents.clear();
    this.detachedWaiters.clear();
    this.spawnOrder.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
    // Also prune repos that caller-supplied cwds created worktrees in — a clean
    // exit with in-flight agents would otherwise leave stale registrations there.
    for (const repo of this.worktreeRepos) {
      try { pruneWorktrees(repo); } catch { /* ignore */ }
    }
  }
}
