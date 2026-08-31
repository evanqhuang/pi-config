import { describe, expect, it } from "vitest";
import { widgetEligibleAgents } from "../src/ui/agent-widget.js";

const foreground = { id: "foreground", parentAgentId: undefined, isBackground: false };
const background = { id: "background", parentAgentId: undefined, isBackground: true };
const rpc = { id: "rpc", parentAgentId: undefined, isBackground: undefined };
const nested = { id: "nested", parentAgentId: "background", isBackground: true };
const agents = [foreground, background, rpc, nested];

describe("widgetEligibleAgents", () => {
  it.each(["all", "background"] as const)(
    "keeps foreground agents inline-only in %s mode",
    mode => {
      expect(widgetEligibleAgents(agents, mode).map(agent => agent.id)).toEqual([
        "background",
        "rpc",
      ]);
    },
  );

  it("hides every agent when the widget is off", () => {
    expect(widgetEligibleAgents(agents, "off")).toEqual([]);
  });
});
