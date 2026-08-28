import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgentSafetyPolicy } from "../src/agent-safety-policy.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { isolationParam, resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

const card = (name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  description: `${name} test card`,
  extensions: true,
  skills: true,
  systemPrompt: "",
  promptMode: "replace",
  ...overrides,
});

describe("verifier safety policy", () => {
  it("keeps the policy immutable and denies bash for LunaCompliance", () => {
    const policy = getAgentSafetyPolicy("LunaCompliance");

    expect(policy).toMatchObject({ disallowedTools: ["bash"] });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy?.disallowedTools)).toBe(true);

    const resolved = resolveAgentInvocationConfig(
      card("LunaCompliance", {
        disallowedTools: [],
        isolation: "off",
        worktreeDisposition: "commit",
        snapshotSource: false,
      }),
      {
        isolation: "worktree",
        worktree_disposition: "discard",
        snapshot_source: true,
      },
      { agentType: "LunaCompliance" },
    );

    expect(resolved.disallowedTools).toEqual(["bash"]);
    expect(resolved.isolation).toBeUndefined();
    expect(resolved.worktreeDisposition).toBe("commit");
    expect(resolved.snapshotSource).toBe(false);
  });

  it("applies LunaTestVerifier isolation and disposable snapshot after card and callsite resolution", () => {
    const resolved = resolveAgentInvocationConfig(
      card("LunaTestVerifier", {
        isolation: "off",
        worktreeDisposition: "commit",
        snapshotSource: false,
      }),
      {
        isolation: "off",
        worktree_disposition: "commit",
        snapshot_source: false,
        model: "caller-model",
        thinking: "high",
      },
      { agentType: "LunaTestVerifier" },
    );

    expect(resolved.isolation).toBe("worktree");
    expect(resolved.worktreeDisposition).toBe("discard");
    expect(resolved.snapshotSource).toBe(true);
    expect(resolved.modelInput).toBe("caller-model");
    expect(resolved.thinking).toBe("high");
    expect(resolved.policyError).toBeUndefined();
  });

  it("reports an unavailable policy instead of downgrading LunaTestVerifier", () => {
    const resolved = resolveAgentInvocationConfig(
      card("LunaTestVerifier", { isolation: "off" }),
      { isolation: "off", worktree_disposition: "commit", snapshot_source: false },
      { agentType: "LunaTestVerifier", worktreeAllowed: false },
    );

    expect(resolved.isolation).toBe("worktree");
    expect(resolved.worktreeDisposition).toBe("discard");
    expect(resolved.snapshotSource).toBe(true);
    expect(resolved.policyError).toContain("LunaTestVerifier");
    expect(resolved.policyError).toContain("worktree isolation is disabled");
    expect(resolved.policyError).toContain("will not downgrade");
  });

  it("retains ordinary worktree defaults and card-first strategy precedence", () => {
    const ordinary = resolveAgentInvocationConfig(card("ordinary"), {});
    expect(ordinary.isolation).toBeUndefined();
    expect(ordinary.worktreeDisposition).toBe("commit");
    expect(ordinary.snapshotSource).toBe(false);
    expect(ordinary.disallowedTools).toBeUndefined();

    const requestedDiscard = resolveAgentInvocationConfig(
      card("ordinary", { isolation: "worktree" }),
      { worktree_disposition: "discard" },
    );
    expect(requestedDiscard.isolation).toBe("worktree");
    expect(requestedDiscard.worktreeDisposition).toBe("discard");
    expect(requestedDiscard.snapshotSource).toBe(true);

    const cardWins = resolveAgentInvocationConfig(
      card("ordinary", { isolation: "worktree", worktreeDisposition: "commit", snapshotSource: false }),
      { isolation: "off", worktree_disposition: "discard", snapshot_source: true },
    );
    expect(cardWins.isolation).toBe("worktree");
    expect(cardWins.worktreeDisposition).toBe("commit");
    expect(cardWins.snapshotSource).toBe(false);
  });

  it("exposes only the strategy fields when worktrees are enabled", () => {
    expect(Object.keys(isolationParam(true))).toEqual([
      "isolation",
      "worktree_disposition",
      "snapshot_source",
    ]);
    expect(isolationParam(false)).toEqual({});
  });
});

describe("custom agent strategy frontmatter", () => {
  let tempRoot: string;
  let previousAgentDir: string | undefined;

  beforeEach(async () => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    tempRoot = await mkdtemp(join(tmpdir(), "pi-subagents-policy-"));
    process.env.PI_CODING_AGENT_DIR = join(tempRoot, "global-agent");
  });

  afterEach(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("loads canonical snake_case strategy fields", async () => {
    const cwd = join(tempRoot, "project");
    const agentsDir = join(cwd, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "strategy.md"),
      [
        "---",
        "name: strategy",
        "worktree_disposition: discard",
        "snapshot_source: false",
        "---",
        "body",
        "",
      ].join("\n"),
    );

    const loaded = loadCustomAgents(cwd).get("strategy");
    expect(loaded?.worktreeDisposition).toBe("discard");
    expect(loaded?.snapshotSource).toBe(false);
  });
});
