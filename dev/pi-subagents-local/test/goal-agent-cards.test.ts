import { describe, expect, it } from "vitest";
import { loadCustomAgents } from "../src/custom-agents.js";

const agents = loadCustomAgents(process.cwd());

describe("native goal evaluator cards", () => {
  it("loads GoalJudge as a one-turn non-mutating local-mode evaluator", () => {
    const judge = agents.get("GoalJudge");
    expect(judge).toBeDefined();
    expect(judge?.builtinToolNames).toEqual([]);
    expect(judge?.extensions).toEqual(["local-mode"]);
    expect(judge?.skills).toBe(false);
    expect(judge?.disallowedTools).toEqual(["request_deeper_reasoning"]);
    expect(judge?.model).toBe("openai-codex/gpt-5.6-luna");
    expect(judge?.thinking).toBe("low");
    expect(judge?.maxTurns).toBe(1);
    expect(judge?.persistSession).toBe(false);
    expect(judge?.outputTranscript).toBe(false);
    expect(judge?.promptMode).toBe("replace");
  });

  it("loads GoalVerifier with read-only tools and disposable snapshot policy inputs", () => {
    const verifier = agents.get("GoalVerifier");
    expect(verifier).toBeDefined();
    expect(verifier?.builtinToolNames).toEqual(["read", "bash", "grep", "find", "ls"]);
    expect(verifier?.extensions).toEqual(["local-mode"]);
    expect(verifier?.skills).toBe(false);
    expect(verifier?.model).toBe("openai-codex/gpt-5.6-luna");
    expect(verifier?.thinking).toBe("high");
    expect(verifier?.maxTurns).toBe(6);
    expect(verifier?.persistSession).toBe(false);
    expect(verifier?.outputTranscript).toBe(false);
    expect(verifier?.isolation).toBe("worktree");
    expect(verifier?.worktreeDisposition).toBe("discard");
    expect(verifier?.snapshotSource).toBe(true);
  });
});
