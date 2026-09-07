import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
}));

vi.mock("../src/agent-runner.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/agent-runner.js")>()),
  runAgent: mocks.runAgent,
}));

vi.mock("../src/settings.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/settings.js")>()),
  saveAndEmitChanged: (_snapshot: unknown, _message: string, _emit: (event: string, data: unknown) => void) => ({
    message: "settings applied",
    level: "info" as const,
  }),
}));

vi.mock("@earendil-works/pi-coding-agent", async importOriginal => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "> ",
    hint: (text: string) => text,
  }),
}));

import extension from "../src/index.js";

import { fakePi, context } from "./helpers/extension-harness.js";

let tempRoots: string[] = [];
afterEach(async () => {
  mocks.runAgent.mockReset();
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Ctrl+B foreground detachment", () => {
  it("returns a queued foreground call while background is full and does not resurrect completed activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-ctrl-b-detach-"));
    tempRoots.push(root);
    const finishers = new Map<string, (value: any) => void>();
    mocks.runAgent.mockImplementation((_ctx: unknown, _type: string, prompt: string, options: any) => {
      const session = {
        sessionManager: { getSessionFile: () => undefined },
        dispose: vi.fn(),
      };
      options.onSessionCreated?.(session);
      if (prompt === "detached") {
        // Settle synchronously when the background queue starts. This models a
        // very fast detached run racing the foreground waiter's handoff.
        return {
          then(onFulfilled: (value: any) => unknown) {
            return Promise.resolve(onFulfilled({
              responseText: "detached result",
              session,
              aborted: false,
              steered: false,
            }));
          },
        } as any;
      }
      return new Promise(resolve => { finishers.set(prompt, resolve); });
    });

    const { pi, tools, commands, shortcuts, widgets, handlers, ui, notifications, menuChoices, settingChoices, numericValues } = fakePi();
    extension(pi as any);
    const ctx = context(root, ui);
    // Use the real /agents settings path to configure both scheduler pools;
    // the manager itself remains private to the extension, as it is in pi.
    menuChoices.push("Settings", undefined);
    settingChoices.push("maxConcurrent", "maxConcurrentForeground", undefined);
    numericValues.push("1", "1");
    await commands.get("agents")!.handler(undefined, ctx);
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const agent = tools.get("Agent");
    expect(agent).toBeDefined();

    try {
      await agent.execute("background-call", {
        prompt: "background",
        description: "background capacity",
        subagent_type: "general-purpose",
        run_in_background: true,
      }, new AbortController().signal, undefined, ctx);
      const first = agent.execute("first-call", {
        prompt: "first",
        description: "first foreground",
        subagent_type: "general-purpose",
        run_in_background: false,
      }, new AbortController().signal, undefined, ctx);
      const detachedCall = agent.execute("detached-call", {
        prompt: "detached",
        description: "detached foreground",
        subagent_type: "general-purpose",
        run_in_background: false,
      }, new AbortController().signal, undefined, ctx);

      // Resolve the saturated background run before Ctrl+B's waiter resumes.
      // Its drain starts the migrated record, which completes before the
      // foreground branch gets a chance to process the detached result.
      finishers.get("background")!({
        responseText: "background result",
        session: undefined,
        aborted: false,
        steered: false,
      });
      // The shortcut handler is synchronous: observe the migrated record while
      // it is still queued, before the already-resolved background promise gets
      // a turn to drain that queue.
      shortcuts.get("ctrl+b")!.handler({ ui });
      const detachNotice = notifications.at(-1)!;
      const detachedId = detachNotice.match(/\(([^)]+)\)/)![1];
      const queued = manager.getRecord(detachedId);
      expect(queued).toMatchObject({ status: "queued", isBackground: true, detached: true });

      const detachedResult = await detachedCall;
      expect(detachedResult.content[0].text).toContain("Agent detached to background.");
      expect(queued).toMatchObject({ status: "completed", isBackground: true, detached: true });
      expect(mocks.runAgent).toHaveBeenCalledTimes(3);

      // The migrated run is visible as a background completion, but it must
      // not retain the foreground activity tracker after its fast completion.
      const widgetFactory = widgets.get("agents");
      expect(widgetFactory).toBeDefined();
      const rendered = widgetFactory(
        { terminal: { columns: 200 }, requestRender: () => {} },
        ui.theme,
      ).render().join("\n");
      const detachedLine = rendered.split("\n").find((line: string) => line.includes("detached foreground"));
      expect(detachedLine).toBeDefined();
      expect(detachedLine).not.toContain("↻1");

      finishers.get("first")!({ responseText: "first result", session: undefined, aborted: false, steered: false });
      await first;
    } finally {
      for (const finish of finishers.values()) {
        finish({ responseText: "done", session: undefined, aborted: false, steered: false });
      }
      await manager.waitForAll();
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }
  });
});
