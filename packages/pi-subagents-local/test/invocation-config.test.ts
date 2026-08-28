import { describe, expect, it } from "vitest";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

const card = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  name: "test-agent",
  description: "test agent",
  extensions: true,
  skills: true,
  systemPrompt: "",
  promptMode: "replace",
  ...overrides,
});

describe("resolveAgentInvocationConfig model and thinking precedence", () => {
  it("uses card-only model and thinking defaults", () => {
    const resolved = resolveAgentInvocationConfig(
      card({ model: "card-model", thinking: "low" }),
      {},
    );

    expect(resolved.modelInput).toBe("card-model");
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.thinking).toBe("low");
    expect("overridden" in resolved).toBe(false);
  });

  it("uses caller-only model and thinking values", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      model: "caller-model",
      thinking: "high",
    });

    expect(resolved.modelInput).toBe("caller-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("high");
    expect("overridden" in resolved).toBe(false);
  });

  it("lets caller model and thinking override card defaults", () => {
    const resolved = resolveAgentInvocationConfig(
      card({ model: "card-model", thinking: "low", isolated: true, isolation: "worktree", promptMode: "append" }),
      {
        model: "caller-model",
        thinking: "high",
        isolated: false,
        inherit_context: true,
        isolation: "off",
      },
    );

    expect(resolved.modelInput).toBe("caller-model");
    expect(resolved.modelFromParams).toBe(true);
    expect(resolved.thinking).toBe("high");
    expect("overridden" in resolved).toBe(false);
    // Safety/strategy fields continue to use card-first precedence.
    expect(resolved.isolated).toBe(true);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.isolation).toBe("worktree");
  });

  it("leaves model and thinking undefined for parent inheritance", () => {
    const resolved = resolveAgentInvocationConfig(card(), {});

    expect(resolved.modelInput).toBeUndefined();
    expect(resolved.modelFromParams).toBe(false);
    expect(resolved.thinking).toBeUndefined();
    expect("overridden" in resolved).toBe(false);
  });
});
