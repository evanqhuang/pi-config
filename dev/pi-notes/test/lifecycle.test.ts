import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import notesExtension, {
  NOTES_CHECKPOINT_TYPE,
  NOTES_STATE_TYPE,
  type CheckpointPayload,
} from "../index.js";

const payload: CheckpointPayload = {
  current: "Implement durable Notes.",
  completed: ["Initialized the extension."],
  findings: ["Lifecycle state belongs to the active session branch."],
  decisions: ["Keep one private Notes identity per top-level session."],
  failed_approaches: [],
  blockers: [],
  verification: ["Focused tests running."],
  next_action: "Continue implementation.",
};

const createdRoots: string[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  while (createdRoots.length) await rm(createdRoots.pop()!, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

function latestCustom(entries: any[], customType: string): any | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === customType) return entry;
  }
  return undefined;
}

async function makeHarness(initialBranch: any[] = [], existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "pi-notes-lifecycle-"));
  if (!existingRoot) createdRoots.push(root);
  process.env.PI_CODING_AGENT_DIR = root;

  let branch = [...initialBranch];
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];

  const pi = {
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
    appendEntry(customType: string, data: unknown) {
      branch.push({ type: "custom", customType, data });
    },
    getActiveTools() { return ["read", "write", "edit", "checkpoint_notes", "goal_progress"]; },
    sendMessage() {},
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: root,
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      notify(message: string, level: string) { notifications.push({ message, level }); },
    },
  } as unknown as ExtensionContext;

  notesExtension(pi);

  const command = commands.get("notes");
  const checkpointTool = tools.get("checkpoint_notes");
  if (!command || !checkpointTool) throw new Error("pi-notes did not register expected command/tool");

  return {
    root,
    pi,
    ctx,
    handlers,
    command,
    checkpointTool,
    notifications,
    get branch() { return branch; },
    setBranch(next: any[]) { branch = next; },
    async status() {
      notifications.length = 0;
      await command.handler("status", ctx);
      return notifications.at(-1)?.message ?? "";
    },
  };
}

describe("session lifecycle integration", () => {
  it("restores the selected branch and isolates /fork and /new identities", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    const firstId = latestCustom(h.branch, NOTES_STATE_TYPE).data.notesId;

    await h.command.handler("on", h.ctx);
    const committed = await h.checkpointTool.execute("cp-1", payload);
    const notesPath = committed.details.notesPath as string;
    const checkpointText = await readFile(notesPath, "utf8");
    const cleanBranch = h.branch.slice();
    expect(latestCustom(cleanBranch, NOTES_CHECKPOINT_TYPE).data.generation).toBe(1);

    h.handlers.get("tool_result")!({
      toolName: "write",
      input: { path: "src/changed.ts" },
      isError: false,
    });
    const dirtyBranch = h.branch.slice();
    expect(await h.status()).toContain("dirty: true");

    h.setBranch(cleanBranch);
    await h.handlers.get("session_tree")!({}, h.ctx);
    expect(await h.status()).toContain("dirty: false");
    expect(await readFile(notesPath, "utf8")).toBe(checkpointText);

    h.setBranch(dirtyBranch);
    await h.handlers.get("session_tree")!({}, h.ctx);
    expect(await h.status()).toContain("dirty: true");
    expect(await h.status()).toContain("generation: 1");

    await h.handlers.get("session_start")!({ reason: "fork" }, h.ctx);
    const forkId = latestCustom(h.branch, NOTES_STATE_TYPE).data.notesId;
    expect(forkId).not.toBe(firstId);

    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    const newId = latestCustom(h.branch, NOTES_STATE_TYPE).data.notesId;
    expect(newId).not.toBe(forkId);
  });

  it("rehydrates a committed checkpoint on session resume", async () => {
    const source = await makeHarness();
    await source.handlers.get("session_start")!({ reason: "new" }, source.ctx);
    await source.command.handler("on", source.ctx);
    const committed = await source.checkpointTool.execute("cp-1", payload);
    const notesPath = committed.details.notesPath as string;
    const expected = await readFile(notesPath, "utf8");
    const branch = source.branch.slice();

    await unlink(notesPath);
    const resumed = await makeHarness(branch, source.root);
    await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);

    expect(await resumed.status()).toContain("generation: 1");
    expect(await resumed.status()).toContain("dirty: false");
    expect(await readFile(notesPath, "utf8")).toBe(expected);
  });

  it("preserves dirty checkpoint pressure across compaction boundaries", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("cp-1", payload);
    h.handlers.get("tool_result")!({ toolName: "write", input: { path: "src/a.ts" }, isError: false });

    h.handlers.get("session_compact")!({});
    expect(await h.status()).toContain("dirty: true");
    expect(await h.status()).toContain("checkpoint due: true");

    h.handlers.get("session_compact_failed")!({});
    expect(await h.status()).toContain("dirty: true");
    expect(await h.status()).toContain("checkpoint due: true");
  });
});

describe("materialized Notes integrity", () => {
  it("blocks goal completion after out-of-band changes until /notes restore", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    const committed = await h.checkpointTool.execute("cp-1", payload);
    const notesPath = committed.details.notesPath as string;

    await writeFile(notesPath, "tampered outside checkpoint_notes\n", "utf8");
    const blocked = await h.handlers.get("tool_call")!({
      toolName: "goal_progress",
      input: { status: "done" },
    }, h.ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toMatch(/changed outside checkpoint_notes/i);

    await h.command.handler("restore", h.ctx);
    const allowed = await h.handlers.get("tool_call")!({
      toolName: "goal_progress",
      input: { status: "done" },
    }, h.ctx);
    expect(allowed).toBeUndefined();
  });

  it("hash-baselines inherited /notes resume content before its first checkpoint", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("source", payload);
    const sourceId = latestCustom(h.branch, NOTES_CHECKPOINT_TYPE).data.notesId;

    await h.handlers.get("session_start")!({ reason: "fork" }, h.ctx);
    const forkId = latestCustom(h.branch, NOTES_STATE_TYPE).data.notesId;
    expect(forkId).not.toBe(sourceId);

    await h.command.handler("resume", h.ctx);
    const status = await h.status();
    const pathLine = status.split("\n").find((line) => line.startsWith("path: "));
    const forkNotesPath = pathLine?.slice("path: ".length);
    expect(forkNotesPath).toBeTruthy();
    await writeFile(forkNotesPath!, "tampered inherited snapshot\n", "utf8");

    await expect(h.checkpointTool.execute("fork-cp", {
      ...payload,
      current: "Continue in the fork.",
    })).rejects.toThrow(/changed outside checkpoint_notes/i);
  });
});
