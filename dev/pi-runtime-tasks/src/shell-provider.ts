import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { isTerminalRuntimeTaskStatus } from "./hub.js";
import type {
  RuntimeTaskOutput,
  RuntimeTaskProvider,
  RuntimeTaskRecord,
  RuntimeTaskStatus,
} from "./types.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER = "\n[pi-runtime-tasks: output limit reached; further output discarded]\n";
const STOP_GRACE_MS = 2_000;

interface ShellTaskControl {
  child?: ChildProcess;
  output: WriteStream;
  streams: Readable[];
  pausedStreams: Set<Readable>;
  outputBytes: number;
  outputTruncated: boolean;
  requestedStatus?: RuntimeTaskStatus;
  timeout?: ReturnType<typeof setTimeout>;
  stopFallback?: ReturnType<typeof setTimeout>;
  finalizeStarted: boolean;
}

export interface ShellProviderOptions {
  cwd: () => string;
  outputDir: string;
  notify: (record: RuntimeTaskRecord) => void;
  currentOwner: () => RuntimeTaskRecord["owner"];
  maxOutputBytes?: number;
}

function abortError(): Error {
  const error = new Error("Runtime task wait aborted");
  error.name = "AbortError";
  return error;
}

export class ShellProvider implements RuntimeTaskProvider {
  readonly name = "shell";

  private readonly tasks = new Map<string, RuntimeTaskRecord>();
  private readonly controls = new Map<string, ShellTaskControl>();
  private readonly waiters = new Map<string, Set<(record: RuntimeTaskRecord) => void>>();
  private suppressNotifications = false;

  constructor(private readonly options: ShellProviderOptions) {
    mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
  }

  list(): RuntimeTaskRecord[] {
    return [...this.tasks.values()];
  }

  get(id: string): RuntimeTaskRecord | undefined {
    return this.tasks.get(id);
  }

  wait(id: string, signal?: AbortSignal): Promise<RuntimeTaskRecord | undefined> {
    const record = this.tasks.get(id);
    if (!record || isTerminalRuntimeTaskStatus(record.status)) return Promise.resolve(record);

    return new Promise<RuntimeTaskRecord>((resolve, reject) => {
      const callbacks = this.waiters.get(id) ?? new Set<(value: RuntimeTaskRecord) => void>();
      const settle = (value: RuntimeTaskRecord) => {
        cleanup();
        resolve(value);
      };
      const abort = () => {
        cleanup();
        reject(abortError());
      };
      const cleanup = () => {
        callbacks.delete(settle);
        signal?.removeEventListener("abort", abort);
      };

      callbacks.add(settle);
      this.waiters.set(id, callbacks);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  kill(id: string): boolean {
    const record = this.tasks.get(id);
    const control = this.controls.get(id);
    if (!record || !control || isTerminalRuntimeTaskStatus(record.status)) return false;
    this.requestStop(record, control, "killed");
    return true;
  }

  readOutput(id: string, offset: number, maxBytes: number): RuntimeTaskOutput | undefined {
    const record = this.tasks.get(id);
    if (!record?.outputFile) return undefined;

    const noFollow = constants.O_NOFOLLOW ?? 0;
    let fd: number | undefined;
    try {
      fd = openSync(record.outputFile, constants.O_RDONLY | noFollow);
      const size = fstatSync(fd).size;
      const start = Math.min(offset, size);
      const length = Math.min(maxBytes, size - start);
      const buffer = Buffer.alloc(length);
      if (length > 0) readSync(fd, buffer, 0, length, start);
      return {
        text: buffer.toString("utf8"),
        nextOffset: start + length,
        eof: start + length >= size && isTerminalRuntimeTaskStatus(record.status),
      };
    } catch {
      return { text: "", nextOffset: 0, eof: isTerminalRuntimeTaskStatus(record.status) };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  start(command: string, description: string, timeoutSeconds?: number): RuntimeTaskRecord {
    const id = randomUUID();
    const outputFile = join(this.options.outputDir, `${id}.output`);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const fd = openSync(
      outputFile,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    const output = createWriteStream(outputFile, { fd, autoClose: true });
    const record: RuntimeTaskRecord = {
      id,
      kind: "local_bash",
      status: "running",
      description,
      startedAt: Date.now(),
      generation: 1,
      outputFile,
      owner: this.options.currentOwner(),
      notified: false,
    };
    const control: ShellTaskControl = {
      output,
      streams: [],
      pausedStreams: new Set(),
      outputBytes: 0,
      outputTruncated: false,
      finalizeStarted: false,
    };

    this.tasks.set(id, record);
    this.controls.set(id, control);

    output.once("error", error => {
      record.error = `output:${error.message}`;
      this.requestStop(record, control, "failed");
    });

    try {
      const child = spawn("bash", ["-lc", command], {
        cwd: this.options.cwd(),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      control.child = child;

      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue;
        control.streams.push(stream);
        stream.on("data", chunk => this.writeOutput(control, Buffer.from(chunk)));
      }

      output.on("drain", () => {
        for (const stream of control.pausedStreams) stream.resume();
        control.pausedStreams.clear();
      });

      child.once("error", error => {
        record.error = error.message;
        this.finalizeAfterOutput(record, control, control.requestedStatus ?? "failed");
      });
      child.once("close", code => {
        const status = control.requestedStatus ?? (code === 0 ? "completed" : "failed");
        if (status === "failed" && !record.error) record.error = `exit:${code ?? "unknown"}`;
        this.finalizeAfterOutput(record, control, status);
      });
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      this.finalizeAfterOutput(record, control, "failed");
    }

    if (timeoutSeconds && timeoutSeconds > 0 && !isTerminalRuntimeTaskStatus(record.status)) {
      control.timeout = setTimeout(() => {
        record.error = `timeout:${timeoutSeconds}`;
        this.requestStop(record, control, "killed");
      }, timeoutSeconds * 1_000);
      control.timeout.unref?.();
    }

    return record;
  }

  async dispose(): Promise<void> {
    this.suppressNotifications = true;
    const running = [...this.tasks.values()].filter(record => !isTerminalRuntimeTaskStatus(record.status));
    for (const record of running) this.kill(record.id);

    await Promise.race([
      Promise.all(running.map(record => this.wait(record.id).catch(() => undefined))),
      new Promise<void>(resolve => setTimeout(resolve, STOP_GRACE_MS)),
    ]);

    for (const record of running) {
      if (isTerminalRuntimeTaskStatus(record.status)) continue;
      const control = this.controls.get(record.id);
      if (control) this.forceFinish(record, control, "killed");
    }
  }

  private requestStop(
    record: RuntimeTaskRecord,
    control: ShellTaskControl,
    status: RuntimeTaskStatus,
  ): void {
    if (isTerminalRuntimeTaskStatus(record.status)) return;
    control.requestedStatus = status;

    let signalled = false;
    const child = control.child;
    if (child?.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
        signalled = true;
      } catch {
        // Fall through to direct-child termination.
      }
    }
    if (!signalled && child) {
      try {
        signalled = child.kill("SIGKILL");
      } catch {
        signalled = false;
      }
    }

    if (!child || !signalled) {
      this.finalizeAfterOutput(record, control, status);
      return;
    }

    if (!control.stopFallback) {
      control.stopFallback = setTimeout(() => this.forceFinish(record, control, status), STOP_GRACE_MS);
      control.stopFallback.unref?.();
    }
  }

  private writeOutput(control: ShellTaskControl, chunk: Buffer): void {
    if (control.output.destroyed || control.output.closed) return;

    const maxBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const remaining = Math.max(0, maxBytes - control.outputBytes);
    if (remaining > 0) {
      const slice = chunk.subarray(0, remaining);
      control.outputBytes += slice.length;
      if (!control.output.write(slice)) {
        for (const stream of control.streams) {
          stream.pause();
          control.pausedStreams.add(stream);
        }
      }
    }

    if (chunk.length > remaining && !control.outputTruncated) {
      control.outputTruncated = true;
      control.output.write(OUTPUT_TRUNCATED_MARKER);
    }
  }

  private finalizeAfterOutput(
    record: RuntimeTaskRecord,
    control: ShellTaskControl,
    status: RuntimeTaskStatus,
  ): void {
    if (control.finalizeStarted || isTerminalRuntimeTaskStatus(record.status)) return;
    control.finalizeStarted = true;
    if (control.timeout) clearTimeout(control.timeout);
    if (control.stopFallback) clearTimeout(control.stopFallback);

    if (control.output.closed || control.output.destroyed) {
      this.finish(record, status);
      return;
    }

    control.output.end(() => this.finish(record, status));
  }

  private forceFinish(
    record: RuntimeTaskRecord,
    control: ShellTaskControl,
    status: RuntimeTaskStatus,
  ): void {
    if (isTerminalRuntimeTaskStatus(record.status)) return;
    if (control.timeout) clearTimeout(control.timeout);
    if (control.stopFallback) clearTimeout(control.stopFallback);
    control.output.destroy();
    this.finish(record, status);
  }

  private finish(record: RuntimeTaskRecord, status: RuntimeTaskStatus): void {
    if (isTerminalRuntimeTaskStatus(record.status)) return;

    record.status = status;
    record.completedAt = Date.now();
    this.controls.delete(record.id);

    for (const resolve of this.waiters.get(record.id) ?? []) resolve(record);
    this.waiters.delete(record.id);

    if (!record.notified && !this.suppressNotifications) {
      record.notified = true;
      try {
        this.options.notify(record);
      } catch {
        // A stale UI/session notification must not change the task's terminal state.
      }
    }
  }
}
