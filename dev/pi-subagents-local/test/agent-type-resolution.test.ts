import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRegistry, getFallbackSubagent, NO_FALLBACK, resolveSpawnTypeIn, setDefaultsDisabled, setFallbackSubagent } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { loadSettings } from "../src/settings.js";
import type { AgentConfig } from "../src/types.js";

const fixturePath = fileURLToPath(new URL("./fixtures/ImplementationWorker.md", import.meta.url));

const card = (name: string, overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name,
  description: `${name} test card`,
  extensions: true,
  skills: true,
  systemPrompt: "",
  promptMode: "replace",
  ...overrides,
});

const registry = (...cards: AgentConfig[]): Map<string, AgentConfig> =>
  new Map(cards.map((config) => [config.name, config] as const));

let tempRoot: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  tempRoot = await mkdtemp(join(tmpdir(), "pi-subagents-resolution-"));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "global-agent");
  setDefaultsDisabled(false);
  setFallbackSubagent(undefined);
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  setFallbackSubagent(undefined);
  setDefaultsDisabled(false);
  await rm(tempRoot, { recursive: true, force: true });
});

describe("fresh agent type resolution", () => {
  it("fails closed for an unknown type by default", () => {
    expect(getFallbackSubagent()).toBe(NO_FALLBACK);
    const result = resolveSpawnTypeIn(registry(card("general-purpose")), "ImplementationWorker");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Unknown or disabled agent type");
      expect(result.message).toContain("general-purpose");
    }
  });

  it("fails closed for a disabled type by default", () => {
    const result = resolveSpawnTypeIn(
      registry(card("ImplementationWorker", { enabled: false }), card("general-purpose")),
      "ImplementationWorker",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("ImplementationWorker");
  });

  it("fails closed when case-insensitive resolution is ambiguous", () => {
    const result = resolveSpawnTypeIn(
      registry(card("ImplementationWorker"), card("implementationworker"), card("general-purpose")),
      "IMPLEMENTATIONWORKER",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("IMPLEMENTATIONWORKER");
  });

  it("supports an explicitly configured fallback agent", () => {
    setFallbackSubagent("ImplementationWorker");
    const result = resolveSpawnTypeIn(
      registry(card("ImplementationWorker"), card("general-purpose")),
      "missing-agent",
    );

    expect(result).toEqual({ ok: true, type: "ImplementationWorker", fellBackFrom: "missing-agent" });
  });

  it("does not fall back when the configured fallback is disabled", () => {
    setFallbackSubagent("ImplementationWorker");
    const result = resolveSpawnTypeIn(
      registry(card("ImplementationWorker", { enabled: false }), card("general-purpose")),
      "missing-agent",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("configured fallbackSubagent");
  });
});

describe("real custom-card loading and resolution", () => {
  const projectDir = () => join(tempRoot, "project");

  it("loads and resolves the real ImplementationWorker card fixture", async () => {
    const cwd = projectDir();
    const agentsDir = join(cwd, ".pi", "agents");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "ImplementationWorker.md"), await readFile(fixturePath));

    const cards = loadCustomAgents(cwd);
    const loaded = cards.get("ImplementationWorker");
    const resolved = resolveSpawnTypeIn(buildAgentRegistry(cards), "implementationworker");

    expect(loaded?.displayName).toBe("Implementation Worker");
    expect(loaded?.model).toBe("test/provider-model");
    expect(loaded?.systemPrompt).toContain("Implement the requested change");
    expect(loaded?.sourcePath).toBe(join(agentsDir, "ImplementationWorker.md"));
    expect(resolved).toEqual({ ok: true, type: "ImplementationWorker" });
  });

  it("ignores the global shared agents directory but keeps project-local workspace agents", async () => {
    const previousHome = process.env.HOME;
    process.env.HOME = tempRoot;
    try {
      const globalSharedDir = join(tempRoot, ".agents", "agents");
      await mkdir(globalSharedDir, { recursive: true });
      await writeFile(
        join(globalSharedDir, "GlobalShared.md"),
        "---\nname: global-shared\ndescription: shared global card\n---\n\nGlobal shared prompt\n",
      );

      expect(loadCustomAgents(tempRoot).has("global-shared")).toBe(false);

      const cwd = projectDir();
      const projectSharedDir = join(cwd, ".agents", "agents");
      await mkdir(projectSharedDir, { recursive: true });
      await writeFile(
        join(projectSharedDir, "ProjectShared.md"),
        "---\nname: project-shared\ndescription: project card\n---\n\nProject prompt\n",
      );

      expect(loadCustomAgents(cwd).get("project-shared")?.sourcePath).toBe(
        join(projectSharedDir, "ProjectShared.md"),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });

  it("fails closed when the ImplementationWorker card is missing", async () => {
    const cards = loadCustomAgents(projectDir());
    const resolved = resolveSpawnTypeIn(buildAgentRegistry(cards), "ImplementationWorker");

    expect(cards.has("ImplementationWorker")).toBe(false);
    expect(resolved.ok).toBe(false);
  });

  it("loads an explicit fallback name from settings", async () => {
    const cwd = projectDir();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ fallbackSubagent: "ImplementationWorker" }),
    );

    const settings = loadSettings(cwd);
    setFallbackSubagent(settings.fallbackSubagent);
    const resolved = resolveSpawnTypeIn(
      registry(card("ImplementationWorker"), card("general-purpose")),
      "missing-agent",
    );

    expect(settings.fallbackSubagent).toBe("ImplementationWorker");
    expect(resolved).toEqual({ ok: true, type: "ImplementationWorker", fellBackFrom: "missing-agent" });
  });

  it("maps the boolean strict spelling without changing the default", async () => {
    const cwd = projectDir();
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "subagents.json"), JSON.stringify({ fallbackSubagent: false }));

    const settings = loadSettings(cwd);
    setFallbackSubagent(settings.fallbackSubagent);
    const resolved = resolveSpawnTypeIn(registry(card("general-purpose")), "missing-agent");

    expect(settings.fallbackSubagent).toBe(NO_FALLBACK);
    expect(resolved.ok).toBe(false);
  });
});
