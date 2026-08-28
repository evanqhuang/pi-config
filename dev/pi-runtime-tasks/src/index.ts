import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { MAX_READ_BYTES, runtimeTaskRegistry } from "./hub.js";
import { ShellProvider } from "./shell-provider.js";
import type { RuntimeTaskHub, RuntimeTaskRecord } from "./types.js";

export * from "./hub.js";
export * from "./owner.js";
export * from "./shell-provider.js";
export * from "./types.js";

const MUTATING_TOOLS = new Set(["run_background_bash", "runtime_task_kill"]);
const LIST_TEXT_LIMIT = 2_000;
const WAIT_TEXT_LIMIT = 32_000;

interface RunBackgroundBashParams {
  command: string;
  description?: string;
  timeout?: number;
}

interface RuntimeTaskIdParams {
  task_id: string;
}

interface RuntimeTaskOutputParams extends RuntimeTaskIdParams {
  offset?: number;
  max_bytes?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details: {},
    isError,
  };
}

function bounded(value: string | undefined, limit: number): string | undefined {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…(truncated)`;
}

function publicRecord(record: RuntimeTaskRecord, includeResult: boolean): RuntimeTaskRecord {
  return {
    ...record,
    result: includeResult ? bounded(record.result, WAIT_TEXT_LIMIT) : undefined,
    error: bounded(record.error, LIST_TEXT_LIMIT),
  };
}

function taskNotification(record: RuntimeTaskRecord): string {
  return [
    "<task-notification>",
    `<task-id>${escapeXml(record.id)}</task-id>`,
    `<status>${escapeXml(record.status)}</status>`,
    `<summary>${escapeXml(record.description)}</summary>`,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : undefined,
    "</task-notification>",
  ].filter(Boolean).join("\n");
}

export default function runtimeTasksExtension(pi: ExtensionAPI): void {
  const registry = runtimeTaskRegistry();
  let ctx: ExtensionContext | undefined;
  let sessionId: string | undefined;
  let hub: RuntimeTaskHub | undefined;
  let shell: ShellProvider | undefined;
  let unregisterShell: (() => void) | undefined;

  pi.on("session_start", (_event, nextCtx) => {
    const nextSessionId = nextCtx.sessionManager.getSessionId();
    const nextHub = registry.createSession(nextSessionId);

    ctx = nextCtx;
    sessionId = nextSessionId;
    hub = nextHub;
    shell = new ShellProvider({
      cwd: () => ctx?.cwd ?? process.cwd(),
      outputDir: join(nextCtx.sessionManager.getSessionDir(), "runtime-tasks", nextSessionId),
      currentOwner: () => nextHub.currentOwner(),
      notify: record => {
        if (record.owner) nextHub.setDefaultOwner(record.owner);
        nextHub.withOwner(record.owner, () => {
          pi.sendMessage(
            {
              customType: "runtime-task-notification",
              content: taskNotification(record),
              display: true,
              details: {
                taskId: record.id,
                status: record.status,
                owner: record.owner,
              },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        });
      },
    });
    unregisterShell = nextHub.registerProvider(shell);
    pi.events.emit("runtime-tasks:ready", { sessionId: nextSessionId });
  });

  pi.on("agent_settled", () => {
    // Default ownership bridges a queued notification into exactly one parent
    // turn. Clearing it here prevents an old task notification from tagging
    // unrelated work after that turn has finished.
    hub?.clearDefaultOwner();
  });

  pi.on("session_shutdown", async () => {
    await shell?.dispose();
    unregisterShell?.();
    if (sessionId && hub) registry.deleteSession(sessionId, hub);

    ctx = undefined;
    sessionId = undefined;
    hub = undefined;
    shell = undefined;
    unregisterShell = undefined;
  });

  pi.on("tool_call", event => {
    if (!MUTATING_TOOLS.has(event.toolName)) return undefined;
    if (pi.getActiveTools().includes(event.toolName)) return undefined;
    return {
      block: true,
      reason: `Current mode blocks runtime mutation tool: ${event.toolName}`,
    };
  });

  pi.registerTool({
    name: "run_background_bash",
    label: "Background Bash",
    description: "Run a noninteractive Bash command as a session-owned background runtime task.",
    parameters: Type.Object({
      command: Type.String(),
      description: Type.Optional(Type.String()),
      timeout: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_toolCallId: string, params: RunBackgroundBashParams) {
      if (!pi.getActiveTools().includes("run_background_bash")) {
        return textResult("Current mode blocks run_background_bash.", true);
      }
      if (!shell) return textResult("Runtime task session is not initialized.", true);

      try {
        const record = shell.start(
          params.command,
          params.description?.trim() || params.command.slice(0, 120),
          params.timeout,
        );
        return textResult([
          "Background task started.",
          `Task ID: ${record.id}`,
          `Output file: ${record.outputFile ?? "unavailable"}`,
        ].join("\n"));
      } catch (error) {
        return textResult(
          `Failed to start background task: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    },
  });

  pi.registerTool({
    name: "runtime_task_list",
    label: "Runtime Tasks",
    description: "List executing shell and subagent jobs. Runtime tasks are separate from todo/task-list items.",
    parameters: Type.Object({}),
    async execute() {
      if (!hub) return textResult("Runtime task session is not initialized.", true);
      return textResult(JSON.stringify(hub.list().map(record => publicRecord(record, false)), null, 2));
    },
  });

  pi.registerTool({
    name: "runtime_task_output",
    label: "Runtime Task Output",
    description: "Read a bounded byte range from a runtime task output file.",
    parameters: Type.Object({
      task_id: Type.String(),
      offset: Type.Optional(Type.Number({ minimum: 0 })),
      max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_READ_BYTES })),
    }),
    async execute(_toolCallId: string, params: RuntimeTaskOutputParams) {
      if (!hub) return textResult("Runtime task session is not initialized.", true);
      const output = hub.readOutput(params.task_id, params.offset, params.max_bytes);
      if (!output) return textResult(`Task output unavailable: ${params.task_id}`, true);
      return textResult(JSON.stringify(output));
    },
  });

  pi.registerTool({
    name: "runtime_task_wait",
    label: "Wait for Runtime Task",
    description: "Wait for one runtime task to settle without polling its output.",
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_toolCallId: string, params: RuntimeTaskIdParams, signal?: AbortSignal) {
      if (!hub) return textResult("Runtime task session is not initialized.", true);
      try {
        const record = await hub.wait(params.task_id, signal);
        if (!record) return textResult(`Task not found: ${params.task_id}`, true);
        return textResult(JSON.stringify(publicRecord(record, true), null, 2));
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return textResult(`Wait aborted for ${params.task_id}.`, true);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "runtime_task_kill",
    label: "Kill Runtime Task",
    description: "Stop a running runtime task when its provider exposes a safe stop operation.",
    parameters: Type.Object({ task_id: Type.String() }),
    async execute(_toolCallId: string, params: RuntimeTaskIdParams) {
      if (!pi.getActiveTools().includes("runtime_task_kill")) {
        return textResult("Current mode blocks runtime_task_kill.", true);
      }
      if (!hub) return textResult("Runtime task session is not initialized.", true);

      const killed = await hub.kill(params.task_id);
      return killed
        ? textResult(`Stop requested for ${params.task_id}.`)
        : textResult(`Task is not running or cannot be stopped: ${params.task_id}`, true);
    },
  });
}
