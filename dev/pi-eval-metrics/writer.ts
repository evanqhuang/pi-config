import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EvalEvent } from "./core.js";

export interface WriterStats {
	droppedEvents: number;
	writeErrors: number;
	malformedEvents: number;
	disabled: boolean;
	queuedEvents: number;
}

export interface AsyncJsonlWriterOptions {
	maxQueueSize?: number;
	maxWriteErrors?: number;
	appendFileFn?: typeof appendFile;
	prepareDirectoryFn?: typeof mkdir;
}

/**
 * A deliberately small, fire-and-forget JSONL writer. Event handlers only
 * serialize and enqueue; all filesystem work happens on the serialized pump.
 */
export class AsyncJsonlWriter {
	private readonly maxQueueSize: number;
	private readonly maxWriteErrors: number;
	private readonly appendFileFn: typeof appendFile;
	private readonly prepareDirectoryFn: typeof mkdir;
	private readonly queue: string[] = [];
	private ready: Promise<void>;
	private pumpPromise: Promise<void> | undefined;
	private writeErrorStreak = 0;
	private closed = false;
	private statsValue: WriterStats = {
		droppedEvents: 0,
		writeErrors: 0,
		malformedEvents: 0,
		disabled: false,
		queuedEvents: 0,
	};

	constructor(private readonly filePath: string, options: AsyncJsonlWriterOptions = {}) {
		this.maxQueueSize = options.maxQueueSize ?? 256;
		this.maxWriteErrors = options.maxWriteErrors ?? 3;
		this.appendFileFn = options.appendFileFn ?? appendFile;
		this.prepareDirectoryFn = options.prepareDirectoryFn ?? mkdir;
		this.ready = this.prepareDirectoryFn(dirname(filePath), { recursive: true }).then(() => undefined);
		void this.ready.catch(() => {
			this.statsValue.writeErrors += 1;
			this.statsValue.disabled = true;
		});
	}

	get path(): string {
		return this.filePath;
	}

	get stats(): WriterStats {
		return { ...this.statsValue };
	}

	append(event: EvalEvent): void {
		if (this.closed || this.statsValue.disabled) {
			this.statsValue.droppedEvents += 1;
			return;
		}
		let line: string;
		try {
			line = `${JSON.stringify(event)}\n`;
			if (!line || line.includes("[object Object]")) throw new Error("malformed event");
		} catch {
			this.statsValue.malformedEvents += 1;
			return;
		}
		if (this.queue.length >= this.maxQueueSize) {
			this.statsValue.droppedEvents += 1;
			return;
		}
		this.queue.push(line);
		this.statsValue.queuedEvents = this.queue.length;
		this.pumpPromise ??= this.pump();
	}

	async flush(): Promise<number> {
		const started = Date.now();
		await this.ready.catch(() => undefined);
		await this.pumpPromise?.catch(() => undefined);
		while (this.queue.length > 0 && !this.statsValue.disabled) {
			this.pumpPromise ??= this.pump();
			await this.pumpPromise.catch(() => undefined);
		}
		return Date.now() - started;
	}

	close(): void {
		this.closed = true;
	}

	private async pump(): Promise<void> {
		try {
			await this.ready;
			while (this.queue.length > 0 && !this.statsValue.disabled) {
				const line = this.queue.shift();
				this.statsValue.queuedEvents = this.queue.length;
				if (line === undefined) break;
				try {
					await this.appendFileFn(this.filePath, line, "utf8");
					this.writeErrorStreak = 0;
				} catch {
					this.statsValue.writeErrors += 1;
					this.writeErrorStreak += 1;
					if (this.writeErrorStreak >= this.maxWriteErrors) {
						this.statsValue.disabled = true;
						this.statsValue.droppedEvents += this.queue.length + 1;
						this.queue.length = 0;
						this.statsValue.queuedEvents = 0;
					}
				}
			}
		} catch {
			this.statsValue.writeErrors += 1;
			this.statsValue.disabled = true;
			this.statsValue.droppedEvents += this.queue.length;
			this.queue.length = 0;
			this.statsValue.queuedEvents = 0;
		} finally {
			this.pumpPromise = undefined;
			if (this.queue.length > 0 && !this.statsValue.disabled) this.pumpPromise = this.pump();
		}
	}
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await writeTextAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomically(filePath: string, text: string): Promise<void> {
	const directory = dirname(filePath);
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `.${filePath.split("/").pop() ?? "manifest"}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
		await rename(temporary, filePath);
	} finally {
		try {
			await import("node:fs/promises").then(fs => fs.unlink(temporary));
		} catch {
			// The rename succeeded, or the temp file was never created.
		}
	}
}
