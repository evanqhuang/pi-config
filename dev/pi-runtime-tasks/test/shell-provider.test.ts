import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ShellProvider } from "../src/shell-provider.js";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-runtime-task-"));
  cleanup.push(path);
  return path;
}

describe("ShellProvider", () => {
  it("captures stdout and stderr, settles once, and supports bounded reads", async () => {
    const dir = tempDir();
    const notifications: string[] = [];
    const owner = { goalId: "goal", goalGeneration: 4 };
    const provider = new ShellProvider({
      cwd: () => dir,
      outputDir: dir,
      currentOwner: () => owner,
      notify: record => notifications.push(record.id),
    });

    const record = provider.start("printf stdout; printf stderr >&2", "capture output");
    const settled = await provider.wait(record.id);
    const output = provider.readOutput(record.id, 0, 64 * 1024);

    expect(settled?.status).toBe("completed");
    expect(settled?.owner).toEqual(owner);
    expect(output?.text).toContain("stdout");
    expect(output?.text).toContain("stderr");
    expect(output?.eof).toBe(true);
    expect(notifications).toEqual([record.id]);
    expect(provider.kill(record.id)).toBe(false);
  });

  it("kills the process group and records a terminal killed state", async () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const provider = new ShellProvider({
      cwd: () => dir,
      outputDir: dir,
      currentOwner: () => undefined,
      notify: () => {},
    });

    const record = provider.start("sleep 30", "long command");
    expect(provider.kill(record.id)).toBe(true);
    expect((await provider.wait(record.id))?.status).toBe("killed");
  });

  it("caps output while preserving a truncation marker", async () => {
    const dir = tempDir();
    const provider = new ShellProvider({
      cwd: () => dir,
      outputDir: dir,
      currentOwner: () => undefined,
      notify: () => {},
      maxOutputBytes: 16,
    });

    const record = provider.start("printf 123456789012345678901234567890", "large output");
    await provider.wait(record.id);
    const output = provider.readOutput(record.id, 0, 4_096);

    expect(output?.text.startsWith("1234567890123456")).toBe(true);
    expect(output?.text).toContain("output limit reached");
  });
});
