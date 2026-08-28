import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const requirePi = createRequire("/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/package.json");
const { createJiti } = requirePi("jiti");
const jiti = createJiti("/Users/evanhuang/.pi/agent/dev/pi-plan-mode/index.ts");
const { default: registerPlanMode } = await jiti.import("/Users/evanhuang/.pi/agent/dev/pi-plan-mode/index.ts");

function mockPi() {
  const tools = new Map([
    ["read", { name: "read" }],
    ["write", { name: "write" }],
    ["edit", { name: "edit" }],
    ["late_tool", { name: "late_tool" }],
  ]);
  const handlers = new Map();
  const eventListeners = new Map();
  const events = {
    on(channel, handler) {
      const listeners = eventListeners.get(channel) ?? new Set();
      listeners.add(handler);
      eventListeners.set(channel, listeners);
      return () => listeners.delete(handler);
    },
    emit(channel, data) {
      for (const handler of eventListeners.get(channel) ?? []) handler(data);
    },
  };
  const commands = new Map();
  const shortcuts = new Map();
  const entries = [];
  const active = [];
  const sentMessages = [];
  const customMessages = [];
  return {
    tools,
    handlers,
    eventListeners,
    events,
    commands,
    shortcuts,
    entries,
    active,
    sentMessages,
    customMessages,
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(key, shortcut) { shortcuts.set(key, shortcut); },
    on(name, handler) { handlers.set(name, handler); },
    getAllTools() { return [...tools.values()]; },
    setActiveTools(names) { active.splice(0, active.length, ...names); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendUserMessage(message) { sentMessages.push(message); },
    sendMessage(message) { customMessages.push(message); },
  };
}

function isolatedEnvironment(t) {
  const root = mkdtempSync(join("/tmp", "pi-plan-lifecycle-test-"));
  const previousDataDir = process.env.CONTEXT_MODE_DATA_DIR;
  const previousPlanDir = process.env.PI_PLAN_DIR;
  process.env.CONTEXT_MODE_DATA_DIR = root;
  process.env.PI_PLAN_DIR = join(root, "plans");
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.CONTEXT_MODE_DATA_DIR;
    else process.env.CONTEXT_MODE_DATA_DIR = previousDataDir;
    if (previousPlanDir === undefined) delete process.env.PI_PLAN_DIR;
    else process.env.PI_PLAN_DIR = previousPlanDir;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function mockContext(entries, sessionFile) {
  const notifications = [];
  const selections = [];
  const inputs = [];
  const selectCalls = [];
  const compactCalls = [];
  return {
    cwd: "/Users/evanhuang/scratch/mcmaster-agent",
    hasUI: true,
    running: false,
    notifications,
    selections,
    inputs,
    selectCalls,
    compactCalls,
    isIdle() { return !this.running; },
    compact(options) { compactCalls.push(options); },
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => entries,
      getSessionFile: () => sessionFile,
    },
    ui: {
      theme: { fg: (_name, text) => text },
      notify(message, level) { notifications.push({ message, level }); },
      setStatus() {},
      async select(title, options) { selectCalls.push({ title, options }); return selections.shift(); },
      async input() { return inputs.shift(); },
    },
  };
}

test("non-PLAN Bash follows the session context cwd", async (t) => {
  const targetCwd = mkdtempSync(join(process.cwd(), ".pi-plan-bash-cwd-"));
  const expectedCwd = realpathSync(targetCwd);
  t.after(() => rmSync(targetCwd, { recursive: true, force: true }));

  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  ctx.cwd = targetCwd;
  await pi.commands.get("yolo").handler(undefined, ctx);

  const bash = pi.tools.get("bash");
  assert.ok(bash);
  const result = await bash.execute("cwd-check", { command: "pwd" }, undefined, undefined, ctx);
  assert.equal(result.content[0].text.trim(), expectedCwd);
});

test("extension exposes PLAN enforcement and full-permission ORCHESTRATOR and YOLO modes", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  const root = mkdtempSync(join("/tmp", "pi-plan-extension-test-"));
  const previousDataDir = process.env.CONTEXT_MODE_DATA_DIR;
  const previousPlanDir = process.env.PI_PLAN_DIR;
  const previousPrewalkLauncher = process.env.PI_PREWALK_LAUNCHER;
  const previousPrewalkCapture = process.env.PI_PREWALK_CAPTURE;
  process.env.CONTEXT_MODE_DATA_DIR = root;
  process.env.PI_PLAN_DIR = join(root, "plans");
  process.env.PI_PREWALK_LAUNCHER = join(root, "fake-prewalk");
  process.env.PI_PREWALK_CAPTURE = join(root, "prewalk-task.txt");
  writeFileSync(process.env.PI_PREWALK_LAUNCHER, '#!/bin/sh\ncat > "$PI_PREWALK_CAPTURE"\nprintf \'[prewalk] summary {"checklist_ready":true,"executor_started":true,"executor_model":"test-executor","final_status":"completed"}\\n\' >&2\n');
  chmodSync(process.env.PI_PREWALK_LAUNCHER, 0o700);
  t.after(async () => {
    if (previousDataDir === undefined) delete process.env.CONTEXT_MODE_DATA_DIR;
    else process.env.CONTEXT_MODE_DATA_DIR = previousDataDir;
    if (previousPlanDir === undefined) delete process.env.PI_PLAN_DIR;
    else process.env.PI_PLAN_DIR = previousPlanDir;
    if (previousPrewalkLauncher === undefined) delete process.env.PI_PREWALK_LAUNCHER;
    else process.env.PI_PREWALK_LAUNCHER = previousPrewalkLauncher;
    if (previousPrewalkCapture === undefined) delete process.env.PI_PREWALK_CAPTURE;
    else process.env.PI_PREWALK_CAPTURE = previousPrewalkCapture;
    rmSync(root, { recursive: true, force: true });
  });

  const stalePlan = join(process.env.PI_PLAN_DIR, "stale-plan");
  mkdirSync(stalePlan, { recursive: true });
  const staleTime = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(stalePlan, staleTime, staleTime);
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, '{"type":"session"}\n');
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], sessionFile);
  await pi.handlers.get("session_start")({}, ctx);
  assert.equal(readdirSync(process.env.PI_PLAN_DIR).includes("stale-plan"), false);

  assert.deepEqual(pi.active, ["read", "manage_plan_draft", "submit_plan_for_approval", "bash"], "fresh parent sessions default safely to PLAN");
  assert.match((await pi.handlers.get("before_agent_start")({ systemPrompt: "base" })).systemPrompt, /PLAN MODE IS ACTIVE/);
  assert.ok(pi.commands.has("mode"));
  assert.ok(pi.commands.has("plan"));
  assert.ok(pi.commands.has("orchestrator"));
  assert.ok(pi.commands.has("yolo"));
  assert.deepEqual([...pi.commands.keys()].filter((name) => name.includes("code") || name.includes("ask")), []);
  await pi.commands.get("plan").handler(undefined, ctx);
  const planStart = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(planStart.systemPrompt, /use ask_user_question/);
  assert.match(planStart.systemPrompt, /continue with allowed read-only investigation/);
  assert.match(planStart.systemPrompt, /concrete plan containing context, numbered changes/);
  assert.match(planStart.systemPrompt, /submit_plan_for_approval/);
  assert.match(planStart.systemPrompt, /do not switch modes yourself or ask the user to switch modes/i);

  const draftTool = pi.tools.get("manage_plan_draft");
  const approvalTool = pi.tools.get("submit_plan_for_approval");
  assert.ok(draftTool);
  assert.ok(approvalTool);
  assert.match(planStart.systemPrompt, /2-4 genuinely independent unknowns/);
  assert.match(planStart.systemPrompt, /focused Explore agents/);
  assert.match(planStart.systemPrompt, /LunaCompliance and LunaTestVerifier are post-implementation verification agents/);
  assert.match(planStart.systemPrompt, /must not be used while creating the plan/);
  assert.match(planStart.systemPrompt, /exact checkout, branch, PR ref, or worktree/);
  assert.match(planStart.systemPrompt, /never poll or sleep/);
  assert.match(planStart.systemPrompt, /read-only Plan agent/);
  assert.match(planStart.systemPrompt, /Do not paste the complete plan into an ordinary assistant message/);
  assert.match(planStart.systemPrompt, /manage_plan_draft is the only tool permitted to create, replace, inspect, or probe a managed plan artifact/);
  assert.match(planStart.systemPrompt, /Never use Bash, edit, write, ctx_execute, ctx_execute_file, or ctx_batch_execute as a fallback for plan files/);
  assert.match(planStart.systemPrompt, /report the runtime loading problem and stop rather than attempting a workaround/);
  const createDraft = async (plan) => (await draftTool.execute("draft", { action: "create", plan }, undefined, undefined, ctx)).details.planPath;

  const directPath = await createDraft("# Direct plan\n\n1. Implement it.");
  ctx.selections.push("Implement with YOLO");
  const directResult = await approvalTool.execute("approval-1", { planPath: directPath }, undefined, undefined, ctx);
  assert.match(directResult.content[0].text, /Approval recorded/);
  assert.equal(pi.entries.at(-1).customType, "pi-plan-mode-plan-context");
  assert.equal(pi.entries.at(-1).data.status, "approved-pending");
  assert.equal(pi.entries.at(-1).data.approvalAction, "yolo-direct");
  assert.equal(pi.active.includes("write"), false, "approval must not switch mode inside the tool call");
  const planDirectories = readdirSync(process.env.PI_PLAN_DIR);
  assert.equal(planDirectories.length, 1);
  const directDirectory = join(process.env.PI_PLAN_DIR, planDirectories[0]);
  assert.equal(statSync(directDirectory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directDirectory, "plan.md")).mode & 0o777, 0o600);
  assert.equal(statSync(join(directDirectory, "session.jsonl")).mode & 0o777, 0o600);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.active.includes("write"), true);
  assert.equal(pi.entries.at(-1).customType, "pi-plan-mode-state");
  assert.equal(pi.entries.at(-1).data.mode, "YOLO");
  assert.match(pi.sentMessages.at(-1), /Implement the approved plan/);
  assert.match(pi.sentMessages.at(-1), /full pre-compaction chat history/);

  await pi.commands.get("plan").handler(undefined, ctx);
  const compactPath = await createDraft("# Compact plan\n\n1. Preserve it.");
  ctx.selections.push("Compact + YOLO");
  await approvalTool.execute("approval-2", { planPath: compactPath }, undefined, undefined, ctx);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(ctx.compactCalls.length, 1);
  assert.match(ctx.compactCalls[0].customInstructions, /# Compact plan/);
  assert.match(ctx.compactCalls[0].customInstructions, /full chat history before compaction/);
  assert.equal(pi.active.includes("write"), false, "YOLO waits for compaction success");
  await pi.handlers.get("session_compact")({ reason: "approval-triggered" }, ctx);
  const approvalCompactionContext = await pi.handlers.get("context")({ messages: [] });
  assert.match(approvalCompactionContext.messages.at(-1).content, /Parent PLAN re-entry/);
  ctx.compactCalls[0].onComplete({});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pi.active.includes("write"), true);

  await pi.commands.get("plan").handler(undefined, ctx);
  const orchestratedPath = await createDraft("# Orchestrated plan");
  ctx.selections.push("Implement with ORCHESTRATOR");
  await approvalTool.execute("approval-orchestrator", { planPath: orchestratedPath }, undefined, undefined, ctx);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.match((await pi.handlers.get("before_agent_start")({ systemPrompt: "base" })).systemPrompt, /ORCHESTRATOR MODE IS ACTIVE/);
  assert.match(pi.sentMessages.at(-1), /ORCHESTRATOR mode/);

  await pi.commands.get("plan").handler(undefined, ctx);
  const compactOrchestratedPath = await createDraft("# Compact orchestrated plan");
  ctx.selections.push("Compact + ORCHESTRATOR");
  await approvalTool.execute("approval-compact-orchestrator", { planPath: compactOrchestratedPath }, undefined, undefined, ctx);
  await pi.handlers.get("agent_settled")({}, ctx);
  const orchestratorCompact = ctx.compactCalls.at(-1);
  assert.match(orchestratorCompact.customInstructions, /ORCHESTRATOR mode/);
  orchestratorCompact.onComplete({});
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.match((await pi.handlers.get("before_agent_start")({ systemPrompt: "base" })).systemPrompt, /ORCHESTRATOR MODE IS ACTIVE/);

  await pi.commands.get("plan").handler(undefined, ctx);
  const revisionPath = await createDraft("# Needs revision");
  ctx.selections.push("Request revisions…");
  ctx.inputs.push("Add rollback steps");
  const revisionResult = await approvalTool.execute("approval-3", { planPath: revisionPath }, undefined, undefined, ctx);
  assert.match(revisionResult.content[0].text, /Add rollback steps/);
  assert.equal(revisionResult.details.planPath, revisionPath);
  assert.equal(pi.entries.at(-1).data.status, "revision-requested");
  const replaced = await draftTool.execute("revise", { action: "replace", planPath: revisionPath, plan: "# Revised\n\n1. Add rollback steps." }, undefined, undefined, ctx);
  assert.equal(replaced.details.planPath, revisionPath);
  assert.equal(pi.entries.at(-1).data.status, "replaced");
  assert.match(readFileSync(revisionPath, "utf8"), /Add rollback steps/);
  const displayedPlan = draftTool.renderResult(replaced, { expanded: false }, {
    fg: (_name, text) => text,
    bold: (text) => text,
  });
  assert.equal(displayedPlan.constructor.name, "Container", "plan is visible without manually expanding the tool row");
  const outsideDirectory = join(root, "outside");
  const outsidePlan = join(outsideDirectory, "plan.md");
  mkdirSync(outsideDirectory);
  writeFileSync(outsidePlan, "# outside");
  await assert.rejects(() => draftTool.execute("escape", { action: "replace", planPath: outsidePlan, plan: "bad" }, undefined, undefined, ctx), /outside a managed plan directory/);
  const symlinkDirectory = join(process.env.PI_PLAN_DIR, "symlink-dir");
  const symlinkPlan = join(symlinkDirectory, "plan.md");
  mkdirSync(symlinkDirectory);
  symlinkSync(outsidePlan, symlinkPlan);
  await assert.rejects(() => draftTool.execute("symlink", { action: "replace", planPath: symlinkPlan, plan: "bad" }, undefined, undefined, ctx), /regular file/);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(pi.active.includes("write"), false);

  const failingCompactPath = await createDraft("# Failing compaction");
  ctx.selections.push("Compact + YOLO");
  await approvalTool.execute("approval-4", { planPath: failingCompactPath }, undefined, undefined, ctx);
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.equal(ctx.compactCalls.length, 3);
  ctx.compactCalls.at(-1).onError(new Error("summary unavailable"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pi.active.includes("write"), false);
  assert.equal(pi.entries.at(-1).data.status, "failed");
  assert.match(ctx.notifications.at(-1).message, /remaining in PLAN mode/);


  const block = await pi.handlers.get("tool_call")({ toolName: "edit", input: {} });
  assert.equal(block.block, true);
  assert.equal(block.terminate, undefined);
  assert.equal((await pi.handlers.get("tool_call")({ toolName: "ctx_execute", input: {} })), undefined);
  const blockedBatch = await pi.handlers.get("tool_call")({ toolName: "ctx_batch_execute", input: { commands: [{ command: "touch x" }] } });
  assert.equal(blockedBatch.block, true);
  assert.equal(blockedBatch.terminate, undefined);
  assert.equal((await pi.handlers.get("tool_call")({ toolName: "ctx_batch_execute", input: { commands: [{ command: "git status" }] } })), undefined);
  const blockedBash = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "touch x" } });
  assert.equal(blockedBash.block, true);
  assert.equal(blockedBash.terminate, undefined);

  const worker = await pi.handlers.get("tool_call")({ toolName: "Agent", input: { subagent_type: "worker" } });
  assert.equal(worker.block, true);
  assert.equal(worker.terminate, undefined);
  const explorerInput = { subagent_type: "Explore" };
  assert.equal(await pi.handlers.get("tool_call")({ toolName: "Agent", input: explorerInput }), undefined);
  assert.equal(explorerInput.subagent_type, "Explore");
  assert.equal(explorerInput.mode, "PLAN");
  assert.equal(explorerInput.readOnly, true);
  const planAgent = { subagent_type: "Plan" };
  assert.equal(await pi.handlers.get("tool_call")({ toolName: "Agent", input: planAgent }), undefined);
  assert.equal(planAgent.mode, "PLAN");
  assert.equal(planAgent.readOnly, true);
  for (const subagent_type of ["LunaCompliance", "LunaTestVerifier"]) {
    const input = { subagent_type };
    const blocked = await pi.handlers.get("tool_call")({ toolName: "Agent", input });
    assert.equal(blocked.block, true);
  }

  assert.ok(pi.shortcuts.has("shift+tab"));
  ctx.running = true;
  await pi.shortcuts.get("shift+tab").handler(ctx);
  assert.equal(pi.active.includes("write"), false);
  assert.match(ctx.notifications.at(-1).message, /queued until the current run finishes/);
  ctx.running = false;
  await pi.handlers.get("agent_settled")({}, ctx);
  assert.deepEqual(pi.active, [...pi.tools.keys()]);
  const malformedAgent = await pi.handlers.get("tool_call")({ toolName: "Agent", input: null });
  assert.equal(malformedAgent.block, true);
  assert.equal(malformedAgent.terminate, undefined);
  const orchestratedAgent = { subagent_type: "general-purpose", model: "other/model", thinking: "low" };
  assert.equal(await pi.handlers.get("tool_call")({ toolName: "Agent", input: orchestratedAgent }), undefined);
  assert.equal(orchestratedAgent.subagent_type, "ImplementationWorker");
  assert.equal(orchestratedAgent.model, "openai-codex/gpt-5.6-luna");
  assert.equal(orchestratedAgent.thinking, "xhigh");
  for (const subagent_type of ["LunaCompliance", "LunaTestVerifier"]) {
    const verifier = { subagent_type, model: "other/model", thinking: "low" };
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "Agent", input: verifier }), undefined);
    assert.equal(verifier.subagent_type, subagent_type);
    assert.equal(verifier.model, "openai-codex/gpt-5.6-luna");
    assert.equal(verifier.thinking, "high");
  }
  const orchestratorStart = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(orchestratorStart.systemPrompt, /ORCHESTRATOR MODE IS ACTIVE/);
  assert.match(orchestratorStart.systemPrompt, /Each delegated implementation unit must fit comfortably in one fresh worker context without compaction/);
  assert.match(orchestratorStart.systemPrompt, /normally one objective, one subsystem boundary, no more than 3-5 closely related implementation files plus focused tests, and one focused verification command/);
  assert.match(orchestratorStart.systemPrompt, /Do not bundle discovery, design, implementation, testing, and review into one worker/);
  assert.match(orchestratorStart.systemPrompt, /Dependent units run sequentially only after the prerequisite handoff is inspected and its contract\/tests pass/);
  assert.match(orchestratorStart.systemPrompt, /Parallelize only truly independent units with disjoint files and no dependency edge/);
  assert.match(orchestratorStart.systemPrompt, /If scope expands or a worker approaches its context limit or needs compaction, the worker must stop with a concise handoff; the parent starts a fresh worker for the next unit rather than extending or resuming a context-heavy session/);
  assert.match(orchestratorStart.systemPrompt, /The parent owns integration and must avoid overlapping ownership/);
  assert.match(orchestratorStart.systemPrompt, /verify the complete result/i);
  assert.match(orchestratorStart.systemPrompt, /ImplementationWorker leaf-worker profile/);
  assert.match(orchestratorStart.systemPrompt, /cannot create, launch, steer, or wait on subagents/);
  assert.match(orchestratorStart.systemPrompt, /Do not launch either verifier by default or merely because implementation finished/);
  assert.match(orchestratorStart.systemPrompt, /Use LunaCompliance only when the approved plan or user requirements contain concrete compliance, specification, security, migration, or acceptance criteria/);
  assert.match(orchestratorStart.systemPrompt, /Use LunaTestVerifier only when test evidence is broad, high-risk, coverage-sensitive, difficult to interpret, or otherwise benefits from independent review/);
  assert.match(orchestratorStart.systemPrompt, /For routine changes with focused commands and clear results, the parent runs and evaluates verification directly/);
  assert.match(orchestratorStart.systemPrompt, /Every verifier delegation names the exact absolute target roots and ref\/snapshot/);
  assert.match(orchestratorStart.systemPrompt, /every substantive citation, cwd, and source metadata is under those roots and on the requested ref/);
  assert.match(orchestratorStart.systemPrompt, /off-root, mirror, stale-copy, or wrong-ref report is invalid evidence and must not trigger edits or a fix loop/);
  assert.match(orchestratorStart.systemPrompt, /On provenance failure, inspect the requested live paths directly, explain why the report is invalid, and do not automatically relaunch a verifier merely to obtain PASS/);
  assert.match(orchestratorStart.systemPrompt, /A new verifier is justified only after actual implementation changes require fresh evidence or the user explicitly requests a corrected rerun/);
  assert.match(orchestratorStart.systemPrompt, /Scope findings to approved criteria\/non-goals; classify out-of-scope suggestions instead of fixing them/);
  assert.equal(pi.handlers.get("user_bash")({}, ctx), undefined);

  const orchestratorReminder = () => pi.handlers.get("context")({ messages: [] });
  const reminderContent = (result) => result.messages.at(-1)?.content ?? "";
  assert.equal(pi.eventListeners.get("subagents:started")?.size, 1);
  assert.equal(pi.eventListeners.get("subagents:completed")?.size, 1);
  assert.equal(pi.eventListeners.get("subagents:failed")?.size, 1);
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: re-entry/);
  pi.events.emit("subagents:started", {
    id: "worker-1", type: "ImplementationWorker", description: "implement slice",
    result: "must not be copied into a reminder", error: "must not be copied into a reminder",
  });
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: implementing/);
  pi.events.emit("subagents:completed", { id: "worker-1", type: "ImplementationWorker", description: "implement slice" });
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: verification-needed/);
  assert.match(reminderContent(await orchestratorReminder()), /Do not launch either dedicated verifier by default/);
  assert.match(reminderContent(await orchestratorReminder()), /The parent may verify routine work directly/);
  pi.events.emit("subagents:started", { id: "compliance-1", type: "LunaCompliance", description: "compliance" });
  pi.events.emit("subagents:started", { id: "tests-1", type: "LunaTestVerifier", description: "tests" });
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: verifying/);
  pi.events.emit("subagents:completed", { id: "compliance-1", type: "LunaCompliance", description: "compliance" });
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: verifying/);
  pi.events.emit("subagents:completed", { id: "tests-1", type: "LunaTestVerifier", description: "tests" });
  const signoffReminder = await orchestratorReminder();
  assert.match(reminderContent(signoffReminder), /Current lifecycle phase: signoff-ready/);
  assert.doesNotMatch(reminderContent(signoffReminder), /must not be copied/);
  assert.equal(signoffReminder.messages.filter((message) => message.customType === "pi-plan-mode-orchestrator-reminder").length, 1);
  assert.equal(pi.entries.some((entry) => entry.customType === "pi-plan-mode-orchestrator-reminder"), false);
  pi.events.emit("subagents:failed", { id: "compliance-1", type: "LunaCompliance", error: "private verifier error" });
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: verification-failed/);
  pi.events.emit("subagents:started", { id: "worker-2", type: "ImplementationWorker" });
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: implementing/);
  await pi.handlers.get("session_compact")({ reason: "threshold" }, ctx);
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: re-entry/);
  pi.events.emit("subagents:started", { id: "worker-3", type: "ImplementationWorker" });
  await pi.handlers.get("session_compact_failed")({ reason: "overflow" }, ctx);
  assert.match(reminderContent(await orchestratorReminder()), /Current lifecycle phase: re-entry/);

  await pi.commands.get("yolo").handler(undefined, ctx);
  assert.deepEqual(pi.active, [...pi.tools.keys()]);
  assert.equal(await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }), undefined);
  await pi.commands.get("plan").handler(undefined, ctx);
  assert.ok(pi.active.includes("read"));
  assert.equal(pi.active.includes("write"), false);
  await pi.handlers.get("session_shutdown")({}, ctx);
  assert.equal(pi.eventListeners.get("subagents:started")?.size ?? 0, 0);
  assert.equal(pi.eventListeners.get("subagents:completed")?.size ?? 0, 0);
  assert.equal(pi.eventListeners.get("subagents:failed")?.size ?? 0, 0);

  const resumedPi = mockPi();
  await registerPlanMode(resumedPi);
  const resumedCtx = mockContext([{
    type: "custom",
    customType: "pi-plan-mode-state",
    data: { mode: "ORCHESTRATOR" },
  }, {
    // Compaction context is model-facing metadata, never an extension mode source.
    type: "compaction",
    summary: "<session_mode>investigate</session_mode>",
    details: { session_mode: "PLAN" },
  }]);
  await resumedPi.handlers.get("session_start")({}, resumedCtx);
  assert.deepEqual(resumedPi.active, [...resumedPi.tools.keys()]);
  const resumedStart = await resumedPi.handlers.get("before_agent_start")({ systemPrompt: "base" });
  assert.match(resumedStart.systemPrompt, /ORCHESTRATOR MODE IS ACTIVE/);
  assert.equal(resumedPi.handlers.get("user_bash")({}, resumedCtx), undefined);
  await resumedPi.handlers.get("session_shutdown")({}, resumedCtx);
});

test("managed plans record bounded recommendations and approval puts the recommendation first", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);

  const draftTool = pi.tools.get("manage_plan_draft");
  const approvalTool = pi.tools.get("submit_plan_for_approval");
  const created = await draftTool.execute("recommendation", {
    action: "create",
    plan: "# Parallel implementation\n\nParent recommendation: ORCHESTRATOR\nCompaction advice: compact-first\n\n1. Split independent work.",
  }, undefined, undefined, ctx);
  const metadata = JSON.parse(readFileSync(created.details.planPath, "utf8").split("---")[1]);
  assert.equal(metadata.recommendedMode, "ORCHESTRATOR");
  assert.equal(metadata.recommendCompaction, true);
  assert.equal(metadata.parentRecommendation, "ORCHESTRATOR");
  assert.equal(metadata.recommendation, "ORCHESTRATOR");
  assert.equal(metadata.compactionAdvice, "compact-first");
  assert.ok(Array.isArray(metadata.recommendationSignals));

  ctx.selections.push("Compact + ORCHESTRATOR (Recommended)");
  const approval = await approvalTool.execute("recommendation-approval", { planPath: created.details.planPath }, undefined, undefined, ctx);
  assert.equal(approval.details.action, "orchestrator-compact");
  assert.equal(ctx.selectCalls.at(-1).options[0], "Compact + ORCHESTRATOR (Recommended)");
  assert.match(ctx.selectCalls.at(-1).title, /YOLO:/);
  assert.match(ctx.selectCalls.at(-1).title, /ORCHESTRATOR:/);
  assert.doesNotMatch(ctx.selectCalls.at(-1).title, /PREWALK:/);
  assert.equal(ctx.selectCalls.at(-1).options.some((option) => /PREWALK/.test(option)), false);
  assert.match(ctx.selectCalls.at(-1).title, /sole approval/);
  assert.equal(pi.active.includes("write"), false, "recommendations must not switch modes");
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("actionable revisions return a parent-owned ask_user_question proposal and Apply writes only on replace", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  const draftTool = pi.tools.get("manage_plan_draft");
  const approvalTool = pi.tools.get("submit_plan_for_approval");
  const created = await draftTool.execute("revision-apply", { action: "create", plan: "# Current\n\n1. Keep the current behavior." }, undefined, undefined, ctx);
  const planPath = created.details.planPath;
  const original = readFileSync(planPath, "utf8");
  ctx.selections.push("Request revisions…");
  ctx.inputs.push("Add rollback steps");
  const requested = await approvalTool.execute("revision-request", { planPath }, undefined, undefined, ctx);
  assert.equal(requested.details.clarificationRequired, false);
  assert.deepEqual(requested.details.proposalOptions, [
    "Apply these updates (Recommended)",
    "Keep the current plan",
  ]);
  assert.equal(requested.details.proposalFreeText, true);
  assert.equal(requested.details.revisionProposal.tool, "ask_user_question");
  assert.equal(requested.details.revisionProposal.question, "Review these proposed updates to the managed plan.");
  assert.equal(requested.details.revisionProposal.freeText, true);
  assert.match(requested.details.revisionProposal.freeTextInstruction, /standard free-text row/);
  assert.match(requested.content[0].text, /exactly one ask_user_question/);
  assert.match(requested.content[0].text, /standard free-text row/);
  assert.equal(readFileSync(planPath, "utf8"), original, "revision feedback must not write the artifact");
  assert.deepEqual(draftTool.parameters.properties.action.enum, ["create", "replace"]);
  assert.equal(draftTool.parameters.properties.summary, undefined);
  await assert.rejects(() => draftTool.execute("obsolete-preview", {
    action: "preview",
    planPath,
    plan: "# Must not write",
  }, undefined, undefined, ctx), /use create or replace/);
  assert.equal(readFileSync(planPath, "utf8"), original, "obsolete preview actions cannot write");
  assert.equal(ctx.selectCalls.length, 1, "the extension must not render a revision proposal UI");

  // The parent owns the proposal result. Apply is represented by its ordinary
  // replace call, followed immediately by the sole approval tool.
  const replaced = await draftTool.execute("revision-replace", {
    action: "replace",
    planPath,
    plan: "# Revised\n\nParent recommendation: ORCHESTRATOR\nCompaction advice: direct\n\n1. Add rollback steps.",
  }, undefined, undefined, ctx);
  assert.equal(replaced.details.planPath, planPath);
  assert.match(readFileSync(planPath, "utf8"), /Add rollback steps/);
  assert.match(readFileSync(planPath, "utf8"), /\"recommendedMode\": \"ORCHESTRATOR\"/);
  assert.equal(pi.entries.at(-1).data.revisionFeedback, null, "successful replacement clears pending feedback");
  ctx.selections.push("Implement with YOLO");
  const approval = await approvalTool.execute("revision-approval", { planPath }, undefined, undefined, ctx);
  assert.match(approval.content[0].text, /Approval recorded/);
  assert.equal(ctx.selectCalls.length, 2, "replacement is followed by one ordinary approval UI");
  assert.equal(pi.active.includes("write"), false, "replacement and approval do not transition inside the tool call");
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("revision Keep resubmits the current plan and further feedback does not write", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  const draftTool = pi.tools.get("manage_plan_draft");
  const approvalTool = pi.tools.get("submit_plan_for_approval");
  const created = await draftTool.execute("revision-keep", { action: "create", plan: "# Current\n\n1. Keep this." }, undefined, undefined, ctx);
  const planPath = created.details.planPath;
  const original = readFileSync(planPath, "utf8");
  ctx.selections.push("Request revisions…");
  ctx.inputs.push("Add a validation step");
  await approvalTool.execute("revision-keep-request", { planPath }, undefined, undefined, ctx);
  // The parent selected Keep in ask_user_question and now resubmits the same
  // path; the approval selection below is the separate implementation choice.
  ctx.selections.push("Implement with YOLO");
  const kept = await approvalTool.execute("revision-keep-submit", { planPath }, undefined, undefined, ctx);
  assert.match(kept.content[0].text, /Approval recorded/);
  assert.equal(readFileSync(planPath, "utf8").split("<!-- approval-status:")[0].trimEnd(), original.split("<!-- approval-status:")[0].trimEnd());
  assert.equal(pi.entries.at(-1).data.revisionFeedback, null, "Keep clears pending feedback without replacing the plan");

  await pi.commands.get("plan").handler(undefined, ctx);
  const customCreated = await draftTool.execute("revision-custom", { action: "create", plan: "# Custom feedback plan" }, undefined, undefined, ctx);
  const customPath = customCreated.details.planPath;
  const beforeCustom = readFileSync(customPath, "utf8");
  ctx.selections.push("Request revisions…");
  ctx.inputs.push("Move validation before deployment");
  const custom = await approvalTool.execute("revision-custom-request", { planPath: customPath }, undefined, undefined, ctx);
  assert.equal(custom.details.clarificationRequired, false);
  assert.equal(custom.details.feedback, "Move validation before deployment");
  assert.equal(pi.entries.at(-1).data.revisionFeedback, "Move validation before deployment");
  assert.equal(readFileSync(customPath, "utf8"), beforeCustom);
  assert.match(custom.content[0].text, /without a plan write/);
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("ambiguous revision feedback requires ask_user_question before a proposal", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  const draftTool = pi.tools.get("manage_plan_draft");
  const approvalTool = pi.tools.get("submit_plan_for_approval");
  const created = await draftTool.execute("revision-clarify", { action: "create", plan: "# Current" }, undefined, undefined, ctx);
  ctx.selections.push("Request revisions…");
  ctx.inputs.push("Make it better");
  const result = await approvalTool.execute("revision-clarify-request", { planPath: created.details.planPath }, undefined, undefined, ctx);
  assert.equal(result.details.clarificationRequired, true);
  assert.equal(result.details.clarificationTool, "ask_user_question");
  assert.match(result.content[0].text, /ask_user_question/);
  assert.match(result.content[0].text, /clarification/);
  assert.doesNotMatch(result.content[0].text, /manage_plan_draft.*(?:preview|replace)/i);
  assert.equal(ctx.selectCalls.length, 1, "ambiguous feedback must not show a revision proposal UI");
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("pending revision feedback persists and restores through startup, tree, and compaction", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext(pi.entries, undefined);
  await pi.handlers.get("session_start")({}, ctx);
  const draftTool = pi.tools.get("manage_plan_draft");
  const approvalTool = pi.tools.get("submit_plan_for_approval");
  const created = await draftTool.execute("revision-persist", { action: "create", plan: "# Current\n\n1. Keep this." }, undefined, undefined, ctx);
  const planPath = created.details.planPath;
  ctx.selections.push("Request revisions…");
  ctx.inputs.push("Add rollback steps");
  await approvalTool.execute("revision-persist-request", { planPath }, undefined, undefined, ctx);
  assert.equal(pi.entries.at(-1).data.revisionFeedback, "Add rollback steps");

  const reminder = await pi.handlers.get("context")({ messages: [] });
  assert.match(reminder.messages.at(-1).content, /Pending revision feedback/);
  assert.match(reminder.messages.at(-1).content, /Add rollback steps/);
  assert.match(reminder.messages.at(-1).content, /exactly one ask_user_question/);

  await pi.handlers.get("session_compact")({ reason: "threshold" }, ctx);
  const afterCompaction = await pi.handlers.get("context")({ messages: [] });
  assert.match(afterCompaction.messages.at(-1).content, /Parent PLAN re-entry/);
  assert.match(afterCompaction.messages.at(-1).content, /Add rollback steps/);

  pi.entries.splice(0, pi.entries.length,
    { type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } },
    { type: "custom", customType: "pi-plan-mode-plan-context", data: {
      planPath,
      status: "revision-requested",
      revisionFeedback: "Add rollback steps",
    } },
  );
  await pi.handlers.get("session_tree")({ newLeafId: "revision" }, ctx);
  const afterTree = await pi.handlers.get("context")({ messages: [] });
  assert.match(afterTree.messages.at(-1).content, /Add rollback steps/);
  assert.match(afterTree.messages.at(-1).content, /exactly these two authored options/);

  const oversized = "Keep this bounded: " + "x".repeat(3000);
  const resumedPi = mockPi();
  await registerPlanMode(resumedPi);
  const resumedCtx = mockContext([
    { type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } },
    { type: "custom", customType: "pi-plan-mode-plan-context", data: {
      planPath,
      status: "revision-requested",
      revisionFeedback: oversized,
    } },
  ], undefined);
  await resumedPi.handlers.get("session_start")({}, resumedCtx);
  const restored = await resumedPi.handlers.get("context")({ messages: [] });
  assert.match(restored.messages.at(-1).content, /Keep this bounded/);
  assert.ok(restored.messages.at(-1).content.includes("x".repeat(2000 - "Keep this bounded: ".length)));
  assert.ok(!restored.messages.at(-1).content.includes("x".repeat(3000)));
  await resumedPi.handlers.get("session_shutdown")({}, resumedCtx);
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("malformed pending revision feedback is ignored rather than coerced", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const planDirectory = join(process.env.PI_PLAN_DIR, "malformed");
  mkdirSync(planDirectory, { recursive: true });
  const planPath = join(planDirectory, "plan.md");
  writeFileSync(planPath, "# Current\n");
  const ctx = mockContext([
    { type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } },
    { type: "custom", customType: "pi-plan-mode-plan-context", data: {
      planPath,
      status: "revision-requested",
      revisionFeedback: { unexpected: "object" },
    } },
  ], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  const reminder = await pi.handlers.get("context")({ messages: [] });
  assert.doesNotMatch(reminder.messages.at(-1).content, /unexpected|\[object Object\]/);
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("PLAN reminders attach initially, follow the exact cadence, and stay transient", async (t) => {
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.commands.get("plan").handler(undefined, ctx);

  const attach = async () => pi.handlers.get("context")({ messages: [{ role: "user", content: "inspect" }] });
  const hasReminder = (result) => result.messages.some((message) => message.customType === "pi-plan-mode-plan-reminder");
  const reminder = (result) => result.messages.find((message) => message.customType === "pi-plan-mode-plan-reminder");

  const duplicateInput = [
    { role: "user", content: "inspect" },
    { role: "custom", customType: "pi-plan-mode-plan-reminder", content: "old one" },
    { role: "custom", customType: "pi-plan-mode-plan-reminder", content: "old two" },
  ];
  const initial = await pi.handlers.get("context")({ messages: duplicateInput });
  assert.equal(hasReminder(initial), true);
  assert.equal(initial.messages.filter((message) => message.customType === "pi-plan-mode-plan-reminder").length, 1);
  assert.match(reminder(initial).content, /Parent planning workflow/);
  assert.equal(reminder(initial).display, false);
  assert.equal(typeof reminder(initial).timestamp, "number");
  assert.equal(duplicateInput.length, 3);

  for (let attachmentNumber = 2; attachmentNumber <= 6; attachmentNumber += 1) {
    for (let turn = 0; turn < 5; turn += 1) {
      await pi.handlers.get("turn_start")({}, ctx);
      const result = await attach();
      assert.equal(hasReminder(result), turn === 4, `unexpected attachment before #${attachmentNumber}`);
      if (turn === 4) {
        assert.match(reminder(result).content, attachmentNumber === 6 ? /Parent planning workflow/ : /Parent clarification reminder/);
      }
    }
    if (attachmentNumber === 6) break;
    const result = await attach();
    assert.equal(hasReminder(result), false, `extra attachment after #${attachmentNumber}`);
  }

  const entriesBefore = pi.entries.length;
  assert.equal(pi.entries.some((entry) => entry.customType === "pi-plan-mode-plan-reminder"), false);
  assert.equal(pi.entries.length, entriesBefore);
  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("blocked calls and managed-plan changes force sparse PLAN reminders", async (t) => {
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.commands.get("plan").handler(undefined, ctx);
  const context = () => pi.handlers.get("context")({ messages: [] });
  await context();

  const blocked = await pi.handlers.get("tool_call")({ toolName: "edit", input: { path: "x" } });
  assert.equal(blocked.block, true);
  const afterBlock = await context();
  assert.match(afterBlock.messages.at(-1).content, /Parent clarification reminder/);

  const draft = await pi.tools.get("manage_plan_draft").execute("draft", {
    action: "create",
    plan: "# Test plan\\n\\n1. Verify lifecycle.",
  }, undefined, undefined, ctx);
  assert.equal(pi.entries.at(-1).customType, "pi-plan-mode-plan-context");
  assert.equal(pi.entries.at(-1).data.status, "created");
  assert.equal(pi.entries.at(-1).data.planPath, draft.details.planPath);
  const afterDraft = await context();
  assert.match(afterDraft.messages.at(-1).content, /Parent clarification reminder/);
  assert.match(afterDraft.messages.at(-1).content, /Live managed plan status: created/);

  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("compaction re-enters PLAN with full parent guidance on success and failure", async (t) => {
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext([], undefined);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.commands.get("plan").handler(undefined, ctx);
  await pi.handlers.get("context")({ messages: [] });

  for (const reason of ["manual", "threshold", "overflow"]) {
    await pi.handlers.get("session_compact")({ reason }, ctx);
    const success = await pi.handlers.get("context")({ messages: [] });
    assert.match(success.messages.at(-1).content, /Parent PLAN re-entry/);
  }

  await pi.handlers.get("session_compact_failed")({ reason: "overflow", aborted: true }, ctx);
  const failure = await pi.handlers.get("context")({ messages: [] });
  assert.match(failure.messages.at(-1).content, /Parent planning workflow/);
  assert.doesNotMatch(failure.messages.at(-1).content, /Parent PLAN re-entry/);

  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("session tree restores branch-local mode and managed plan context", async (t) => {
  isolatedEnvironment(t);
  const pi = mockPi();
  await registerPlanMode(pi);
  const ctx = mockContext(pi.entries, undefined);
  await pi.handlers.get("session_start")({}, ctx);
  await pi.commands.get("plan").handler(undefined, ctx);
  const draft = await pi.tools.get("manage_plan_draft").execute("draft", {
    action: "create",
    plan: "# Branch plan",
  }, undefined, undefined, ctx);
  const planPath = draft.details.planPath;

  pi.entries.splice(0, pi.entries.length,
    { type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } },
    { type: "custom", customType: "pi-plan-mode-plan-context", data: { planPath, status: "revised" } },
  );
  await pi.handlers.get("session_tree")({ newLeafId: "plan" }, ctx);
  const planContext = await pi.handlers.get("context")({ messages: [] });
  assert.equal(pi.active.includes("write"), false);
  assert.ok(planContext.messages.at(-1).content.includes(`Live managed plan path: ${planPath}.`));
  assert.match(planContext.messages.at(-1).content, /Live managed plan status: revised/);

  const resumedPi = mockPi();
  await registerPlanMode(resumedPi);
  const resumedCtx = mockContext([
    { type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } },
    { type: "custom", customType: "pi-plan-mode-plan-context", data: { planPath, status: "approved" } },
  ], undefined);
  await resumedPi.handlers.get("session_start")({}, resumedCtx);
  const restoredContext = await resumedPi.handlers.get("context")({ messages: [] });
  assert.match(restoredContext.messages.at(-1).content, /Live managed plan status: approved/);
  assert.ok(restoredContext.messages.at(-1).content.includes(`Live managed plan path: ${planPath}.`));
  await resumedPi.handlers.get("session_shutdown")({}, resumedCtx);

  pi.entries.splice(0, pi.entries.length, { type: "custom", customType: "pi-plan-mode-state", data: { mode: "YOLO" } });
  await pi.handlers.get("session_tree")({ newLeafId: "yolo" }, ctx);
  const yoloContext = await pi.handlers.get("context")({ messages: [{ customType: "pi-plan-mode-plan-reminder", content: "stale" }] });
  assert.equal(pi.active.includes("write"), true);
  assert.equal(yoloContext.messages.some((message) => message.customType === "pi-plan-mode-plan-reminder"), false);

  pi.entries.splice(0, pi.entries.length, { type: "custom", customType: "pi-plan-mode-state", data: { mode: "ORCHESTRATOR" } });
  await pi.handlers.get("session_tree")({ newLeafId: "orchestrator" }, ctx);
  const orchestratorContext = await pi.handlers.get("context")({ messages: [{ customType: "pi-plan-mode-plan-reminder", content: "stale" }] });
  assert.deepEqual(pi.active, [...pi.tools.keys()]);
  assert.equal(orchestratorContext.messages.some((message) => message.customType === "pi-plan-mode-plan-reminder"), false);
  assert.match((await pi.handlers.get("before_agent_start")({ systemPrompt: "base" })).systemPrompt, /ORCHESTRATOR MODE IS ACTIVE/);

  await pi.handlers.get("session_shutdown")({}, ctx);
});

test("malformed child probe safely defaults to the parent PLAN contract", async (t) => {
  isolatedEnvironment(t);
  const key = Symbol.for("pi-subagents:child-context:v1");
  const registry = globalThis;
  const previous = registry[key];
  registry[key] = { malformed: true };
  try {
    const pi = mockPi();
    await registerPlanMode(pi);
    const ctx = mockContext([], undefined);
    await pi.handlers.get("session_start")({}, ctx);
    assert.equal(pi.active.includes("manage_plan_draft"), true);
    assert.equal(pi.active.includes("submit_plan_for_approval"), true);
    const baseline = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(baseline.systemPrompt, /The parent remains responsible/);
    assert.doesNotMatch(baseline.systemPrompt, /child planning agent/);
    await pi.handlers.get("session_shutdown")({}, ctx);
  } finally {
    if (previous === undefined) delete registry[key];
    else registry[key] = previous;
  }
});

test("approved pending recovery is branch-local, explicit, and idempotent", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  const root = isolatedEnvironment(t);
  const sessionFile = join(root, "approval-session.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const firstPi = mockPi();
  await registerPlanMode(firstPi);
  const firstCtx = mockContext([], sessionFile);
  await firstPi.handlers.get("session_start")({}, firstCtx);
  const draft = await firstPi.tools.get("manage_plan_draft").execute("draft", {
    action: "create",
    plan: "# Recovery\n\nParent recommendation: ORCHESTRATOR\n\n1. Implement safely.",
  }, undefined, undefined, firstCtx);
  const planPath = draft.details.planPath;
  firstCtx.selections.push("Implement with YOLO");
  await firstPi.tools.get("submit_plan_for_approval").execute("approve", { planPath }, undefined, undefined, firstCtx);
  const pendingEntry = firstPi.entries.findLast((entry) => entry.customType === "pi-plan-mode-plan-context" && entry.data.status === "approved-pending");
  assert.equal(pendingEntry.data.version, 1);
  assert.equal(pendingEntry.data.approvalAction, "yolo-direct");
  assert.equal(pendingEntry.data.planPath, planPath);
  assert.equal(firstPi.active.includes("write"), false);
  await firstPi.handlers.get("session_shutdown")({}, firstCtx);

  const resumedPi = mockPi();
  await registerPlanMode(resumedPi);
  const resumedCtx = mockContext(firstPi.entries, sessionFile);
  resumedCtx.selections.push("Resume approved implementation");
  await resumedPi.handlers.get("session_start")({}, resumedCtx);
  assert.deepEqual(resumedCtx.selectCalls.at(-1).options, ["Resume approved implementation", "Stay in PLAN"]);
  assert.equal(resumedPi.active.includes("write"), true, "resume uses the selected YOLO action, not the recommendation");
  assert.equal(resumedPi.sentMessages.length, 1);
  const transitionIndex = resumedPi.entries.findIndex((entry) => entry.customType === "pi-plan-mode-plan-context" && entry.data.status === "transition-started");
  const yoloStateIndex = resumedPi.entries.findLastIndex((entry) => entry.customType === "pi-plan-mode-state" && entry.data.mode === "YOLO");
  assert.ok(transitionIndex >= 0 && transitionIndex < yoloStateIndex, "transition is durable before mode switch");
  await resumedPi.handlers.get("agent_settled")({}, resumedCtx);
  assert.equal(resumedPi.sentMessages.length, 1, "a resumed transition cannot be consumed twice");
  await resumedPi.handlers.get("session_shutdown")({}, resumedCtx);

  const transitionedPi = mockPi();
  await registerPlanMode(transitionedPi);
  const transitionedCtx = mockContext(resumedPi.entries, sessionFile);
  await transitionedPi.handlers.get("session_start")({ reason: "startup" }, transitionedCtx);
  assert.equal(transitionedCtx.selectCalls.length, 0, "transition-started marker blocks recovery");
  await transitionedPi.handlers.get("session_shutdown")({}, transitionedCtx);
});

test("Stay in PLAN preserves pending approval across reloads and headless restore", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  const root = isolatedEnvironment(t);
  const sessionFile = join(root, "stay-session.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const firstPi = mockPi();
  await registerPlanMode(firstPi);
  const firstCtx = mockContext([], sessionFile);
  await firstPi.handlers.get("session_start")({}, firstCtx);
  const draft = await firstPi.tools.get("manage_plan_draft").execute("draft", { action: "create", plan: "# Stay\n\n1. Wait." }, undefined, undefined, firstCtx);
  firstCtx.selections.push("Implement with YOLO");
  await firstPi.tools.get("submit_plan_for_approval").execute("approve", { planPath: draft.details.planPath }, undefined, undefined, firstCtx);
  await firstPi.handlers.get("session_shutdown")({}, firstCtx);

  const stayPi = mockPi();
  await registerPlanMode(stayPi);
  const stayCtx = mockContext(firstPi.entries, sessionFile);
  stayCtx.selections.push("Stay in PLAN");
  await stayPi.handlers.get("session_start")({}, stayCtx);
  assert.equal(stayPi.active.includes("write"), false);
  assert.equal(stayCtx.selectCalls.at(-1).options.length, 2);
  await stayPi.handlers.get("session_tree")({ newLeafId: "same-pending-branch" }, stayCtx);
  assert.equal(stayCtx.selectCalls.length, 1, "tree navigation never repeats the startup prompt");
  assert.equal(stayPi.active.includes("write"), false);
  await stayPi.handlers.get("agent_settled")({}, stayCtx);
  assert.equal(stayPi.sentMessages.length, 0, "Stay cannot be consumed by agent_settled");
  await stayPi.handlers.get("session_shutdown")({}, stayCtx);

  const reloadedPi = mockPi();
  await registerPlanMode(reloadedPi);
  const reloadedCtx = mockContext(firstPi.entries, sessionFile);
  await reloadedPi.handlers.get("session_start")({ reason: "reload" }, reloadedCtx);
  assert.equal(reloadedCtx.selectCalls.length, 0, "same-process extension reload does not duplicate the prompt");
  await reloadedPi.handlers.get("agent_settled")({}, reloadedCtx);
  assert.equal(reloadedPi.sentMessages.length, 0);
  await reloadedPi.handlers.get("session_shutdown")({}, reloadedCtx);

  const forkPi = mockPi();
  await registerPlanMode(forkPi);
  const forkCtx = mockContext(firstPi.entries, sessionFile);
  await forkPi.handlers.get("session_start")({ reason: "fork" }, forkCtx);
  assert.equal(forkCtx.selectCalls.length, 0, "fork restore does not repeat the prompt");
  assert.equal(forkPi.active.includes("write"), false);
  await forkPi.handlers.get("session_shutdown")({}, forkCtx);

  const headlessPi = mockPi();
  await registerPlanMode(headlessPi);
  const headlessCtx = mockContext(firstPi.entries, sessionFile);
  headlessCtx.hasUI = false;
  await headlessPi.handlers.get("session_start")({}, headlessCtx);
  assert.equal(headlessCtx.selectCalls.length, 0);
  assert.equal(headlessPi.active.includes("write"), false, "headless restore remains PLAN");
  await headlessPi.handlers.get("agent_settled")({}, headlessCtx);
  assert.equal(headlessPi.sentMessages.length, 0);
  await headlessPi.handlers.get("session_shutdown")({}, headlessCtx);

  const realRestartPi = mockPi();
  await registerPlanMode(realRestartPi);
  const realRestartCtx = mockContext(firstPi.entries, sessionFile);
  realRestartCtx.selections.push("Stay in PLAN");
  await realRestartPi.handlers.get("session_start")({ reason: "startup" }, realRestartCtx);
  assert.deepEqual(realRestartCtx.selectCalls.at(-1).options, ["Resume approved implementation", "Stay in PLAN"]);
  await realRestartPi.handlers.get("session_shutdown")({}, realRestartCtx);
});

test("malformed, legacy, symlinked, and stale approval records never resume", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  const root = isolatedEnvironment(t);
  const planDirectory = join(process.env.PI_PLAN_DIR, "restore-validation");
  mkdirSync(planDirectory, { recursive: true });
  const planPathCandidate = join(planDirectory, "plan.md");
  writeFileSync(planPathCandidate, "# Current\n");
  const planPath = realpathSync(planPathCandidate);
  const cases = [
    { name: "action", data: { version: 1, status: "approved-pending", approvalAction: "not-an-action", planPath } },
    { name: "legacy", data: { status: "approved", pendingApproval: { action: "yolo-direct", planPath } } },
    { name: "stale", data: { version: 1, status: "approved-pending", approvalAction: "yolo-direct", planPath: join(planDirectory, "missing", "plan.md") } },
  ];
  for (const item of cases) {
    const pi = mockPi();
    await registerPlanMode(pi);
    const ctx = mockContext([
      { type: "custom", customType: "pi-plan-mode-state", data: { mode: "ORCHESTRATOR" } },
      { type: "custom", customType: "pi-plan-mode-plan-context", data: { planPath, status: "approved" } },
      { type: "custom", customType: "pi-plan-mode-plan-context", data: item.data },
    ], join(root, `${item.name}.jsonl`));
    writeFileSync(ctx.sessionManager.getSessionFile(), "{}\n");
    await pi.handlers.get("session_start")({}, ctx);
    assert.equal(ctx.selectCalls.length, 0, `${item.name} must not prompt`);
    assert.equal(pi.active.includes("write"), true, `${item.name} does not grant a resume`);
    await pi.handlers.get("agent_settled")({}, ctx);
    assert.equal(pi.sentMessages.length, 0);
    await pi.handlers.get("session_shutdown")({}, ctx);
  }

  const outside = join(root, "outside.md");
  writeFileSync(outside, "# outside\n");
  const link = join(planDirectory, "symlink-plan.md");
  symlinkSync(outside, link);
  const symlinkPi = mockPi();
  await registerPlanMode(symlinkPi);
  const symlinkCtx = mockContext([
    { type: "custom", customType: "pi-plan-mode-state", data: { mode: "ORCHESTRATOR" } },
    { type: "custom", customType: "pi-plan-mode-plan-context", data: { version: 1, status: "approved-pending", approvalAction: "yolo-direct", planPath: link } },
  ], join(root, "symlink.jsonl"));
  writeFileSync(symlinkCtx.sessionManager.getSessionFile(), "{}\n");
  await symlinkPi.handlers.get("session_start")({}, symlinkCtx);
  assert.equal(symlinkCtx.selectCalls.length, 0);
  assert.equal(symlinkPi.active.includes("write"), true);
  await symlinkPi.handlers.get("session_shutdown")({}, symlinkCtx);
});

test("resume executes each managed YOLO/ORCHESTRATOR action once, including compact callbacks", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }
  const root = isolatedEnvironment(t);

  const actions = [
    ["yolo-direct", "YOLO"],
    ["orchestrator-direct", "ORCHESTRATOR"],
    ["yolo-compact", "YOLO"],
    ["orchestrator-compact", "ORCHESTRATOR"],
  ];
  for (const [action, expectedMode] of actions) {
    const slug = action.replace(/-/g, "_");
    const directory = join(process.env.PI_PLAN_DIR, slug);
    mkdirSync(directory, { recursive: true });
    const planPathCandidate = join(directory, "plan.md");
    writeFileSync(planPathCandidate, `# ${action}\n\n1. Execute once.\n`);
    const planPath = realpathSync(planPathCandidate);
    const sessionFile = join(root, `${slug}.jsonl`);
    writeFileSync(sessionFile, "{}\n");
    const pi = mockPi();
    await registerPlanMode(pi);
    const ctx = mockContext([
      { type: "custom", customType: "pi-plan-mode-state", data: { mode: "PLAN" } },
      { type: "custom", customType: "pi-plan-mode-plan-context", data: { version: 1, status: "approved-pending", approvalAction: action, planPath } }
    ], sessionFile);
    ctx.selections.push("Resume approved implementation");
    await pi.handlers.get("session_start")({}, ctx);
    if (action.endsWith("compact")) {
      assert.equal(ctx.compactCalls.length, 1);
      ctx.compactCalls[0].onComplete({});
      ctx.compactCalls[0].onComplete({});
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(pi.sentMessages.length, 1);
      assert.equal(pi.active.includes("write"), expectedMode !== undefined);
      if (expectedMode === "ORCHESTRATOR") assert.deepEqual(pi.active, [...pi.tools.keys()]);
    } else {
      assert.equal(pi.sentMessages.length, 1);
      if (expectedMode === "YOLO") assert.equal(pi.active.includes("write"), true);
      else assert.deepEqual(pi.active, [...pi.tools.keys()]);
    }
    await pi.handlers.get("agent_settled")({}, ctx);
    assert.equal(pi.sentMessages.length, 1, `${action} is idempotent`);
    await pi.handlers.get("session_shutdown")({}, ctx);
  }
});

test("child PLAN captures the global probe and cannot own plan approval", async (t) => {
  isolatedEnvironment(t);
  const key = Symbol.for("pi-subagents:child-context:v1");
  const registry = globalThis;
  const previous = registry[key];
  registry[key] = () => true;
  try {
    const pi = mockPi();
    await registerPlanMode(pi);
    const ctx = mockContext([], undefined);
    await pi.handlers.get("session_start")({}, ctx);
    assert.equal(pi.active.includes("manage_plan_draft"), false);
    assert.equal(pi.active.includes("submit_plan_for_approval"), false);
    assert.equal(pi.eventListeners.get("subagents:started"), undefined);
    assert.equal(pi.eventListeners.get("subagents:completed"), undefined);
    assert.equal(pi.eventListeners.get("subagents:failed"), undefined);

    const baseline = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(baseline.systemPrompt, /child planning agent/);
    assert.doesNotMatch(baseline.systemPrompt, /submit_plan_for_approval|manage_plan_draft/);
    const childContext = await pi.handlers.get("context")({ messages: [] });
    assert.match(childContext.messages.at(-1).content, /return a concise .*handoff to the parent/i);
    assert.match(childContext.messages.at(-1).content, /No project or system write exception is available/);
    assert.doesNotMatch(childContext.messages.at(-1).content, /The only exception is the managed plan mechanism/);

    const blockedDraft = await pi.handlers.get("tool_call")({ toolName: "manage_plan_draft", input: {} });
    const blockedApproval = await pi.handlers.get("tool_call")({ toolName: "submit_plan_for_approval", input: {} });
    assert.equal(blockedDraft.block, true);
    assert.equal(blockedApproval.block, true);
    await pi.handlers.get("session_shutdown")({}, ctx);
  } finally {
    if (previous === undefined) delete registry[key];
    else registry[key] = previous;
  }
});
