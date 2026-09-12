import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncJsonlWriter, writeJsonAtomically, writeTextAtomically } from "../writer.js";

const event = (index: number) => ({ version: 1 as const, kind: "test", at: new Date(0).toISOString(), index });

describe("async eval writer", () => {
	it("serializes ordered events and flushes asynchronously", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-eval-writer-"));
		try {
			const path = join(root, "nested", "events.jsonl");
			const writer = new AsyncJsonlWriter(path, { maxQueueSize: 10 });
			writer.append(event(1));
			writer.append(event(2));
			writer.append(event(3));
			expect(writer.stats.queuedEvents).toBeGreaterThanOrEqual(0);
			await writer.flush();
			const lines = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { index: number });
			expect(lines.map(item => item.index)).toEqual([1, 2, 3]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("bounds the queue and contains repeated write failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-eval-writer-failure-"));
		try {
			const writer = new AsyncJsonlWriter(join(root, "events.jsonl"), {
				maxQueueSize: 2,
				maxWriteErrors: 1,
				appendFileFn: async () => { throw new Error("disk unavailable"); },
			});
			writer.append(event(1));
			writer.append(event(2));
			writer.append(event(3));
			await expect(writer.flush()).resolves.toBeTypeOf("number");
			expect(writer.stats.writeErrors).toBeGreaterThan(0);
			expect(writer.stats.disabled).toBe(true);
			expect(writer.stats.droppedEvents).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes manifests and text atomically", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-eval-atomic-"));
		try {
			const json = join(root, "manifest.json");
			const text = join(root, "report.csv");
			await writeJsonAtomically(json, { ok: true });
			await writeTextAtomically(text, "a,b\n1,2\n");
			expect(JSON.parse(await readFile(json, "utf8")).ok).toBe(true);
			expect(await readFile(text, "utf8")).toBe("a,b\n1,2\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
