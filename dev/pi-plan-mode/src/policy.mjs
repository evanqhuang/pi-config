const SAFE_DELEGATION_TYPES = Object.freeze(new Map([
  ["explore", "Explore"],
  ["plan", "Plan"],
]));

export const PLAN_DELEGATION_LIMITS = Object.freeze({
  Explore: 24,
  Plan: 16,
});

export const CHILD_PLAN_BLOCKED_TOOLS = Object.freeze([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "manage_plan_draft",
  "submit_plan_for_approval",
  "checkpoint_notes",
]);

// This is deliberately explicit. New tools are unavailable in PLAN until their
// behavior has been reviewed and added here.
export const PLAN_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "bash",
  "ask_user_question", "questionnaire", "manage_plan_draft", "submit_plan_for_approval",
  "ctx_execute", "ctx_execute_file", "ctx_batch_execute",
  "ctx_search", "ctx_fetch_and_index", "ctx_index", "ctx_stats", "ctx_doctor",
  "checkpoint_notes",
  "web_search", "fetch_content", "get_search_content", "web_fetch",
  "Agent", "get_subagent_result", "steer_subagent",
]);

export function planToolNames() {
  return [...PLAN_TOOLS];
}

// ORCHESTRATOR and YOLO intentionally use the runtime's complete tool snapshot.
export const ORCHESTRATOR_TOOLS = Object.freeze(["__all__"]);
export const YOLO_TOOLS = Object.freeze(["__all__"]);

export function modeNames() {
  return ["PLAN", "ORCHESTRATOR", "YOLO"];
}

export function isPlanToolAllowed(name) {
  return typeof name === "string" && PLAN_TOOLS.includes(name);
}

export function isAllowedTool(mode, name) {
  if (mode === "ORCHESTRATOR" || mode === "YOLO") return true;
  return mode === "PLAN" && isPlanToolAllowed(name);
}

export function filterTools(mode, available) {
  const names = Array.isArray(available) ? available : [];
  if (mode === "ORCHESTRATOR" || mode === "YOLO") return [...names];
  return names.filter((name) => isPlanToolAllowed(name));
}

export function applyMode(state, mode, allTools) {
  if (!modeNames().includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  state.active = filterTools(mode, allTools);
  state.persisted = mode;
  return state.active;
}

export function isDelegationTool(name) {
  return name === "Agent";
}

export function delegationProfile(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { allowed: false, reason: "invalid delegation input" };
  }

  const requested = String(input.subagent_type ?? "").trim();
  const canonical = SAFE_DELEGATION_TYPES.get(requested.toLowerCase());
  if (!canonical) {
    return {
      allowed: false,
      reason: "PLAN delegation is limited to the approved read-only Explore or Plan agents",
    };
  }

  if (input.resume !== undefined) {
    return {
      allowed: false,
      reason: "PLAN workers are one-shot and cannot be resumed; launch a fresh, narrower worker instead",
    };
  }
  if (input.schedule !== undefined) {
    return {
      allowed: false,
      reason: "PLAN workers are bounded advisory runs and cannot be scheduled",
    };
  }

  const ceiling = PLAN_DELEGATION_LIMITS[canonical];
  const suppliedMaxTurns = input.max_turns;
  if (suppliedMaxTurns !== undefined
    && (!Number.isFinite(suppliedMaxTurns) || !Number.isInteger(suppliedMaxTurns) || suppliedMaxTurns <= 0)) {
    return {
      allowed: false,
      reason: "PLAN max_turns must be a finite positive integer",
    };
  }

  return {
    allowed: true,
    profile: "plan-readonly",
    subagentType: canonical,
    inheritPlan: true,
    maxTurns: Math.min(suppliedMaxTurns ?? ceiling, ceiling),
  };
}

function shellSegments(command) {
  const segments = [];
  let tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = "";
  let escaped = false;

  const finishToken = () => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  const finishSegment = () => {
    finishToken();
    if (tokens.length === 0) return false;
    segments.push(tokens);
    tokens = [];
    return true;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (escaped) {
      token += char;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = "";
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = "";
      } else if (char === "\\" && ["$", "`", '"', "\\", "\n"].includes(command[index + 1])) {
        escaped = true;
      } else {
        // Double quotes still expand variables and commands, so reject those
        // forms rather than trying to emulate a shell.
        if (char === "$" || char === "`") return null;
        token += char;
      }
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (char === "\n" || char === "\r" || char === "#" || char === "`" || char === "$" || char === "<" || char === ">" || char === "(" || char === ")" || char === "{" || char === "}" || char === "*" || char === "?" || char === "[") return null;
    // POSIX shells split unquoted words on space and tab by default. Other
    // JavaScript whitespace (for example NBSP or form feed) remains part of
    // the executable token and must not masquerade as a safe command boundary.
    if (char === " " || char === "\t") {
      finishToken();
      continue;
    }
    if (char === ";") {
      if (!finishSegment()) return null;
      continue;
    }
    if (char === "&") {
      if (command[index + 1] !== "&" || !finishSegment()) return null;
      index++;
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "&") return null;
      const operatorLength = command[index + 1] === "|" ? 2 : 1;
      if (!finishSegment()) return null;
      index += operatorLength - 1;
      continue;
    }
    if (char === "~" && !tokenStarted) return null;
    token += char;
    tokenStarted = true;
  }

  if (escaped || quote || !finishSegment()) return null;
  return segments;
}

const SAFE_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "find", "ls", "pwd", "stat", "file",
  "wc", "sort", "uniq", "diff", "git", "gh", "npm", "yarn", "pnpm", "echo", "printf",
]);

const FORBIDDEN_ARGUMENTS = new Set([
  "-exec", "-execdir", "-delete", "-ok", "-okdir", "--output", "--output-document",
]);
const READ_ONLY_GIT_COMMANDS = new Set([
  "status", "log", "diff", "show", "ls-files", "ls-tree", "rev-parse", "describe",
]);

function hasOption(args, option) {
  return args.some((arg) => arg === option || arg.startsWith(`${option}=`));
}

function isReadOnlyGit(args) {
  const subcommandIndex = args.findIndex((arg) => !arg.startsWith("-"));
  if (subcommandIndex < 0) return false;
  const subcommand = args[subcommandIndex];
  const subcommandArgs = args.slice(subcommandIndex + 1);
  if (args.slice(0, subcommandIndex).some((arg) => !["--no-pager", "--no-replace-objects", "--literal-pathspecs"].includes(arg))) return false;
  if (args.some((arg) => arg === "--output" || arg.startsWith("--output=") || ["--ext-diff", "--textconv", "--show-signature"].includes(arg))) return false;

  if (READ_ONLY_GIT_COMMANDS.has(subcommand)) return true;
  if (subcommand === "worktree") {
    if (subcommandArgs[0] !== "list") return false;
    return subcommandArgs.slice(1).every((arg) => ["--porcelain", "-z", "--verbose"].includes(arg));
  }
  if (subcommand === "branch") {
    const mutating = new Set(["-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy", "--edit-description", "--set-upstream-to", "--unset-upstream"]);
    if (subcommandArgs.some((arg) => mutating.has(arg))) return false;
    const valueOptions = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--format", "--sort", "--color", "--column", "--abbrev"]);
    let listMode = false;
    for (let index = 0; index < subcommandArgs.length; index++) {
      const arg = subcommandArgs[index];
      if (arg === "--list" || arg === "-l") {
        listMode = true;
      } else if (["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--no-color", "--no-column", "--show-current", "--ignore-case"].includes(arg) || arg.startsWith("--format=") || arg.startsWith("--sort=") || arg.startsWith("--color=") || arg.startsWith("--column=") || arg.startsWith("--abbrev=")) {
        continue;
      } else if (valueOptions.has(arg)) {
        if (!subcommandArgs[++index]) return false;
      } else if (!arg.startsWith("-") && listMode) {
        continue;
      } else {
        return false;
      }
    }
    return true;
  }
  if (subcommand === "remote") {
    if (subcommandArgs.length === 0 || subcommandArgs.every((arg) => arg === "-v" || arg === "--verbose")) return true;
    const action = subcommandArgs[0];
    return (action === "show" && subcommandArgs.slice(1).every((arg) => !arg.startsWith("-") || arg === "-n"))
      || (action === "get-url" && subcommandArgs.slice(1).every((arg) => !arg.startsWith("-") || ["--all", "--push"].includes(arg)));
  }
  if (subcommand === "tag") {
    if (subcommandArgs.length === 0) return true;
    const listMode = subcommandArgs.some((arg) => arg === "-l" || arg === "--list" || arg.startsWith("--list="));
    return listMode && !subcommandArgs.some((arg) => ["-d", "--delete", "-f", "--force", "-a", "--annotate", "-s", "--sign"].includes(arg));
  }
  if (subcommand === "config") {
    const queryOptions = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope"];
    return queryOptions.some((option) => hasOption(subcommandArgs, option))
      && !subcommandArgs.some((arg) => ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "--edit", "-e"].includes(arg));
  }
  return false;
}

function consumeGhOptions(args, valueOptions, flagOptions) {
  let positionalCount = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--web") return false;
    if (flagOptions.has(arg)) continue;
    const equalsOption = [...valueOptions].find((option) => arg.startsWith(`${option}=`));
    if (equalsOption) {
      if (arg.length === equalsOption.length + 1) return false;
      continue;
    }
    if (valueOptions.has(arg)) {
      if (!args[++index] || args[index].startsWith("-")) return false;
      continue;
    }
    if (arg.startsWith("-") || ++positionalCount > 1) return false;
  }
  return true;
}

function isReadOnlyGh(args) {
  if (args[0] !== "pr" || !["view", "checks", "diff"].includes(args[1])) return false;
  const subcommand = args[1];
  const rest = args.slice(2);
  if (subcommand === "view") return consumeGhOptions(rest, new Set(["--json", "--jq", "--template", "--repo", "-R"]), new Set(["--comments"]));
  if (subcommand === "checks") return consumeGhOptions(rest, new Set(["--interval", "--json", "--jq", "--template", "--repo", "-R"]), new Set(["--fail-fast", "--required", "--watch"]));
  return consumeGhOptions(rest, new Set(["--color", "--repo", "-R"]), new Set(["--name-only", "--patch"]));
}

function isSafeSegment(tokens) {
  if (tokens.length === 0 || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) return false;
  const executableToken = tokens[0];
  if (["env", "command", "builtin"].includes(executableToken)) return false;
  // Do not trust a safe basename reached through an attacker-controlled path.
  if (executableToken.includes("/") || executableToken.includes("\\")) return false;
  if (!SAFE_COMMANDS.has(executableToken)) return false;

  const args = tokens.slice(1);
  if (args.some((arg) => FORBIDDEN_ARGUMENTS.has(arg))) return false;
  if (executableToken === "sort" && args.some((arg) => arg === "-o" || arg.startsWith("--output=") || /^-o.+/.test(arg) || arg === "--compress-program" || arg.startsWith("--compress-program="))) return false;
  if (executableToken === "find" && args.some((arg) => ["-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg))) return false;
  if (executableToken === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob=") || arg === "--hostname-bin" || arg.startsWith("--hostname-bin="))) return false;
  if (executableToken === "git" && !isReadOnlyGit(args)) return false;
  if (executableToken === "gh" && !isReadOnlyGh(args)) return false;

  if (["npm", "yarn", "pnpm"].includes(executableToken)) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (!new Set(["list", "ls", "view", "info", "search", "outdated", "audit", "why"]).has(subcommand)) return false;
  }

  return true;
}

function isSafeCommandShape(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  const segments = shellSegments(command);
  return segments !== null && segments.every(isSafeSegment);
}

export function isReadOnlyCommand(command) {
  return isSafeCommandShape(command);
}

export function isReadOnlyBatch(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.commands) || input.commands.length === 0) return false;
  return input.commands.every((item) => item && typeof item === "object" && isReadOnlyCommand(item.command));
}

export function restoreMode(entries) {
  const mode = (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry?.mode ?? "").toUpperCase())
    .findLast((value) => value === "PLAN" || value === "ORCHESTRATOR" || value === "YOLO");
  // YOLO is the default for fresh, malformed, and no-session contexts.
  return mode ?? "YOLO";
}
