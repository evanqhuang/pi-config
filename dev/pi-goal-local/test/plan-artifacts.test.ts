import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CORRECTION_PLAN_FILENAME,
  ORIGINAL_PLAN_FILENAME,
  PlanArtifactError,
  getGoalLoopArtifactDirectory,
  loadVerifiedCorrectionPlan,
  loadVerifiedOriginalPlan,
  persistCorrectionPlan,
  snapshotOriginalPlan,
} from "../src/plan-artifacts.js";

const temporaryRoots: string[] = [];

async function temporaryWorkspace(): Promise<{ root: string; cwd: string; agentDir: string }> {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(join(tmpdir(), "pi-goal-artifacts-")));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, "plans"), { recursive: true });
  await mkdir(agentDir);
  temporaryRoots.push(root);
  return { root, cwd, agentDir };
}

function sha256(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

async function expectArtifactCode(action: Promise<unknown>, code: PlanArtifactError["code"]): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("immutable goal-loop plan artifacts", () => {
  it("snapshots relative sources with canonical provenance, hashes, and restrictive permissions", async () => {
    const { cwd, agentDir } = await temporaryWorkspace();
    const content = "# Approved plan\nImplement the thing. 🚀\n";
    const source = join(cwd, "plans", "my plan.md");
    await writeFile(source, content, "utf8");

    const artifact = await snapshotOriginalPlan({
      cwd,
      loopId: "loop-1",
      sourcePath: "plans/my plan.md",
      sourceKind: "approved",
      agentDir,
      maxBytes: Buffer.byteLength(content),
    });

    expect(artifact.content).toBe(content);
    expect(artifact.hash).toBe(sha256(content));
    const canonicalAgentDir = await realpath(agentDir);
    const canonicalSource = await realpath(source);
    expect(artifact.path).toBe(join(canonicalAgentDir, "goal-loops", "loop-1", ORIGINAL_PLAN_FILENAME));
    expect(artifact.provenance).toEqual({
      sourceKind: "approved",
      sourcePath: canonicalSource,
      snapshotPath: artifact.path,
      snapshotHash: sha256(content),
    });
    expect(await readFile(artifact.path, "utf8")).toBe(content);
    if (process.platform !== "win32") {
      expect((await stat(join(agentDir, "goal-loops"))).mode & 0o777).toBe(0o700);
      expect((await stat(getGoalLoopArtifactDirectory("loop-1", agentDir))).mode & 0o777).toBe(0o700);
      expect((await stat(artifact.path)).mode & 0o777).toBe(0o600);
    }
    await expectArtifactCode(snapshotOriginalPlan({
      cwd,
      loopId: "loop-1",
      sourcePath: source,
      agentDir,
      maxBytes: 1000,
    }), "ARTIFACT_EXISTS");
  });

  it("verifies the immutable snapshot after source mutation or deletion", async () => {
    const { cwd, agentDir } = await temporaryWorkspace();
    const source = join(cwd, "plans", "original.md");
    const original = "keep this exact snapshot\n";
    await writeFile(source, original);
    const snapshot = await snapshotOriginalPlan({ cwd, loopId: "retained", sourcePath: source, agentDir, maxBytes: 1000 });

    await writeFile(source, "mutated source\n");
    await rm(source);
    const loaded = await loadVerifiedOriginalPlan({
      loopId: "retained",
      provenance: snapshot.provenance,
      agentDir,
      maxBytes: 1000,
    });
    expect(loaded.content).toBe(original);
    expect(loaded.hash).toBe(snapshot.hash);

    await writeFile(snapshot.path, "corrupted snapshot\n");
    await expectArtifactCode(loadVerifiedOriginalPlan({
      loopId: "retained",
      provenance: snapshot.provenance,
      agentDir,
      maxBytes: 1000,
    }), "HASH_MISMATCH");
  });

  it("rejects symlink, non-file, unreadable, and traversal inputs", async () => {
    const { cwd, agentDir, root } = await temporaryWorkspace();
    const regular = join(cwd, "plans", "regular.md");
    const directory = join(cwd, "plans", "directory.md");
    const linkPath = join(cwd, "plans", "link.md");
    await writeFile(regular, "plan");
    await mkdir(directory);
    await symlink(regular, linkPath);

    for (const loopId of ["../escape", "nested/id", "/tmp/escape", ".", "..", ""]) {
      await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId, sourcePath: regular, agentDir, maxBytes: 100 }), "INVALID_LOOP_ID");
    }
    await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId: "symlink", sourcePath: linkPath, agentDir, maxBytes: 100 }), "SYMLINK_NOT_ALLOWED");
    await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId: "directory", sourcePath: directory, agentDir, maxBytes: 100 }), "SOURCE_NOT_REGULAR");

    const snapshot = await snapshotOriginalPlan({ cwd, loopId: "safe", sourcePath: regular, agentDir, maxBytes: 100 });
    await expectArtifactCode(loadVerifiedOriginalPlan({
      loopId: "safe",
      provenance: {
        ...snapshot.provenance,
        snapshotPath: join(agentDir, "goal-loops", "safe", "..", "..", "outside.md"),
      },
      agentDir,
      maxBytes: 100,
    }), "INVALID_PATH");

    const outside = join(root, "outside");
    await mkdir(outside);
    const symlinkedRoot = join(root, "agent-symlink");
    await symlink(outside, symlinkedRoot);
    await expectArtifactCode(snapshotOriginalPlan({
      cwd,
      loopId: "safe",
      sourcePath: regular,
      agentDir: symlinkedRoot,
      maxBytes: 100,
    }), "SYMLINK_NOT_ALLOWED");

    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      await chmod(regular, 0);
      await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId: "unreadable", sourcePath: regular, agentDir, maxBytes: 100 }), "SOURCE_UNREADABLE");
    }
  });

  it("stores and verifies bounded, cycle-specific corrective plans", async () => {
    const { agentDir } = await temporaryWorkspace();
    const correction = "1. Fix the missing behavior.\n2. Run npm test.\n";
    const stored = await persistCorrectionPlan({
      loopId: "loop-correction",
      cycle: 1,
      content: correction,
      agentDir,
      maxCorrectionBytes: 1000,
    });
    expect(stored.path).toBe(join(await realpath(agentDir), "goal-loops", "loop-correction", CORRECTION_PLAN_FILENAME(1)));
    expect(stored.hash).toBe(sha256(correction));
    expect(stored.metadata).toEqual({ cycle: 1, path: stored.path, hash: stored.hash, sizeBytes: Buffer.byteLength(correction) });

    const loaded = await loadVerifiedCorrectionPlan({
      loopId: "loop-correction",
      cycle: 1,
      path: stored.path,
      expectedHash: stored.hash,
      agentDir,
      maxBytes: 1000,
    });
    expect(loaded.content).toBe(correction);

    await writeFile(stored.path, "changed correction");
    await expectArtifactCode(loadVerifiedCorrectionPlan({
      loopId: "loop-correction",
      cycle: 1,
      hash: stored.hash,
      agentDir,
      maxBytes: 1000,
    }), "HASH_MISMATCH");
    await expectArtifactCode(persistCorrectionPlan({
      loopId: "loop-correction",
      cycle: 1,
      content: correction,
      agentDir,
      maxBytes: 1000,
    }), "ARTIFACT_EXISTS");
  });

  it("fails closed for cycle bounds, empty corrections, and byte limits", async () => {
    const { cwd, agentDir } = await temporaryWorkspace();
    const source = join(cwd, "plans", "bounded.md");
    await writeFile(source, "12345");
    await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId: "bounded", sourcePath: source, agentDir, maxBytes: 4 }), "SIZE_LIMIT");
    await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId: "bounded", sourcePath: source, agentDir, maxBytes: 0 }), "INVALID_INPUT");
    await expectArtifactCode(snapshotOriginalPlan({ cwd, loopId: "bounded", sourcePath: source, agentDir, maxBytes: 1024, maxPlanBytes: 1023 }), "INVALID_INPUT");

    for (const cycle of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      await expectArtifactCode(persistCorrectionPlan({ loopId: "bounds", cycle, content: "fix", agentDir, maxBytes: 100 }), "INVALID_CYCLE");
    }
    await expectArtifactCode(persistCorrectionPlan({ loopId: "bounds", cycle: 2, maxCycles: 1, content: "fix", agentDir, maxBytes: 100 }), "INVALID_CYCLE");
    await expectArtifactCode(persistCorrectionPlan({ loopId: "bounds", cycle: 1, content: "   \n", agentDir, maxBytes: 100 }), "INVALID_INPUT");
    await expectArtifactCode(persistCorrectionPlan({ loopId: "bounds", cycle: 1, content: "012345", agentDir, maxBytes: 5 }), "SIZE_LIMIT");
    await expectArtifactCode(persistCorrectionPlan({ loopId: "bounds", cycle: 2, content: "fix", agentDir, maxBytes: 0 }), "INVALID_INPUT");
  });

  it("does not publish partial or overwritten files when publication races an existing artifact", async () => {
    const { agentDir } = await temporaryWorkspace();
    const first = await persistCorrectionPlan({ loopId: "exclusive", cycle: 1, content: "first", agentDir, maxBytes: 100 });
    await expectArtifactCode(persistCorrectionPlan({ loopId: "exclusive", cycle: 1, content: "second", agentDir, maxBytes: 100 }), "ARTIFACT_EXISTS");
    expect(await readFile(first.path, "utf8")).toBe("first");
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(getGoalLoopArtifactDirectory("exclusive", agentDir)));
    expect(entries).toEqual([CORRECTION_PLAN_FILENAME(1)]);
    expect((await lstat(first.path)).isFile()).toBe(true);
  });
});
