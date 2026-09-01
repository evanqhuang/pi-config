import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import notesExtension, {
  DEFAULT_CONFIG,
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

function subagentResult(status: "running" | "completed") {
  return {
    content: [{
      type: "text" as const,
      text: `Agent: research\nType: Explore | Status: ${status} | Tool uses: 1 | Duration: 1s\nDescription: research\n${status === "completed" ? "Findings are ready." : "Agent is still running."}`,
    }],
    details: undefined,
  };
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
  it.skipIf(process.platform === "win32")("accepts an agent directory reached through a symlinked ancestor", async () => {
    const container = await mkdtemp(join(tmpdir(), "pi-notes-symlink-"));
    createdRoots.push(container);
    const realRoot = join(container, "real");
    const aliasRoot = join(container, "alias");
    await mkdir(realRoot);
    await symlink(realRoot, aliasRoot, "dir");

    const h = await makeHarness([], aliasRoot);
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);

    await expect(h.checkpointTool.execute("cp-symlink", payload)).resolves.toMatchObject({
      details: { generation: 1 },
    });
  });

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

  it("retains every sorted path and harness fact in checkpoint metadata across restore", async () => {
    const source = await makeHarness();
    await source.handlers.get("session_start")!({ reason: "new" }, source.ctx);
    await source.command.handler("on", source.ctx);
    for (const path of ["z/last.ts", "a/first.ts", "m/middle.ts"]) {
      source.handlers.get("tool_result")!({
        toolName: "write",
        input: { path },
        isError: false,
      });
    }
    source.handlers.get("tool_result")!({
      toolName: "bash",
      input: { command: "pnpm test" },
      isError: true,
    });
    source.handlers.get("tool_result")!({
      toolName: "bash",
      input: { command: "pnpm test" },
      isError: true,
    });

    const committed = await source.checkpointTool.execute("cp-facts", payload);
    const notesPath = committed.details.notesPath as string;
    const checkpoint = latestCustom(source.branch, NOTES_CHECKPOINT_TYPE).data;
    expect(checkpoint.harnessFacts).toEqual({
      modifiedFiles: ["a/first.ts", "m/middle.ts", "z/last.ts"],
      lastVerificationCommand: "pnpm test",
      lastVerificationOutcome: "error",
      recentFailedCommandCount: 2,
    });

    const branch = source.branch.slice();
    const expected = await readFile(notesPath, "utf8");
    await unlink(notesPath);
    const resumed = await makeHarness(branch, source.root);
    await resumed.handlers.get("session_start")!({ reason: "resume" }, resumed.ctx);
    expect(await readFile(notesPath, "utf8")).toBe(expected);

    await resumed.checkpointTool.execute("cp-facts-restored", payload);
    const restoredCheckpoint = latestCustom(resumed.branch, NOTES_CHECKPOINT_TYPE).data;
    expect(restoredCheckpoint.harnessFacts).toEqual(checkpoint.harnessFacts);
  });

  it("runs repaired arguments through the unchanged strict schema", async () => {
    const h = await makeHarness();
    const malformed = { ...payload } as Record<string, unknown>;
    delete malformed.completed;
    const tooMany = Array.from({ length: 41 }, (_, index) => `completed ${index}`);
    malformed[`completed]\n${JSON.stringify(tooMany)}\n</parameter`] = "";

    expect(() => h.checkpointTool.prepareArguments(malformed)).toThrow(/Invalid checkpoint payload/);

    const arrowSplit = { ...payload } as Record<string, unknown>;
    delete arrowSplit.findings;
    const expectedFindings = ["await operation.catch(() => {}); then continue"];
    const serialized = JSON.stringify(expectedFindings);
    const arrow = serialized.indexOf("=>");
    arrowSplit[`findings]\n${serialized.slice(0, arrow + 1)}`] = serialized.slice(arrow + 2);
    const preparedArrowSplit = h.checkpointTool.prepareArguments(arrowSplit);
    expect(preparedArrowSplit.findings).toEqual(expectedFindings);
    expect(Value.Check(h.checkpointTool.parameters, preparedArrowSplit)).toBe(true);

    const tooLong = { ...payload } as Record<string, unknown>;
    delete tooLong.findings;
    tooLong[`findings]\n${JSON.stringify(["f".repeat(1025)])}\n</parameter`] = "";
    expect(() => h.checkpointTool.prepareArguments(tooLong)).toThrow(/Invalid checkpoint payload/);
  });

  it("rejects an oversized current field without echoing or changing committed state", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    const committed = await h.checkpointTool.execute("cp-1", payload);
    const notesPath = committed.details.notesPath as string;
    const notesBefore = await readFile(notesPath, "utf8");
    const branchLengthBefore = h.branch.length;
    const statusBefore = await h.status();
    const oversizedCurrent = `DO_NOT_ECHO_${"x".repeat(3580)}`;
    expect(oversizedCurrent).toHaveLength(3592);

    let failure: Error | undefined;
    try {
      h.checkpointTool.prepareArguments({ ...payload, current: oversizedCurrent });
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toMatch(/Invalid checkpoint payload.*Summarize/s);
    expect(failure?.message).not.toContain("DO_NOT_ECHO");
    expect(failure?.message.length).toBeLessThan(400);
    expect(h.branch).toHaveLength(branchLengthBefore);
    expect(await readFile(notesPath, "utf8")).toBe(notesBefore);
    expect(await h.status()).toBe(statusBefore);
    expect(latestCustom(h.branch, NOTES_CHECKPOINT_TYPE).data.generation).toBe(1);
  });

  it("fails when authored state alone exceeds the Notes byte bound", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);

    await expect(h.checkpointTool.execute("cp-too-large", {
      ...payload,
      current: "c".repeat(2048),
      completed: Array.from({ length: 40 }, () => "completed".repeat(128)),
    })).rejects.toThrow(/Rendered Notes exceed 8192 bytes/);
  });

  it("does not dirty or pressure a clean checkpoint for ordinary read/search results", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("cp-1", payload);

    for (let index = 0; index < DEFAULT_CONFIG.checkpointing.continuityRelevantToolResults; index += 1) {
      const toolName = index % 2 === 0 ? "read" : "web_search";
      h.handlers.get("tool_result")!({ toolName, input: { path: `src/${index}.ts` }, isError: false });
    }

    expect(await h.status()).toContain("dirty: false");
    expect(await h.status()).toContain("checkpoint due: false");
  });

  it("marks a checkpoint dirty only after the read-only turn threshold", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("cp-1", payload);

    for (let index = 0; index < DEFAULT_CONFIG.autoActivation.readOnlyLongTaskTurns - 1; index += 1) {
      h.handlers.get("tool_result")!({ toolName: "read", input: { path: `src/${index}.ts` }, isError: false });
      h.handlers.get("turn_end")!({});
      expect(await h.status()).toContain("dirty: false");
    }
    h.handlers.get("tool_result")!({ toolName: "read", input: { path: "src/threshold.ts" }, isError: false });
    h.handlers.get("turn_end")!({});

    expect(await h.status()).toContain("dirty: true");
  });

  it("defers running subagent status lookups but dirties for completed handoffs", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("cp-1", payload);

    h.handlers.get("tool_result")!({
      toolName: "get_subagent_result",
      input: { agent_id: "research" },
      isError: false,
      ...subagentResult("running"),
    });
    expect(await h.status()).toContain("dirty: false");

    h.handlers.get("tool_result")!({
      toolName: "get_subagent_result",
      input: { agent_id: "research" },
      isError: false,
      ...subagentResult("completed"),
    });
    expect(await h.status()).toContain("dirty: true");
  });

  it("marks high-signal mutations, verification, errors, and subagent completions immediately", async () => {
    const cases: Array<Record<string, unknown>> = [
      { toolName: "write", input: { path: "src/changed.ts" }, isError: false },
      { toolName: "bash", input: { command: "npm test" }, isError: false },
      { toolName: "bash", input: { command: "rg missing src" }, isError: true },
      { toolName: "get_subagent_result", input: { agent_id: "research" }, isError: false, ...subagentResult("completed") },
    ];

    for (const activity of cases) {
      const h = await makeHarness();
      await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
      await h.command.handler("on", h.ctx);
      await h.checkpointTool.execute("cp-1", payload);
      h.handlers.get("tool_result")!(activity);
      expect(await h.status()).toContain("dirty: true");
    }
  });

  it("resets the read-only streak after checkpoint commit", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("cp-1", payload);

    const threshold = DEFAULT_CONFIG.autoActivation.readOnlyLongTaskTurns;
    for (let index = 0; index < threshold - 1; index += 1) {
      h.handlers.get("tool_result")!({ toolName: "read", input: { path: `src/before-${index}.ts` }, isError: false });
      h.handlers.get("turn_end")!({});
    }
    expect(await h.status()).toContain("dirty: false");

    await h.checkpointTool.execute("cp-2", payload);
    for (let index = 0; index < threshold - 1; index += 1) {
      h.handlers.get("tool_result")!({ toolName: "read", input: { path: `src/after-${index}.ts` }, isError: false });
      h.handlers.get("turn_end")!({});
    }
    expect(await h.status()).toContain("dirty: false");
    h.handlers.get("tool_result")!({ toolName: "read", input: { path: "src/after-threshold.ts" }, isError: false });
    h.handlers.get("turn_end")!({});
    expect(await h.status()).toContain("dirty: true");
  });

  it("publishes a compact checkpoint budget in the agent policy", async () => {
    const h = await makeHarness();
    await h.command.handler("on", h.ctx);
    const policy = h.handlers.get("before_agent_start")!({ systemPrompt: "base" }, h.ctx);

    expect(policy.systemPrompt).toContain("current <=400 characters");
    expect(policy.systemPrompt).toContain("next_action <=250 characters");
    expect(policy.systemPrompt).toContain("Never paste plans, logs, raw test output, or file lists.");
  });

  it("applies checkpoint pressure after high-signal results or dirty turns", async () => {
    const byResults = await makeHarness();
    await byResults.handlers.get("session_start")!({ reason: "new" }, byResults.ctx);
    await byResults.command.handler("on", byResults.ctx);
    await byResults.checkpointTool.execute("cp-1", payload);
    for (let index = 0; index < DEFAULT_CONFIG.checkpointing.continuityRelevantToolResults; index += 1) {
      byResults.handlers.get("tool_result")!({
        toolName: "get_subagent_result",
        input: { agent_id: `research-${index}` },
        isError: false,
        ...subagentResult("completed"),
      });
    }
    expect(await byResults.status()).toContain("checkpoint due: true");

    const byTurns = await makeHarness();
    await byTurns.handlers.get("session_start")!({ reason: "new" }, byTurns.ctx);
    await byTurns.command.handler("on", byTurns.ctx);
    await byTurns.checkpointTool.execute("cp-1", payload);
    byTurns.handlers.get("tool_result")!({ toolName: "write", input: { path: "src/a.ts" }, isError: false });
    for (let index = 0; index < DEFAULT_CONFIG.checkpointing.dirtyTurns - 1; index += 1) byTurns.handlers.get("turn_end")!({});
    expect(await byTurns.status()).toContain("checkpoint due: false");
    byTurns.handlers.get("turn_end")!({});
    expect(await byTurns.status()).toContain("checkpoint due: true");
  });

  it("blocks completion as soon as continuity-relevant work makes Notes stale", async () => {
    const h = await makeHarness();
    await h.handlers.get("session_start")!({ reason: "new" }, h.ctx);
    await h.command.handler("on", h.ctx);
    await h.checkpointTool.execute("cp-1", payload);
    h.handlers.get("tool_result")!({
      toolName: "get_subagent_result",
      input: { agent_id: "research" },
      isError: false,
      ...subagentResult("completed"),
    });

    const blocked = await h.handlers.get("tool_call")!({
      toolName: "goal_progress",
      input: { status: "done" },
    }, h.ctx);
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toMatch(/dirty durable Notes/i);
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
