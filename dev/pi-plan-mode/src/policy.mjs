const SAFE_DELEGATION_TYPES = Object.freeze(new Map([
  ["explore", "Explore"],
  ["plan", "Plan"],
]));

// This is deliberately explicit. New tools are unavailable in PLAN until their
// behavior has been reviewed and added here. checkpoint_notes is safe here
// because pi-notes owns a fixed agent-private path and accepts no caller path.
export const PLAN_TOOLS = Object.freeze([
  "read", "grep", "find", "ls", "bash",
  "ask_user_question", "questionnaire", "checkpoint_notes", "manage_plan_draft", "submit_plan_for_approval",
  "ctx_execute", "ctx_execute_file", "ctx_batch_execute",
  "ctx_search", "ctx_fetch_and_index", "ctx_index", "ctx_stats", "ctx_doctor",
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
  if (!input || typeof input !== "object") {
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

  return {
    allowed: true,
    profile: "plan-readonly",
    subagentType: canonical,
    inheritPlan: true,
  };
}

function shellTokens(command) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
  }

  if (escaped || quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

const SAFE_COMMANDS = new Set([
  "cat", "head", "tail", "grep", "rg", "find", "ls", "pwd", "stat", "file",
  "wc", "sort", "uniq", "diff", "git", "npm", "yarn", "pnpm", "echo", "printf",
]);

const FORBIDDEN_ARGUMENTS = new Set([
  "-exec", "-execdir", "-delete", "-ok", "-okdir", "--output", "--output-document",
]);

function isSafeCommandShape(command) {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (/[;&|<>`\n\r]|\$\(|\$\{/.test(command)) return false;

  const tokens = shellTokens(command);
  if (!tokens || tokens.length === 0) return false;
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
  if (tokens[index] === "env" || tokens[index] === "command" || tokens[index] === "builtin") return false;
  const executableToken = tokens[index] ?? "";
  if (executableToken.includes("/") || executableToken.includes("\\")) return false;
  const executable = executableToken;
  if (!SAFE_COMMANDS.has(executable)) return false;

  const args = tokens.slice(index + 1);
  if (args.some((arg) => FORBIDDEN_ARGUMENTS.has(arg))) return false;
  if (executable === "sort" && args.some((arg) => arg === "-o" || arg.startsWith("--output=") || /^-o.+/.test(arg))) return false;
  if (executable === "find" && args.some((arg) => ["-fprint", "-fprint0", "-fprintf"].includes(arg))) return false;

  if (executable === "git") {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (!new Set(["status", "log", "diff", "show", "branch", "remote", "ls-files", "ls-tree", "rev-parse", "describe", "tag", "config"]).has(subcommand)) return false;
    if (args.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
    if (args.some((arg) => ["add", "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "checkout", "restore", "clean", "stash", "init", "clone", "cherry-pick", "revert", "worktree", "-a", "-A", "-d", "-D", "--delete", "--move", "-m", "--set-upstream", "--set", "--unset", "--unset-all"].includes(arg))) return false;
    if (subcommand === "config" && !args.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin"].includes(arg))) return false;
    if (subcommand === "remote" && args.some((arg) => ["add", "remove", "rename", "set-url", "set-head", "prune", "update"].includes(arg))) return false;
  }

  if (["npm", "yarn", "pnpm"].includes(executable)) {
    const subcommand = args.find((arg) => !arg.startsWith("-"));
    if (!new Set(["list", "ls", "view", "info", "search", "outdated", "audit", "why"]).has(subcommand)) return false;
  }

  return true;
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
  return mode ?? "PLAN";
}
