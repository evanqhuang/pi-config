import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupWorktree,
  createWorktree,
  toWorktreeReport,
  WorktreeCleanupError,
  WorktreeCreationError,
} from "../src/worktree.js";

const temporaryRepositories: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-worktree-test-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Worktree Test"]);
  writeFileSync(join(root, "tracked.txt"), "base\n");
  writeFileSync(join(root, "staged.txt"), "staged base\n");
  writeFileSync(join(root, "unstaged.txt"), "unstaged base\n");
  writeFileSync(join(root, "deleted.txt"), "delete me\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 255, 0, 254]));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "initial"]);
  return root;
}

function worktreeEntries(root: string): string {
  return git(root, ["worktree", "list", "--porcelain"]);
}

afterEach(() => {
  for (const root of temporaryRepositories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("disposable snapshot worktrees", () => {
  it("creates a clean detached snapshot and removes it without a branch", () => {
    const root = repository();
    const worktree = createWorktree(root, "clean", { finalization: "discard" })!;
    expect(git(worktree.path, ["status", "--porcelain"])).toBe("");
    expect(git(worktree.path, ["branch", "--show-current"])).toBe("");

    const result = cleanupWorktree(root, worktree, "clean");
    expect(result).toMatchObject({ hasChanges: false, discarded: true });
    expect(result.branch).toBeUndefined();
    expect(existsSync(worktree.path)).toBe(false);
    expect(git(root, ["branch", "--list", "pi-agent-clean"])).toBe("");
  });

  it("overlays staged, unstaged, deleted, binary, and NUL-delimited untracked changes", () => {
    const root = repository();
    writeFileSync(join(root, "staged.txt"), "staged overlay\n");
    git(root, ["add", "staged.txt"]);
    writeFileSync(join(root, "unstaged.txt"), "unstaged overlay\n");
    unlinkSync(join(root, "deleted.txt"));
    writeFileSync(join(root, "binary.bin"), Buffer.from([255, 0, 17, 0, 128, 3]));
    const untrackedName = "untracked\nname.bin";
    writeFileSync(join(root, untrackedName), Buffer.from([0, 255, 7, 0]));
    const sourceBefore = {
      head: git(root, ["rev-parse", "HEAD"]),
      status: git(root, ["status", "--porcelain"]),
    };

    const sourceFilesBeforeCleanup = {
      staged: readFileSync(join(root, "staged.txt")),
      unstaged: readFileSync(join(root, "unstaged.txt")),
      binary: readFileSync(join(root, "binary.bin")),
      untracked: readFileSync(join(root, untrackedName)),
    };
    const worktree = createWorktree(root, "snapshot", { finalization: "discard" });
    expect(worktree).toBeDefined();
    expect(worktree!.snapshot?.complete).toBe(true);
    expect(worktree!.snapshot?.trackedPaths).toEqual(
      expect.arrayContaining(["staged.txt", "unstaged.txt", "deleted.txt", "binary.bin"]),
    );
    expect(worktree!.snapshot?.untrackedPaths).toContain(untrackedName);
    expect(git(worktree!.path, ["branch", "--show-current"])).toBe("");
    expect(readFileSync(join(worktree!.path, "staged.txt"), "utf8")).toBe("staged overlay\n");
    expect(readFileSync(join(worktree!.path, "unstaged.txt"), "utf8")).toBe("unstaged overlay\n");
    expect(existsSync(join(worktree!.path, "deleted.txt"))).toBe(false);
    expect(readFileSync(join(worktree!.path, "binary.bin")).equals(sourceFilesBeforeCleanup.binary)).toBe(true);
    expect(readFileSync(join(worktree!.path, untrackedName)).equals(sourceFilesBeforeCleanup.untracked)).toBe(true);

    const result = cleanupWorktree(root, worktree!, "discard this");
    expect(result).toMatchObject({ hasChanges: true, discarded: true });
    expect(result.branch).toBeUndefined();
    expect(existsSync(worktree!.path)).toBe(false);
    expect(worktreeEntries(root)).not.toContain(worktree!.path);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(sourceBefore.head);
    expect(git(root, ["status", "--porcelain"])).toBe(sourceBefore.status);
    expect(readFileSync(join(root, "staged.txt")).equals(sourceFilesBeforeCleanup.staged)).toBe(true);
    expect(readFileSync(join(root, "unstaged.txt")).equals(sourceFilesBeforeCleanup.unstaged)).toBe(true);
    expect(readFileSync(join(root, "binary.bin")).equals(sourceFilesBeforeCleanup.binary)).toBe(true);
    expect(readFileSync(join(root, untrackedName)).equals(sourceFilesBeforeCleanup.untracked)).toBe(true);
  });

  it("discards an agent's internal commit without creating a branch", () => {
    const root = repository();
    const base = git(root, ["rev-parse", "HEAD"]);
    const worktree = createWorktree(root, "internal-commit", { finalization: "discard" })!;
    writeFileSync(join(worktree.path, "agent.txt"), "agent commit\n");
    git(worktree.path, ["add", "agent.txt"]);
    git(worktree.path, ["commit", "-qm", "agent internal commit"]);
    expect(git(worktree.path, ["rev-parse", "HEAD"])).not.toBe(base);

    const result = cleanupWorktree(root, worktree, "ignored");
    expect(result).toMatchObject({ hasChanges: true, discarded: true });
    expect(result.branch).toBeUndefined();
    expect(git(root, ["rev-parse", "HEAD"])).toBe(base);
    expect(git(root, ["branch", "--list", "pi-agent-internal-commit"])).toBe("");
    expect(existsSync(join(root, "agent.txt"))).toBe(false);
  });

  it("preserves an agent commit in ordinary finalization without making an empty commit", () => {
    const root = repository();
    const worktree = createWorktree(root, "ordinary-internal")!;
    writeFileSync(join(worktree.path, "internal.txt"), "internal\n");
    git(worktree.path, ["add", "internal.txt"]);
    git(worktree.path, ["commit", "-qm", "agent internal commit"]);

    const result = cleanupWorktree(root, worktree, "not used");
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toMatch(/^pi-agent-ordinary-internal/);
    expect(git(root, ["show", "--format=%s", "--no-patch", result.branch!])).toContain("agent internal commit");
  });

  it("keeps ordinary commit finalization as the default and runs hooks", () => {
    const root = repository();
    const worktree = createWorktree(root, "ordinary")!;
    writeFileSync(join(worktree.path, "ordinary.txt"), "ordinary\n");
    const result = cleanupWorktree(root, worktree, "ordinary change");
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toMatch(/^pi-agent-ordinary/);
    expect(git(root, ["show", "--format=%s", "--no-patch", result.branch!])).toContain("pi-agent: ordinary change");
    expect(existsSync(worktree.path)).toBe(false);

    const hooked = createWorktree(root, "hooked")!;
    writeFileSync(join(hooked.path, "hooked.txt"), "hooked\n");
    const hook = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    let cleanupError: unknown;
    try {
      cleanupWorktree(root, hooked, "must run hook");
    } catch (error) {
      cleanupError = error;
    }
    expect(cleanupError).toBeInstanceOf(WorktreeCleanupError);
    expect((cleanupError as WorktreeCleanupError).worktreePath).toBe(hooked.path);
    expect((cleanupError as WorktreeCleanupError).message).toContain(hooked.path);
    expect(existsSync(hooked.path)).toBe(true);
    expect(git(hooked.path, ["status", "--porcelain"])).not.toBe("");
    expect(git(root, ["branch", "--list", "pi-agent-hooked"])).toBe("");
  });

  it("rejects escaping symlinks and cleans a worktree created before validation failed", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "pi-worktree-outside-"));
    temporaryRepositories.push(outside);
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(outsideFile, "outside\n");
    symlinkSync(outsideFile, join(root, "escape"));
    git(root, ["add", "escape"]);
    git(root, ["commit", "-qm", "unsafe symlink"]);

    let thrown: unknown;
    try {
      createWorktree(root, "unsafe", { finalization: "discard" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorktreeCreationError);
    expect((thrown as WorktreeCreationError).code).toBe("snapshot-failed");
    expect(worktreeEntries(root)).not.toContain("pi-agent-unsafe-");
    expect(lstatSync(join(root, "escape")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });

  it("rejects an unsafe or incomplete untracked symlink snapshot before handing it to an agent", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "pi-worktree-untracked-outside-"));
    temporaryRepositories.push(outside);
    symlinkSync(join(outside, "missing.txt"), join(root, "broken-link"));

    expect(() => createWorktree(root, "broken", { finalization: "discard" })).toThrow(WorktreeCreationError);
    expect(worktreeEntries(root)).not.toContain("pi-agent-broken-");
    expect(lstatSync(join(root, "broken-link")).isSymbolicLink()).toBe(true);
  });

  it("projects bounded lifecycle metadata without patches or copied content", () => {
    const root = repository();
    writeFileSync(join(root, "secret.txt"), "do not publish this content");
    const worktree = createWorktree(root, "metadata", { finalization: "discard" })!;
    const result = cleanupWorktree(root, worktree, "metadata");
    const report = toWorktreeReport(worktree, result)!;

    expect(report).toMatchObject({
      finalization: "discard",
      discarded: true,
      hasChanges: true,
      source: { baseSha: worktree.baseSha },
      snapshot: {
        complete: true,
        untrackedPaths: ["secret.txt"],
        untrackedPathCount: 1,
      },
    });
    expect(JSON.stringify(report)).not.toContain("do not publish this content");
    expect(JSON.stringify(report)).not.toContain("patch");

    const oversized = toWorktreeReport({
      ...worktree,
      snapshot: {
        ...worktree.snapshot!,
        trackedPaths: Array.from({ length: 129 }, (_, i) => `tracked-${i}`),
      },
    }, result)!;
    expect(oversized.snapshot?.trackedPaths).toHaveLength(128);
    expect(oversized.snapshot?.trackedPathCount).toBe(129);
    expect(oversized.snapshot?.truncatedPaths).toBe(true);
  });

  it("rejects a same-path untracked content race despite unchanged stat metadata", () => {
    const root = repository();
    const racePath = join(root, "race.txt");
    writeFileSync(racePath, "before!");

    // post-checkout runs during the real `git worktree add`, before the
    // untracked overlay is copied. Restore the original mtime after replacing
    // the same-size file, leaving content identity as the only changed state.
    const hook = join(root, ".git", "hooks", "post-checkout");
    const savedPath = `${racePath}.saved`;
    writeFileSync(hook, [
      "#!/bin/sh",
      `cp -p '${racePath}' '${savedPath}'`,
      `printf 'changed' > '${racePath}'`,
      `touch -r '${savedPath}' '${racePath}'`,
      `rm -f '${savedPath}'`,
      "",
    ].join("\n"));
    chmodSync(hook, 0o755);
    // Make hook lookup explicit for Git builds that use a non-default hooks
    // path in the test process.
    git(root, ["config", "core.hooksPath", join(root, ".git", "hooks")]);

    expect(() => createWorktree(root, "same-path-race", { finalization: "discard" }))
      .toThrow(WorktreeCreationError);
    expect(readFileSync(racePath, "utf8")).toBe("changed");
    expect(worktreeEntries(root)).not.toContain("pi-agent-same-path-race-");
  });

  it("fails loudly for required disposable creation outside a repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-not-git-"));
    temporaryRepositories.push(directory);
    expect(() => createWorktree(directory, "required", { finalization: "discard" })).toThrow(WorktreeCreationError);
    expect(() => createWorktree(directory, "required", { finalization: "discard" })).toThrow(/not a Git repository/);
  });
});
