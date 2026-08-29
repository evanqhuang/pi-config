import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type GoalJudgeThinking = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GoalJudgeSettings {
  model: string;
  thinking: GoalJudgeThinking;
}

const DEFAULT_JUDGE_SETTINGS: GoalJudgeSettings = {
  model: "openai-codex/gpt-5.6-luna",
  thinking: "medium",
};

const THINKING_LEVELS = new Set<GoalJudgeThinking>(["minimal", "low", "medium", "high", "xhigh"]);

function readSettings(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function judgeOverride(settings: Record<string, unknown> | undefined): Partial<GoalJudgeSettings> {
  const extension = settings?.["pi-goal-local"];
  if (!extension || typeof extension !== "object" || Array.isArray(extension)) return {};
  const judge = (extension as Record<string, unknown>).judge;
  if (!judge || typeof judge !== "object" || Array.isArray(judge)) return {};
  const raw = judge as Record<string, unknown>;
  const result: Partial<GoalJudgeSettings> = {};
  if (typeof raw.model === "string" && raw.model.includes("/")) result.model = raw.model.trim();
  if (typeof raw.thinking === "string" && THINKING_LEVELS.has(raw.thinking as GoalJudgeThinking)) {
    result.thinking = raw.thinking as GoalJudgeThinking;
  }
  return result;
}

export function loadGoalJudgeSettings(cwd: string): GoalJudgeSettings {
  const global = judgeOverride(readSettings(join(getAgentDir(), "settings.json")));
  const project = judgeOverride(readSettings(join(cwd, ".pi", "settings.json")));
  return { ...DEFAULT_JUDGE_SETTINGS, ...global, ...project };
}
