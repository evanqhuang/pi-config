import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

const runningAgent = {
  id: "agent-1",
  parentAgentId: undefined,
  session: "/tmp/agent-1.jsonl",
  status: "running",
  startedAt: 1,
};

function createFleet(focusedComponent: unknown) {
  let inputHandler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  const tui = {
    getFocusedComponent: () => focusedComponent,
    requestRender: vi.fn(),
  };
  const ui: FleetUICtx = {
    setWidget: (_key, content) => {
      if (content) content(tui, {} as never);
    },
    onTerminalInput: handler => {
      inputHandler = handler;
      return () => { inputHandler = undefined; };
    },
    getEditorText: () => "",
    notify: vi.fn(),
    custom: vi.fn(),
  };
  const manager = { listAgents: () => [runningAgent] };
  const fleet = new FleetList(manager as never, new Map());
  fleet.setUICtx(ui);
  fleet.update();

  return {
    fleet,
    press: (data: string) => inputHandler?.(data),
  };
}

describe("FleetList editor focus detection", () => {
  const fleets: FleetList[] = [];

  afterEach(() => {
    for (const fleet of fleets.splice(0)) fleet.dispose();
  });

  it("navigates when a cross-module custom editor has structural editor methods", () => {
    const foreignEditor = {
      getText: () => "",
      setText: vi.fn(),
      handleInput: vi.fn(),
    };
    const harness = createFleet(foreignEditor);
    fleets.push(harness.fleet);

    expect(harness.press("\x1b[B")).toEqual({ consume: true });
    expect(harness.press("\x1b[B")).toEqual({ consume: true });
  });

  it("leaves arrow keys to focused selectors and dialogs", () => {
    const selector = {
      render: () => [],
      invalidate: vi.fn(),
      handleInput: vi.fn(),
    };
    const harness = createFleet(selector);
    fleets.push(harness.fleet);

    expect(harness.press("\x1b[B")).toBeUndefined();
  });
});
