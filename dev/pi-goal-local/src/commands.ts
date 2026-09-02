import type { GoalLoopEntry } from "./types.js";

export type GoalCommand =
  | { kind: "start"; objective: string; criteria: string[]; loop?: boolean; planPath?: string; maxCycles?: number; entry?: GoalLoopEntry }
  | { kind: "fresh"; entry?: GoalLoopEntry }
  | { kind: "status" | "pause" | "resume" | "stop" | "clear" };

type GoalToken = {
  value: string;
  quoted: boolean;
};

function tokenizeGoalArguments(input: string): GoalToken[] {
  const tokens: GoalToken[] = [];
  let current = "";
  let quoted = false;
  let tokenStarted = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;

  const push = (): void => {
    if (!tokenStarted) return;
    tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
    tokenStarted = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index] as string;
    if (escaped) {
      current += character;
      escaped = false;
      quoted = true;
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = input[index + 1];
      if (next === "\\" || next === "'" || next === '"' || (next !== undefined && /\s/u.test(next))) {
        escaped = true;
        tokenStarted = true;
        continue;
      }
      current += "\\";
      tokenStarted = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
        quoted = true;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      tokenStarted = true;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    current += character;
    tokenStarted = true;
  }

  if (escaped) current += "\\";
  if (quote !== undefined) throw new Error("Unclosed quote in goal arguments.");
  push();
  return tokens;
}

function criteriaFromTokens(tokens: readonly GoalToken[]): string[] {
  const text = tokens.map(token => token.value).join(" ").trim();
  return text
    ? text.split(/\s*;\s*|\s*\n\s*/u).map(value => value.trim()).filter(Boolean)
    : [];
}

function isOption(token: GoalToken): boolean {
  return !token.quoted && token.value.startsWith("-");
}

function isGoalLoopEntryFlag(token: GoalToken): boolean {
  return !token.quoted && (token.value === "--verify" || token.value === "--implement");
}

function isGoalLoopEntryValue(token: GoalToken): boolean {
  return !token.quoted && (token.value.startsWith("--verify=") || token.value.startsWith("--implement="));
}

function hasLoopSyntax(tokens: readonly GoalToken[]): boolean {
  return tokens.some(token => !token.quoted && token.value.startsWith("--") && token.value !== "--");
}

function optionValue(tokens: readonly GoalToken[], index: number, name: string): { value: string; consumed: number } {
  const token = tokens[index]?.value ?? "";
  const prefix = `${name}=`;
  if (token.startsWith(prefix)) {
    const value = token.slice(prefix.length).trim();
    if (!value) throw new Error(`${name} requires a value.`);
    return { value, consumed: 0 };
  }
  const next = tokens[index + 1];
  if (!next || isOption(next)) throw new Error(`${name} requires a value.`);
  if (!next.value.trim()) throw new Error(`${name} requires a value.`);
  return { value: next.value, consumed: 1 };
}

function parseLoopCommand(tokens: readonly GoalToken[]): GoalCommand {
  const objective: GoalToken[] = [];
  const criteria: GoalToken[] = [];
  let inCriteria = false;
  let loop = false;
  let entry: GoalLoopEntry | undefined;
  let planPath: string | undefined;
  let maxCycles: number | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (!token.quoted && token.value === "--") {
      if (inCriteria) throw new Error("Goal criteria separator may be provided only once.");
      inCriteria = true;
      continue;
    }
    if (!token.quoted && (token.value === "--loop" || token.value === "--loop=true" || token.value === "--loop=false")) {
      if (token.value !== "--loop") throw new Error("--loop does not take a value.");
      if (loop) throw new Error("--loop may be provided only once.");
      loop = true;
      continue;
    }
    if (isGoalLoopEntryValue(token)) {
      throw new Error(`${token.value.startsWith("--verify=") ? "--verify" : "--implement"} does not take a value.`);
    }
    if (isGoalLoopEntryFlag(token)) {
      const requestedEntry = token.value === "--verify" ? "verify" : "implement" as const;
      if (entry !== undefined) {
        if (entry === requestedEntry) throw new Error(`${token.value} may be provided only once.`);
        throw new Error("--verify and --implement are mutually exclusive.");
      }
      entry = requestedEntry;
      continue;
    }
    if (!token.quoted && (token.value === "--plan" || token.value.startsWith("--plan="))) {
      if (planPath !== undefined) throw new Error("--plan may be provided only once.");
      const parsed = optionValue(tokens, index, "--plan");
      planPath = parsed.value.trim();
      index += parsed.consumed;
      continue;
    }
    if (!token.quoted && (token.value === "--max-cycles" || token.value.startsWith("--max-cycles="))) {
      if (maxCycles !== undefined) throw new Error("--max-cycles may be provided only once.");
      const parsed = optionValue(tokens, index, "--max-cycles");
      if (!/^[1-9]\d*$/u.test(parsed.value)) throw new Error("--max-cycles must be a positive integer.");
      const parsedNumber = Number(parsed.value);
      if (!Number.isSafeInteger(parsedNumber) || parsedNumber < 1) {
        throw new Error("--max-cycles must be a positive integer.");
      }
      maxCycles = parsedNumber;
      index += parsed.consumed;
      continue;
    }
    if (isOption(token)) throw new Error(`Unknown goal option: ${token.value}`);
    (inCriteria ? criteria : objective).push(token);
  }

  const objectiveText = objective.map(token => token.value).join(" ").trim();
  if (!objectiveText && !planPath) throw new Error("Goal objective cannot be empty without --plan.");
  const result: GoalCommand = {
    kind: "start",
    objective: objectiveText || (entry === "verify" ? "Verify the referenced plan." : "Implement the referenced plan."),
    criteria: criteriaFromTokens(criteria),
  };
  if (loop || entry !== undefined) result.loop = true;
  if (planPath !== undefined) result.planPath = planPath;
  if (maxCycles !== undefined) result.maxCycles = maxCycles;
  if (entry !== undefined) result.entry = entry;
  return result;
}

function parseFreshCommand(tokens: readonly GoalToken[]): GoalCommand | undefined {
  const first = tokens[0];
  if (!first || first.quoted || first.value !== "fresh" || tokens.length < 2) return undefined;

  let entry: GoalLoopEntry | undefined;
  for (const token of tokens.slice(1)) {
    if (isGoalLoopEntryValue(token)) {
      throw new Error(`${token.value.startsWith("--verify=") ? "--verify" : "--implement"} does not take a value.`);
    }
    if (!isGoalLoopEntryFlag(token)) return undefined;
    const requestedEntry = token.value === "--verify" ? "verify" : "implement" as const;
    if (entry !== undefined) {
      if (entry === requestedEntry) throw new Error(`${token.value} may be provided only once.`);
      throw new Error("--verify and --implement are mutually exclusive.");
    }
    entry = requestedEntry;
  }

  return entry === undefined ? { kind: "fresh" } : { kind: "fresh", entry };
}

function parseLegacyGoalCommand(value: string): GoalCommand {
  if (!value || value === "status") return { kind: "status" };
  if (value === "pause" || value === "resume" || value === "stop" || value === "clear" || value === "fresh") {
    return { kind: value };
  }

  const separator = value.indexOf(" -- ");
  if (separator < 0) return { kind: "start", objective: value, criteria: [] };
  const objective = value.slice(0, separator).trim();
  const criteriaText = value.slice(separator + 4).trim();
  if (!objective) throw new Error("Goal objective cannot be empty.");
  const criteria = criteriaText
    ? criteriaText.split(/\s*;\s*|\s*\n\s*/u).map(v => v.trim()).filter(Boolean)
    : [];
  return { kind: "start", objective, criteria };
}

export function parseGoalCommand(raw: string | undefined): GoalCommand {
  const value = (raw ?? "").trim();
  if (!value) return { kind: "status" };

  let tokens: GoalToken[];
  try {
    tokens = tokenizeGoalArguments(value);
  } catch (error) {
    // Legacy goals treated quote characters as ordinary objective text. Only
    // turn an unterminated quote into an error when loop syntax is present.
    if (/(^|\s)--(?:loop|plan|max-cycles|verify|implement)(?:=|\s|$)/u.test(value)) throw error;
    return parseLegacyGoalCommand(value);
  }
  const freshCommand = parseFreshCommand(tokens);
  if (freshCommand) return freshCommand;
  if (!hasLoopSyntax(tokens)) return parseLegacyGoalCommand(value);
  return parseLoopCommand(tokens);
}

export function formatGoalStatus(state: {
  status: string;
  objective: string;
  iteration: number;
  lastReason?: string;
} | undefined): string {
  if (!state) return "No native goal is set on this session branch.";
  return `${state.status.toUpperCase()}: ${state.objective} (iteration ${state.iteration})${state.lastReason ? ` — ${state.lastReason}` : ""}`;
}
