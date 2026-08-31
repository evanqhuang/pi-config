import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type GoalJudgeThinking = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface GoalJudgeSettings {
  model: string;
  thinking: GoalJudgeThinking;
}

export interface GoalLoopSettings {
  /** Maximum corrective cycles for one loop. CLI --max-cycles overrides this per loop. */
  maxCycles: number;
  /** Number of repeated repository/correction fingerprints before stopping. */
  repeatedFingerprintThreshold: number;
  /** Maximum original immutable plan size in bytes. */
  maxPlanBytes: number;
  /** Maximum corrective plan size in bytes. */
  maxCorrectionBytes: number;
  /** Maximum self-contained context bootstrap size in bytes. */
  maxBootstrapBytes: number;
}

export interface GoalLoopSettingBounds {
  maxCycles: { min: number; max: number };
  repeatedFingerprintThreshold: { min: number; max: number };
  maxPlanBytes: { min: number; max: number };
  maxCorrectionBytes: { min: number; max: number };
  maxBootstrapBytes: { min: number; max: number };
}

const DEFAULT_JUDGE_SETTINGS: GoalJudgeSettings = {
  model: "openai-codex/gpt-5.6-luna",
  thinking: "medium",
};

/** Hard safety bounds for persisted/artifact consumers of loop settings. */
export const GOAL_LOOP_SETTING_BOUNDS: Readonly<GoalLoopSettingBounds> = Object.freeze({
  maxCycles: { min: 1, max: 100 },
  repeatedFingerprintThreshold: { min: 1, max: 10 },
  maxPlanBytes: { min: 1024, max: 512 * 1024 },
  maxCorrectionBytes: { min: 512, max: 128 * 1024 },
  maxBootstrapBytes: { min: 1024, max: 256 * 1024 },
});

export const DEFAULT_GOAL_LOOP_SETTINGS: Readonly<GoalLoopSettings> = Object.freeze({
  maxCycles: 5,
  repeatedFingerprintThreshold: 2,
  maxPlanBytes: 128 * 1024,
  maxCorrectionBytes: 32 * 1024,
  maxBootstrapBytes: 64 * 1024,
});

const THINKING_LEVELS = new Set<GoalJudgeThinking>(["minimal", "low", "medium", "high", "xhigh"]);
const LOOP_SETTING_KEYS: readonly (keyof GoalLoopSettings)[] = [
  "maxCycles",
  "repeatedFingerprintThreshold",
  "maxPlanBytes",
  "maxCorrectionBytes",
  "maxBootstrapBytes",
];

function readSettings(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function extensionSettings(settings: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const extension = settings?.["pi-goal-local"];
  return extension && typeof extension === "object" && !Array.isArray(extension)
    ? extension as Record<string, unknown>
    : undefined;
}

function judgeOverride(settings: Record<string, unknown> | undefined): Partial<GoalJudgeSettings> {
  const judge = extensionSettings(settings)?.judge;
  if (!judge || typeof judge !== "object" || Array.isArray(judge)) return {};
  const raw = judge as Record<string, unknown>;
  const result: Partial<GoalJudgeSettings> = {};
  if (typeof raw.model === "string" && raw.model.includes("/")) result.model = raw.model.trim();
  if (typeof raw.thinking === "string" && THINKING_LEVELS.has(raw.thinking as GoalJudgeThinking)) {
    result.thinking = raw.thinking as GoalJudgeThinking;
  }
  return result;
}

function loopOverride(settings: Record<string, unknown> | undefined): Partial<GoalLoopSettings> {
  const loop = extensionSettings(settings)?.loop;
  if (!loop || typeof loop !== "object" || Array.isArray(loop)) return {};
  const raw = loop as Record<string, unknown>;
  const result: Partial<GoalLoopSettings> = {};
  for (const key of LOOP_SETTING_KEYS) {
    const value = raw[key];
    const bounds = GOAL_LOOP_SETTING_BOUNDS[key];
    if (typeof value === "number"
      && Number.isSafeInteger(value)
      && value >= bounds.min
      && value <= bounds.max) {
      result[key] = value;
    }
  }
  return result;
}

export function loadGoalJudgeSettings(cwd: string): GoalJudgeSettings {
  const global = judgeOverride(readSettings(join(getAgentDir(), "settings.json")));
  const project = judgeOverride(readSettings(join(cwd, ".pi", "settings.json")));
  return { ...DEFAULT_JUDGE_SETTINGS, ...global, ...project };
}

/** Load bounded global/project loop settings; invalid overrides are ignored. */
export function loadGoalLoopSettings(cwd: string): GoalLoopSettings {
  const global = loopOverride(readSettings(join(getAgentDir(), "settings.json")));
  const project = loopOverride(readSettings(join(cwd, ".pi", "settings.json")));
  return { ...DEFAULT_GOAL_LOOP_SETTINGS, ...global, ...project };
}
