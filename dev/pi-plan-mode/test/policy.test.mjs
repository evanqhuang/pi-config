import test from "node:test";
import assert from "node:assert/strict";
import {
  CHILD_PLAN_BLOCKED_TOOLS,
  PLAN_DELEGATION_LIMITS,
  PLAN_TOOLS,
  applyMode,
  delegationProfile,
  filterTools,
  isAllowedTool,
  isReadOnlyBatch,
  isReadOnlyCommand,
  modeNames,
  planToolNames,
  restoreMode,
} from "../src/policy.mjs";

test("exposes exactly PLAN, ORCHESTRATOR, and YOLO", () => {
  assert.deepEqual(modeNames(), ["PLAN", "ORCHESTRATOR", "YOLO"]);
});

test("PLAN is an explicit read-only allowlist and unknown tools fail closed", () => {
  assert.ok(PLAN_TOOLS.includes("read"));
  assert.ok(PLAN_TOOLS.includes("bash"));
  assert.ok(PLAN_TOOLS.includes("ctx_execute"));
  assert.ok(PLAN_TOOLS.includes("ctx_batch_execute"));
  assert.ok(PLAN_TOOLS.includes("checkpoint_notes"));
  assert.ok(PLAN_TOOLS.includes("manage_plan_draft"));
  assert.ok(PLAN_TOOLS.includes("Agent"));
  assert.deepEqual(planToolNames(), PLAN_TOOLS);
  for (const tool of ["edit", "write", "apply_patch", "delegate", "subagent", "ctx_purge", "ctx_upgrade", "unknown_tool"]) {
    assert.equal(isAllowedTool("PLAN", tool), false, tool);
  }
  assert.equal(isAllowedTool("PLAN", "checkpoint_notes"), true);
  assert.equal(isAllowedTool("ORCHESTRATOR", "apply_patch"), true);
  assert.equal(isAllowedTool("YOLO", "apply_patch"), true);
});

test("filtering is re-applied to dynamically registered tools", () => {
  assert.deepEqual(filterTools("PLAN", ["read", "write", "checkpoint_notes", "late_tool", "bash"]), ["read", "checkpoint_notes", "bash"]);
  assert.deepEqual(filterTools("ORCHESTRATOR", ["read", "write", "late_tool"]), ["read", "write", "late_tool"]);
  assert.deepEqual(filterTools("YOLO", ["read", "write", "late_tool"]), ["read", "write", "late_tool"]);
});

test("applyMode stores modes and gives ORCHESTRATOR and YOLO the complete set", () => {
  const state = { active: ["read", "write", "Agent"], persisted: undefined };
  applyMode(state, "PLAN", ["read", "write", "Agent", "late_tool"]);
  assert.deepEqual(state.active, ["read", "Agent"]);
  assert.equal(state.persisted, "PLAN");
  applyMode(state, "ORCHESTRATOR", ["read", "write", "Agent", "late_tool"]);
  assert.deepEqual(state.active, ["read", "write", "Agent", "late_tool"]);
  assert.equal(state.persisted, "ORCHESTRATOR");
  applyMode(state, "YOLO", ["read", "write", "Agent", "late_tool"]);
  assert.deepEqual(state.active, ["read", "write", "Agent", "late_tool"]);
});

test("PLAN delegation is limited to bounded one-shot read-only profiles", () => {
  assert.deepEqual(PLAN_DELEGATION_LIMITS, { Explore: 24, Plan: 16 });
  assert.deepEqual(delegationProfile({ subagent_type: "Explore" }), {
    allowed: true,
    profile: "plan-readonly",
    subagentType: "Explore",
    inheritPlan: true,
    maxTurns: 24,
  });
  assert.equal(delegationProfile({ subagent_type: "plan" }).subagentType, "Plan");
  assert.equal(delegationProfile({ subagent_type: "plan" }).maxTurns, 16);
  assert.equal(delegationProfile({ subagent_type: "Explore", max_turns: 7 }).maxTurns, 7);
  assert.equal(delegationProfile({ subagent_type: "Explore", max_turns: 24 }).maxTurns, 24);
  assert.equal(delegationProfile({ subagent_type: "Explore", max_turns: 99 }).maxTurns, 24);
  assert.equal(delegationProfile({ subagent_type: "Plan", max_turns: 4 }).maxTurns, 4);
  assert.equal(delegationProfile({ subagent_type: "Plan", max_turns: 16 }).maxTurns, 16);
  assert.equal(delegationProfile({ subagent_type: "Plan", max_turns: 99 }).maxTurns, 16);
  for (const max_turns of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = delegationProfile({ subagent_type: "Explore", max_turns });
    assert.equal(result.allowed, false, String(max_turns));
    assert.match(result.reason, /finite positive integer/);
  }
  for (const request of [
    { subagent_type: "Explore", resume: "prior-agent" },
    { subagent_type: "Plan", schedule: "+10m" },
  ]) {
    const result = delegationProfile(request);
    assert.equal(result.allowed, false);
    assert.match(result.reason, /one-shot|cannot be scheduled/);
  }
  assert.equal(delegationProfile({ subagent_type: "LunaCompliance" }).allowed, false);
  assert.equal(delegationProfile({ subagent_type: "LunaTestVerifier" }).allowed, false);
  assert.equal(delegationProfile({ mode: "plan", agent: "explorer" }).allowed, false);
  assert.equal(delegationProfile({ subagent_type: "worker" }).allowed, false);
  assert.equal(delegationProfile([]).allowed, false);
  assert.equal(delegationProfile({}).allowed, false);
});

test("child PLAN explicitly blocks orchestration and parent-owned plan tools", () => {
  assert.deepEqual(CHILD_PLAN_BLOCKED_TOOLS, [
    "Agent",
    "get_subagent_result",
    "steer_subagent",
    "manage_plan_draft",
    "submit_plan_for_approval",
    "checkpoint_notes",
  ]);
});

test("batch execution is automatically allowed only for read-only command shapes", () => {
  for (const command of ["git status --short", "git diff --stat", "rg -n TODO src", "find src -type f", "npm ls --depth=0"]) {
    assert.equal(isReadOnlyCommand(command), true, command);
  }
  for (const command of [
    "rm -rf /",
    "git status && touch marker",
    "find . -exec touch marker {} ;",
    "find . -fprint marker",
    "sort -o marker input",
    "sort --output=marker input",
    "git diff --output=marker",
    "/tmp/cat package.json",
    "node -e 'require(\"fs\").writeFileSync(\"x\",\"x\")'",
    "git commit -am x",
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command);
  }
  assert.equal(isReadOnlyBatch({ commands: [{ label: "status", command: "git status" }] }), true);
  assert.equal(isReadOnlyBatch({ commands: [{ label: "status", command: "git status" }, { label: "write", command: "touch x" }] }), false);
});

test("mode persistence defaults to YOLO and restores only known modes", () => {
  assert.equal(restoreMode([]), "YOLO");
  assert.equal(restoreMode([{ mode: "YOLO" }, { mode: "ORCHESTRATOR" }]), "ORCHESTRATOR");
  assert.equal(restoreMode([{ mode: "YOLO" }, { mode: "PLAN" }]), "PLAN");
  assert.equal(restoreMode([{ mode: "plan" }]), "PLAN");
  assert.equal(restoreMode([{ mode: "CODE" }]), "YOLO");
});
