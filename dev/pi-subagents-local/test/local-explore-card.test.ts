import { describe, expect, it } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";

const agents = loadCustomAgents(process.cwd());

describe("LocalExplore card", () => {
  it("keeps the local read-only model and a bounded turn ceiling", () => {
    const localExplore = agents.get("LocalExplore");

    expect(localExplore).toBeDefined();
    expect(localExplore?.model).toBe("qwopus-subagent/qwopus3.5-9b-coder-mtp");
    expect(localExplore?.thinking).toBe("medium");
    expect(localExplore?.maxTurns).toBe(64);
    expect(localExplore?.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(localExplore?.promptMode).toBe("replace");
  });
});
