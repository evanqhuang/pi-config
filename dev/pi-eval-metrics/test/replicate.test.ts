import { rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allocateRunDirectory, findExistingManifest } from "../index.js";

describe("replicate allocation", () => {
	it("allocates ordinals atomically and finds a resumed session by ID", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-eval-replicates-"));
		try {
			const paths = await Promise.all([
				allocateRunDirectory(root, "exp-test", "notes-absent", "session-a"),
				allocateRunDirectory(root, "exp-test", "notes-absent", "session-b"),
			]);
			expect(paths.map(path => path.split("/").pop()?.slice(0, 3)).sort()).toEqual(["001", "002"]);
			const manifest = {
				schemaVersion: 1,
				kind: "run-manifest",
				runId: "session-a",
			};
			await writeFile(join(paths[0], "manifest.json"), `${JSON.stringify(manifest)}\n`);
			const resumed = await findExistingManifest(root, "session-a");
			expect(resumed?.root).toBe(paths[0]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
