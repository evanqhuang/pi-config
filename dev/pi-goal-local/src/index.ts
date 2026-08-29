import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseGoalCommand, formatGoalStatus } from "./commands.js";
import { GoalController } from "./controller.js";

export default function goalExtension(pi: ExtensionAPI): void {
  const controller = new GoalController(pi);
  let ctx: ExtensionContext | undefined;

  pi.on("session_start", (_event, nextCtx) => {
    ctx = nextCtx;
    controller.restore(nextCtx);
  });

  pi.on("session_before_switch", () => {
    controller.prepareForNavigation();
  });

  pi.on("session_before_fork", () => {
    controller.prepareForNavigation();
  });

  pi.on("session_before_tree", () => {
    controller.prepareForNavigation();
  });

  pi.on("session_tree", (_event, treeCtx) => {
    ctx = treeCtx;
    controller.restoreSelectedBranch(treeCtx);
  });

  pi.on("session_shutdown", () => {
    controller.shutdown();
    ctx = undefined;
  });

  pi.registerCommand("goal", {
    description: "Set or manage an autonomous branch-aware completion goal",
    handler: async (args, commandCtx) => {
      if (!ctx) {
        commandCtx.ui.notify("No active session is available for /goal.", "error");
        return;
      }
      const activeCtx = ctx;
      let command;
      try {
        command = parseGoalCommand(args);
      } catch (error) {
        commandCtx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      switch (command.kind) {
        case "status":
          controller.refresh(activeCtx);
          commandCtx.ui.notify(formatGoalStatus(controller.current), "info");
          return;
        case "start": {
          const next = controller.start(activeCtx, command.objective, command.criteria);
          commandCtx.ui.notify(`Goal active: ${next.objective}`, "info");
          return;
        }
        case "pause": {
          const next = controller.pause(activeCtx);
          commandCtx.ui.notify(next ? "Goal paused." : "There is no active goal to pause.", next ? "info" : "warning");
          return;
        }
        case "resume": {
          const next = controller.resume(activeCtx);
          commandCtx.ui.notify(next ? "Goal resumed." : "There is no paused goal to resume.", next ? "info" : "warning");
          return;
        }
        case "stop": {
          const next = controller.stop(activeCtx);
          commandCtx.ui.notify(next ? "Goal stopped." : "There is no goal to stop.", next ? "info" : "warning");
          return;
        }
        case "clear": {
          const next = controller.clear(activeCtx);
          commandCtx.ui.notify(next ? "Goal cleared." : "There is no goal to clear.", next ? "info" : "warning");
          return;
        }
      }
    },
  });

  pi.on("agent_settled", (_event, settledCtx) => {
    ctx = settledCtx;
    controller.requestEvaluation(settledCtx);
  });

  pi.events.on("subagents:completed", () => controller.scheduleSubagentWake());
  pi.events.on("subagents:failed", () => controller.scheduleSubagentWake());
}
