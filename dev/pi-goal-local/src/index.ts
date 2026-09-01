import type {
  AutocompleteProviderFactory,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseGoalCommand, formatGoalStatus } from "./commands.js";
import { GoalController, type GoalLoopStartOptions } from "./controller.js";
import {
  loadVerifiedCorrectionPlan,
  loadVerifiedOriginalPlan,
} from "./plan-artifacts.js";
import { loadGoalLoopSettings } from "./settings.js";
import {
  createContextEpochBootstrap,
  filterContextWithDisposition,
  type ContextEpochBootstrap,
} from "./context-epoch.js";
import {
  createPlanBridge,
  type GoalPlanBridgeResult,
  type PlanBridge,
} from "./plan-bridge.js";
import {
  type GoalLoopPhase,
  type GoalStateV2,
} from "./types.js";

const LOOP_PHASES: readonly GoalLoopPhase[] = ["implementing", "verifying", "replanning"];
const GOAL_LOOP_FLAG = "goal-loop";
const GOAL_PLAN_FLAG = "goal-plan";
const GOAL_MAX_CYCLES_FLAG = "goal-max-cycles";

/** The provider type is re-exported structurally by the coding-agent package. */
type AutocompleteProvider = Parameters<AutocompleteProviderFactory>[0];
type AutocompleteResult = Awaited<ReturnType<AutocompleteProvider["getSuggestions"]>>;
type AutocompleteItem = NonNullable<AutocompleteResult>["items"][number];

type TokenSpan = {
  value: string;
  quoted: boolean;
  start: number;
  end: number;
};

export function agentRunWasAborted(messages: readonly unknown[]): boolean {
  return messages.some(message => {
    if (!message || typeof message !== "object") return false;
    const candidate = message as { role?: unknown; stopReason?: unknown };
    return candidate.role === "assistant" && candidate.stopReason === "aborted";
  });
}

function loopStateIsActive(state: GoalStateV2 | undefined): state is GoalStateV2 {
  return state !== undefined && LOOP_PHASES.includes(state.phase);
}

function resumedGoalMessage(adoptedBranch: boolean): string {
  return adoptedBranch
    ? "Goal resumed on the selected branch with a fresh context epoch."
    : "Goal resumed.";
}

/** Display all durable V2 identity fields; V1 status keeps its old format. */
export function formatGoalLoopStatus(state: GoalStateV2): string {
  const reason = state.reasons?.block ?? state.reasons?.pause ?? state.reasons?.stagnation;
  return [
    `LOOP ${state.phase.toUpperCase()}: ${state.objective}`,
    `(loop ${state.loopId}; generation ${state.generation}; cycle ${state.cycle}/${state.maxCycles}; context epoch ${state.contextEpoch})`,
    reason ? `— ${reason}` : "",
  ].filter(Boolean).join(" ");
}

function flagValue(pi: ExtensionAPI, name: string): boolean | string | undefined {
  try {
    return pi.getFlag(name);
  } catch {
    // Some lightweight RPC/test adapters do not expose registered flags.
    return undefined;
  }
}

function selectionOf(context: ExtensionContext): { sessionId: string; leafId: string | null } | undefined {
  try {
    const sessionId = context.sessionManager.getSessionId();
    const leafId = context.sessionManager.getLeafId();
    return typeof sessionId === "string" && (typeof leafId === "string" || leafId === null)
      ? { sessionId, leafId }
      : undefined;
  } catch {
    return undefined;
  }
}

function sameSelection(context: ExtensionContext, selection: { sessionId: string; leafId: string | null }): boolean {
  const current = selectionOf(context);
  return current?.sessionId === selection.sessionId && current.leafId === selection.leafId;
}

function registerLoopFlags(pi: ExtensionAPI): void {
  const api = pi as ExtensionAPI & {
    registerFlag?: ExtensionAPI["registerFlag"];
  };
  if (typeof api.registerFlag !== "function") return;
  api.registerFlag(GOAL_LOOP_FLAG, {
    type: "boolean",
    default: false,
    description: "Start a fixed-point /goal loop when the session opens",
  });
  api.registerFlag(GOAL_PLAN_FLAG, {
    type: "string",
    description: "Explicit plan source for --goal-loop (otherwise use an approved plan)",
  });
  api.registerFlag(GOAL_MAX_CYCLES_FLAG, {
    type: "string",
    description: "Maximum corrective cycles for --goal-loop",
  });
}

function parsePositiveCycles(value: boolean | string | undefined): number | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error("--goal-max-cycles must be a positive integer.");
  }
  const cycles = Number(value);
  if (!Number.isSafeInteger(cycles) || cycles < 1 || cycles > 100) {
    throw new Error("--goal-max-cycles must be a positive integer between 1 and 100.");
  }
  return cycles;
}

function goalArgumentsStart(line: string): number | undefined {
  const match = line.match(/^\/goal(?=\s|$)/u);
  if (!match || line.length === match[0].length) return undefined;
  const whitespace = line.slice(match[0].length).match(/^\s*/u)?.[0].length ?? 0;
  return match[0].length + whitespace;
}

function scanTokenSpans(input: string): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && /\s/u.test(input[index] ?? "")) index += 1;
    if (index >= input.length) break;
    const start = index;
    let value = "";
    let quoted = false;
    let quote: "'" | '"' | undefined;
    let escaped = false;
    while (index < input.length) {
      const character = input[index] as string;
      if (escaped) {
        value += character;
        escaped = false;
        quoted = true;
        index += 1;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        index += 1;
        continue;
      }
      if (quote !== undefined) {
        if (character === quote) quote = undefined;
        else value += character;
        quoted = true;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        quoted = true;
        index += 1;
        continue;
      }
      if (/\s/u.test(character)) break;
      value += character;
      index += 1;
    }
    if (escaped) value += "\\";
    tokens.push({ value, quoted, start, end: index });
  }
  return tokens;
}

/** True only while the cursor is on the value belonging to --plan. */
function isPlanValueContext(args: string): boolean {
  const tokens = scanTokenSpans(args);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.quoted) continue;
    const inline = token.value.startsWith("--plan=");
    if (token.value !== "--plan" && !inline) continue;
    if (inline) return index === tokens.length - 1 && token.end === args.length;
    const value = tokens[index + 1];
    if (!value) return true;
    if (!value.quoted && value.value.startsWith("--")) return false;
    return index + 1 === tokens.length - 1 && value.end === args.length;
  }
  return false;
}

function completionPrefix(args: string): string {
  const match = args.match(/(?:^|\s)([^\s]*)$/u);
  return match?.[1] ?? "";
}

const MANAGEMENT_ITEMS: readonly AutocompleteItem[] = [
  { value: "status", label: "status", description: "Show the current goal or loop metadata" },
  { value: "pause", label: "pause", description: "Pause autonomous continuation" },
  { value: "resume", label: "resume", description: "Resume a paused goal or loop" },
  { value: "stop", label: "stop", description: "Stop the current goal or loop" },
  { value: "clear", label: "clear", description: "Stop and clear the effective goal" },
  { value: "fresh", label: "fresh", description: "Start a fresh loop from an approved plan" },
];

const LOOP_OPTION_ITEMS: readonly AutocompleteItem[] = [
  { value: "--loop", label: "--loop", description: "Use the V2 fixed-point loop" },
  { value: "--plan ", label: "--plan <path>", description: "Use an explicit immutable plan snapshot" },
  { value: "--max-cycles ", label: "--max-cycles <n>", description: "Bound corrective replans (1-100)" },
];

function managementSuggestions(args: string): AutocompleteResult {
  const prefix = completionPrefix(args);
  const tokens = scanTokenSpans(args);
  const first = tokens[0];
  const isOptionPrefix = prefix.startsWith("--") || first?.value.startsWith("--") === true;
  const source = isOptionPrefix || tokens.length > 1 ? LOOP_OPTION_ITEMS : [...MANAGEMENT_ITEMS, ...LOOP_OPTION_ITEMS];
  const items = source.filter(item => item.value.trimStart().toLowerCase().startsWith(prefix.toLowerCase()));
  return items.length > 0 ? { items: [...items], prefix } : null;
}

/** Adapt the token-local suggestions to Pi's slash-command completion API. */
function commandArgumentSuggestions(args: string): AutocompleteResult {
  const result = managementSuggestions(args);
  if (!result) return null;
  const tokenStart = args.search(/\S+$/u);
  const completedPrefix = tokenStart < 0 ? args : args.slice(0, tokenStart);
  return {
    items: result.items.map(item => ({ ...item, value: `${completedPrefix}${item.value}` })),
    prefix: args,
  };
}

function withGoalAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
  const provider: AutocompleteProvider = {
    ...current,
    triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), " ", "-"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? "";
      const textBeforeCursor = line.slice(0, cursorCol);
      const argsStart = goalArgumentsStart(textBeforeCursor);
      if (argsStart === undefined) return current.getSuggestions(lines, cursorLine, cursorCol, options);
      const args = textBeforeCursor.slice(argsStart);
      if (isPlanValueContext(args)) {
        // CombinedAutocompleteProvider deliberately treats all /goal arguments
        // as command arguments. Re-run it without /goal so its ordinary file
        // provider remains authoritative for --plan paths.
        const pathLines = [...lines];
        pathLines[cursorLine] = line.slice(argsStart);
        return current.getSuggestions(pathLines, cursorLine, cursorCol - argsStart, options);
      }
      return managementSuggestions(args);
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? "";
      const textBeforeCursor = line.slice(0, cursorCol);
      const argsStart = goalArgumentsStart(textBeforeCursor);
      if (argsStart === undefined) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      if (isPlanValueContext(textBeforeCursor.slice(argsStart))) {
        const pathLines = [...lines];
        pathLines[cursorLine] = line.slice(argsStart);
        const applied = current.applyCompletion(pathLines, cursorLine, cursorCol - argsStart, item, prefix);
        const resultLines = [...applied.lines];
        resultLines[cursorLine] = `${line.slice(0, argsStart)}${resultLines[cursorLine] ?? ""}`;
        return { ...applied, lines: resultLines, cursorCol: applied.cursorCol + argsStart };
      }
      const beforePrefix = line.slice(0, Math.max(0, cursorCol - prefix.length));
      const afterCursor = line.slice(cursorCol);
      const resultLines = [...lines];
      resultLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;
      return {
        lines: resultLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length,
      };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? "";
      const argsStart = goalArgumentsStart(line.slice(0, cursorCol));
      if (argsStart !== undefined && isPlanValueContext(line.slice(argsStart, cursorCol))) return true;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
  return provider;
}

function notifyLoopStart(ctx: ExtensionContext, state: GoalStateV2): void {
  if (!ctx.hasUI) return;
  ctx.ui.notify(
    state.phase === "blocked"
      ? `Goal loop blocked: ${state.reasons?.block ?? "unsafe loop start"}`
      : `Goal loop active: ${state.objective}`,
    state.phase === "blocked" ? "error" : "info",
  );
}

async function startResolvedLoop(
  controller: GoalController,
  ctx: ExtensionContext,
  plan: GoalPlanBridgeResult,
  objective: string,
  criteria: string[],
  maxCycles?: number,
): Promise<GoalStateV2> {
  const options: GoalLoopStartOptions = {
    loop: true,
    sourceKind: plan.sourceKind,
    sourcePath: plan.sourcePath,
    maxCycles,
    ...(plan.sourceKind === "approved"
      ? {
        strategy: plan.strategy,
        prewalkReady: plan.strategy === "PREWALK",
      }
      : {}),
  };
  return controller.startLoop(ctx, objective, criteria, options);
}

class ContextBootstrapSupersededError extends Error {
  constructor() {
    super("Goal loop context bootstrap was superseded by a lifecycle transition.");
    this.name = "ContextBootstrapSupersededError";
  }
}

function requireCurrentContextBootstrap(guard: () => boolean): void {
  if (!guard()) throw new ContextBootstrapSupersededError();
}

/** Rebuild the self-contained fallback used before an async marker arrives. */
async function contextBootstrap(
  ctx: ExtensionContext,
  state: GoalStateV2,
  guard: () => boolean,
): Promise<ContextEpochBootstrap> {
  requireCurrentContextBootstrap(guard);
  const settings = loadGoalLoopSettings(ctx.cwd);
  const original = await loadVerifiedOriginalPlan({
    loopId: state.loopId,
    provenance: state.plan,
    maxBytes: settings.maxPlanBytes,
  });
  requireCurrentContextBootstrap(guard);
  let correction;
  if (state.verifier?.correctionPath && state.verifier.correctionHash) {
    const artifact = await loadVerifiedCorrectionPlan({
      loopId: state.loopId,
      cycle: state.cycle,
      path: state.verifier.correctionPath,
      correctionHash: state.verifier.correctionHash,
      maxCycles: state.maxCycles,
      maxBytes: settings.maxCorrectionBytes,
    });
    requireCurrentContextBootstrap(guard);
    correction = { path: artifact.path, hash: artifact.hash, content: artifact.content };
  }
  requireCurrentContextBootstrap(guard);
  const bootstrap = createContextEpochBootstrap({
    state,
    originalPlan: { path: original.path, hash: original.hash, content: original.content },
    correction,
    verifier: {
      discrepancies: state.verifier?.outcome === "replan"
        ? [`Apply the corrective plan for cycle ${state.cycle} and re-check the acceptance criteria.`]
        : [],
      requiredValidation: ["Re-run the focused checks required by the acceptance criteria."],
    },
    capabilityGuidance: [
      "Use the main session's currently selected PLAN / ORCHESTRATOR / YOLO mode and available tools. Do not assume unavailable capabilities. Goal evaluation itself cannot mutate through GoalJudge; GoalVerifier is read-only acceptance verification.",
    ],
    continuationInstruction: state.strategy === "PREWALK"
      ? "PREWALK strategy is authoritative; continue only with the approved PREWALK execution path."
      : "Continue implementing the current immutable plan, then stop for GoalJudge and independent GoalVerifier evaluation.",
    maxBootstrapBytes: settings.maxBootstrapBytes,
  });
  requireCurrentContextBootstrap(guard);
  return bootstrap;
}

export default function goalExtension(pi: ExtensionAPI): void {
  const controller = new GoalController(pi);
  const bridge: PlanBridge = createPlanBridge(pi.events);
  registerLoopFlags(pi);

  let ctx: ExtensionContext | undefined;
  let currentRunAborted = false;
  let autocompleteInstalled = false;
  let cliDispatchStarted = false;
  let shutDown = false;
  let selectionGeneration = 0;
  let deferredResume: { sessionId: string; selectionGeneration: number } | undefined;

  const invalidateDeferredResume = (): void => {
    selectionGeneration += 1;
    deferredResume = undefined;
  };
  const eventUnsubscribers: Array<() => void> = [];

  pi.on("session_start", (_event, nextCtx) => {
    if (shutDown) return;
    invalidateDeferredResume();
    ctx = nextCtx;
    controller.restore(nextCtx);
    if (!autocompleteInstalled && typeof nextCtx.ui?.addAutocompleteProvider === "function") {
      nextCtx.ui.addAutocompleteProvider(withGoalAutocomplete);
      autocompleteInstalled = true;
    }

    if (cliDispatchStarted) return;
    const cliLoop = flagValue(pi, GOAL_LOOP_FLAG) === true;
    const planFlag = flagValue(pi, GOAL_PLAN_FLAG);
    const cyclesFlag = flagValue(pi, GOAL_MAX_CYCLES_FLAG);
    const hasCliPlan = typeof planFlag === "string" && planFlag.trim().length > 0;
    const hasCliCycles = cyclesFlag !== undefined && cyclesFlag !== false;
    if (!cliLoop && !hasCliPlan && !hasCliCycles) return;
    cliDispatchStarted = true;
    void (async () => {
      try {
        const maxCycles = parsePositiveCycles(cyclesFlag);
        const plan = await bridge.resolvePlan({ explicitPlanPath: hasCliPlan ? planFlag as string : undefined });
        if (!plan) throw new Error("No approved plan is available; supply --goal-plan or approve a plan in PLAN mode.");
        if (!ctx || !sameSelection(ctx, selectionOf(nextCtx) ?? { sessionId: "", leafId: null })) {
          throw new Error("Goal loop start was superseded by session navigation.");
        }
        const state = await startResolvedLoop(controller, ctx, plan, "Implement the referenced plan.", [], maxCycles);
        notifyLoopStart(ctx, state);
      } catch (error) {
        if (nextCtx.hasUI) nextCtx.ui.notify(`Goal loop could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    })();
  });

  pi.on("session_before_switch", () => {
    invalidateDeferredResume();
    controller.prepareForNavigation();
  });

  pi.on("session_before_fork", () => {
    invalidateDeferredResume();
    controller.prepareForNavigation();
  });

  pi.on("session_before_tree", (_event, treeCtx) => {
    invalidateDeferredResume();
    controller.prepareForTreeNavigation(treeCtx);
  });

  pi.on("session_before_compact", () => {
    invalidateDeferredResume();
  });

  pi.on("session_tree", (_event, treeCtx) => {
    ctx = treeCtx;
    controller.restoreSelectedBranch(treeCtx);
  });

  pi.on("session_compact", (_event, compactCtx) => {
    if (shutDown) return;
    invalidateDeferredResume();
    ctx = compactCtx;
    // Compaction is a valid context boundary, but it is not tree navigation.
    // Keep its existing active-loop rebootstrap behavior without granting the
    // tree-selection-only resume reanchor eligibility.
    controller.restoreAfterCompaction(compactCtx);
  });

  pi.on("context", async (event, contextCtx) => {
    if (shutDown) return;
    // Context callbacks can receive a fresh wrapper around the same runtime.
    // Keep the lifecycle-selected context authoritative so provider filtering
    // cannot change the controller's session/leaf identity mid-evaluation.
    if (ctx && contextCtx !== ctx) {
      const selected = selectionOf(ctx);
      const incoming = selectionOf(contextCtx);
      if (selected && incoming && (selected.sessionId !== incoming.sessionId || selected.leafId !== incoming.leafId)) return { messages: [] };
    }
    const activeCtx = ctx ?? contextCtx;
    if (!ctx) ctx = contextCtx;
    const loop = controller.refreshLoop(activeCtx);
    if (!loopStateIsActive(loop)) return;
    const lifecycleGuard = controller.createLoopContextGuard(activeCtx, loop);
    // Navigation may have selected this loop between refreshLoop and guard
    // capture. Do not filter or return a fallback without a bounded proof.
    if (!lifecycleGuard) return { messages: [] };
    try {
      const anchored = filterContextWithDisposition(event.messages, loop);
      if (anchored.disposition === "matched") return { messages: anchored.messages };
      if (anchored.disposition === "rejected") {
        // Integrity failures are not evidence that an explicit tree branch may
        // safely adopt a fresh epoch. Keep this path fail-closed.
        controller.invalidateLoopReanchorEligibility();
        controller.pause(activeCtx, `Paused because goal-loop context continuity was unsafe: ${anchored.reason ?? "incomplete current epoch traffic."}`);
        activeCtx.abort();
        return { messages: [] };
      }

      // startLoop publishes its durable state before its asynchronous artifact
      // read can publish the first marker. Build a verified fallback here so a
      // kickoff provider request cannot see stale context or lose its latest
      // complete user-led turn during that small publication window.
      const bootstrap = await contextBootstrap(activeCtx, loop, lifecycleGuard);
      requireCurrentContextBootstrap(lifecycleGuard);
      const settings = loadGoalLoopSettings(activeCtx.cwd);
      const fallback = filterContextWithDisposition(event.messages, loop, {
        bootstrap,
        maxBootstrapBytes: settings.maxBootstrapBytes,
      });
      if (fallback.disposition === "fallback-safe") return { messages: fallback.messages };
      if (fallback.disposition === "fallback-unsafe"
        && fallback.reason === "No safe complete user-led turn suffix was established; automatic continuation must pause.") {
        // This is the one expected gap after explicit tree navigation: the
        // branch has no current marker and no complete user-led suffix yet.
        // pause() retains eligibility only when its tree carry proof matches.
        controller.pause(activeCtx, `Paused because goal-loop context continuity was unsafe: ${fallback.reason}`);
      } else {
        // A second-pass rejection means stale, malformed, conflicting, or
        // otherwise invalid marker/bootstrap integrity—not a safe tree gap.
        controller.invalidateLoopReanchorEligibility();
        controller.pause(activeCtx, `Paused because goal-loop context continuity was unsafe: ${fallback.reason ?? "no complete current suffix."}`);
      }
      activeCtx.abort();
      return { messages: [] };
    } catch (error) {
      // A lifecycle transition superseding an artifact read must not mutate the
      // newly selected state or abort its run. It also must not return the
      // stale fallback that the read was preparing.
      if (error instanceof ContextBootstrapSupersededError || !lifecycleGuard()) return { messages: [] };
      // A valid state with an invalid epoch payload or unavailable artifact
      // must not leak prior-cycle context to the provider. Fail closed with no
      // messages and terminate the active run.
      controller.invalidateLoopReanchorEligibility();
      controller.pause(activeCtx, `Paused because goal-loop context continuity was unsafe: ${error instanceof Error ? error.message : String(error)}`);
      activeCtx.abort();
      if (activeCtx.hasUI) {
        activeCtx.ui.notify(`Goal loop context was rejected: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      return { messages: [] };
    }
  });

  pi.on("session_shutdown", () => {
    shutDown = true;
    bridge.dispose();
    while (eventUnsubscribers.length > 0) {
      try { eventUnsubscribers.pop()?.(); } catch {}
    }
    controller.shutdown();
    invalidateDeferredResume();
    ctx = undefined;
    currentRunAborted = false;
  });

  pi.registerCommand("goal", {
    description: "Set or manage an autonomous branch-aware completion goal",
    getArgumentCompletions: argumentPrefix => {
      const result = commandArgumentSuggestions(argumentPrefix);
      return result?.items ?? null;
    },
    handler: async (args, commandCtx) => {
      if (!ctx) {
        commandCtx.ui.notify("No active session is available for /goal.", "error");
        return;
      }
      const activeCtx = ctx;
      let command;
      try {
        command = parseGoalCommand(args);
      } catch (error) {
        commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      switch (command.kind) {
        case "status": {
          const marker = controller.refreshMarker(activeCtx);
          commandCtx.ui.notify(
            marker?.schemaVersion === 2 ? formatGoalLoopStatus(marker) : formatGoalStatus(controller.current),
            "info",
          );
          return;
        }
        case "start": {
          deferredResume = undefined;
          const wantsLoop = command.loop === true
            || command.planPath !== undefined
            || command.maxCycles !== undefined;
          if (!wantsLoop) {
            controller.start(activeCtx, command.objective, command.criteria);
            commandCtx.ui.notify(`Goal active: ${command.objective}`, "info");
            return;
          }
          try {
            const selection = selectionOf(activeCtx);
            const plan = await bridge.resolvePlan({ explicitPlanPath: command.planPath });
            if (!plan) throw new Error("A V2 goal loop needs --plan or an approved plan from PLAN mode.");
            if (!ctx || !selection || !sameSelection(ctx, selection)) {
              throw new Error("Goal loop start was superseded by session navigation.");
            }
            const next = await startResolvedLoop(controller, ctx, plan, command.objective, command.criteria, command.maxCycles);
            commandCtx.ui.notify(
              next.phase === "blocked"
                ? `Goal loop blocked: ${next.reasons?.block ?? "unsafe loop start"}`
                : `Goal loop active: ${next.objective}`,
              next.phase === "blocked" ? "error" : "info",
            );
          } catch (error) {
            commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        case "fresh": {
          deferredResume = undefined;
          try {
            const selection = selectionOf(activeCtx);
            const plan = await bridge.resolvePlan();
            if (!plan) throw new Error("No approved plan is available for /goal fresh.");
            if (!ctx || !selection || !sameSelection(ctx, selection)) {
              throw new Error("Goal loop start was superseded by session navigation.");
            }
            const next = await startResolvedLoop(controller, ctx, plan, "Implement the referenced plan.", []);
            commandCtx.ui.notify(`Fresh goal loop active: ${next.objective}`, "info");
          } catch (error) {
            commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        case "pause": {
          deferredResume = undefined;
          const next = controller.pause(activeCtx);
          commandCtx.ui.notify(next ? "Goal paused." : "There is no active goal to pause.", next ? "info" : "warning");
          return;
        }
        case "resume": {
          try {
            if (!activeCtx.isIdle() || activeCtx.hasPendingMessages()) {
              const marker = controller.refreshMarker(activeCtx);
              const resumable = marker?.schemaVersion === 2
                ? marker.phase === "paused"
                : marker?.status === "paused";
              const selection = selectionOf(activeCtx);
              if (!resumable || !selection) {
                deferredResume = undefined;
                commandCtx.ui.notify("There is no paused goal to resume.", "warning");
                return;
              }
              deferredResume = {
                sessionId: selection.sessionId,
                selectionGeneration,
              };
              commandCtx.ui.notify("Goal resume queued until the current agent turn settles.", "info");
              return;
            }
            deferredResume = undefined;
            const next = await Promise.resolve(controller.resume(activeCtx));
            const adoptedBranch = controller.consumeResumeAdoptedBranch();
            commandCtx.ui.notify(
              next ? resumedGoalMessage(adoptedBranch) : "There is no paused goal to resume.",
              next ? "info" : "warning",
            );
          } catch (error) {
            commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
          return;
        }
        case "stop": {
          deferredResume = undefined;
          const next = controller.stop(activeCtx);
          commandCtx.ui.notify(next ? "Goal stopped." : "There is no goal to stop.", next ? "info" : "warning");
          return;
        }
        case "clear": {
          deferredResume = undefined;
          const next = controller.clear(activeCtx);
          commandCtx.ui.notify(next ? "Goal cleared." : "There is no goal to clear.", next ? "info" : "warning");
          return;
        }
      }
    },
  });

  pi.on("agent_start", () => {
    currentRunAborted = false;
  });

  pi.on("agent_end", (event) => {
    currentRunAborted ||= agentRunWasAborted(event.messages);
  });

  pi.on("agent_settled", async (_event, settledCtx) => {
    if (shutDown) return;
    ctx = settledCtx;
    const aborted = currentRunAborted;
    currentRunAborted = false;

    const pendingResume = deferredResume;
    if (pendingResume) {
      const selection = selectionOf(settledCtx);
      const stillSelected = selection?.sessionId === pendingResume.sessionId
        && selectionGeneration === pendingResume.selectionGeneration;
      if (!stillSelected) {
        deferredResume = undefined;
      } else {
        if (!settledCtx.isIdle() || settledCtx.hasPendingMessages()) return;
        deferredResume = undefined;
        try {
          const next = await Promise.resolve(controller.resume(settledCtx));
          const adoptedBranch = controller.consumeResumeAdoptedBranch();
          if (settledCtx.hasUI) {
            settledCtx.ui.notify(
              next ? resumedGoalMessage(adoptedBranch) : "The queued goal resume was no longer applicable.",
              next ? "info" : "warning",
            );
          }
        } catch (error) {
          if (settledCtx.hasUI) {
            settledCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          }
        }
        return;
      }
    }

    if (aborted) {
      const paused = controller.pause(settledCtx);
      if (paused && settledCtx.hasUI) {
        settledCtx.ui.notify("Goal paused because the agent run was aborted.", "warning");
      }
      return;
    }
    // A wake that is still waiting for readiness is handled too; only fall
    // through when there was no pending wake (or it was invalidated).
    if (!controller.retryPendingWake(settledCtx)) controller.requestEvaluation(settledCtx);
  });

  for (const channel of ["subagents:completed", "subagents:failed"]) {
    const unsubscribe = pi.events.on(channel, () => controller.scheduleSubagentWake());
    if (typeof unsubscribe === "function") eventUnsubscribers.push(unsubscribe);
  }
}
