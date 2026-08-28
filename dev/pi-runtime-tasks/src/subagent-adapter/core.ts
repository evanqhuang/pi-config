import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export interface RuntimeTaskOwner {
  goalId: string;
  goalGeneration: number;
}

export interface AgentRecordLike {
  id: string;
  type?: string;
  description: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
  outputFile?: string;
  resultConsumed?: boolean;
  promise?: Promise<unknown>;
  startGate?: Promise<void>;
  abortController?: AbortController;
}

export interface AgentRuntimeMetadata {
  sessionId: string;
  generation: number;
  owner?: RuntimeTaskOwner;
}

export interface RuntimeTaskRecord {
  id: string;
  kind: string;
  status: "pending" | "running" | "completed" | "failed" | "killed";
  description: string;
  startedAt: number;
  completedAt?: number;
  generation: number;
  outputFile?: string;
  result?: string;
  error?: string;
  owner?: RuntimeTaskOwner;
  notified: boolean;
}

export function extractAgentId(details: unknown, content: readonly unknown[]): string | undefined {
  if (details && typeof details === "object") {
    const agentId = (details as { agentId?: unknown }).agentId;
    if (typeof agentId === "string" && agentId) return agentId;
  }

  const text = content
    .map(part => {
      if (!part || typeof part !== "object") return "";
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("\n");
  return text.match(/(?:Agent|Task) ID:\s*([A-Za-z0-9._-]+)/i)?.[1];
}

export function mapAgentStatus(status: string): RuntimeTaskRecord["status"] {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "completed":
    case "steered":
      return "completed";
    case "stopped":
    case "aborted":
      return "killed";
    default:
      return "failed";
  }
}

export function toRuntimeTask(
  record: AgentRecordLike,
  metadata: AgentRuntimeMetadata,
): RuntimeTaskRecord {
  return {
    id: record.id,
    kind: "local_agent",
    status: mapAgentStatus(record.status),
    description: record.description,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    generation: metadata.generation,
    outputFile: record.outputFile,
    result: record.result,
    error: record.error,
    owner: metadata.owner,
    notified: Boolean(record.resultConsumed),
  };
}

function abortError(): Error {
  const error = new Error("Runtime task wait aborted");
  error.name = "AbortError";
  return error;
}

async function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);

    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function waitForAgent(record: AgentRecordLike, signal?: AbortSignal): Promise<void> {
  try {
    if (record.startGate) await awaitWithSignal(record.startGate, signal);
    if (record.promise) await awaitWithSignal(record.promise, signal);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    // AgentManager records terminal failures on the record. Runtime wait should
    // return that record rather than convert the provider failure into a tool crash.
  }
}

export function readAgentOutput(
  record: AgentRecordLike,
  offset: number,
  maxBytes: number,
): { text: string; nextOffset: number; eof: boolean } | undefined {
  if (!record.outputFile) return undefined;

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = openSync(record.outputFile, constants.O_RDONLY | noFollow);
    const size = fstatSync(fd).size;
    const start = Math.min(offset, size);
    const length = Math.min(maxBytes, size - start);
    const buffer = Buffer.alloc(length);
    if (length > 0) readSync(fd, buffer, 0, length, start);
    const terminal = record.status !== "queued" && record.status !== "running";
    return {
      text: buffer.toString("utf8"),
      nextOffset: start + length,
      eof: terminal && start + length >= size,
    };
  } catch {
    return {
      text: "",
      nextOffset: 0,
      eof: record.status !== "queued" && record.status !== "running",
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
