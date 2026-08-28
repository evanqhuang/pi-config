import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

const DEFAULT_CONTEXT_STATE = join(homedir(), ".pi", "context-mode");
const DEFAULT_CONTEXT_TMP = join(DEFAULT_CONTEXT_STATE, "plan-tmp");
const SANDBOX_RUNTIME_TMP = process.platform === "win32" ? join(tmpdir(), "claude") : "/tmp/claude";

// Writes are denied everywhere except context-mode's private state and temp
// roots. In particular, /tmp is not writable: otherwise arbitrary ctx_execute
// code could create a file there and use it as an indirect mutation channel.
export function planSandboxConfig({ contextState = DEFAULT_CONTEXT_STATE, contextTemp = DEFAULT_CONTEXT_TMP, allowContextState = false, allowHostTemp = false } = {}) {
  const allowWrite = [SANDBOX_RUNTIME_TMP];
  if (allowContextState) allowWrite.push(resolve(contextState), resolve(contextTemp));
  // context-mode compiles supplied code into a fresh directory under the host
  // temp root. Only its dedicated bridge gets this exception; ordinary PLAN
  // Bash remains unable to create arbitrary temporary files.
  if (allowHostTemp) allowWrite.push(resolve(tmpdir()));
  return {
    network: { allowedDomains: ["*"], deniedDomains: [] },
    filesystem: {
      denyRead: [join(homedir(), ".ssh"), join(homedir(), ".aws"), join(homedir(), ".gnupg")],
      allowWrite,
      denyWrite: [],
    },
  };
}

export const PLAN_SANDBOX_CONFIG = Object.freeze(planSandboxConfig());

export async function initializePlanSandbox(options = {}) {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new Error("PLAN requires a supported native sandbox platform");
  }
  try {
    await SandboxManager.initialize(planSandboxConfig({ ...options, allowContextState: false, allowHostTemp: false }));
    if (!SandboxManager.isSandboxingEnabled()) throw new Error("PLAN native sandbox failed closed");
  } catch (error) {
    try { await SandboxManager.reset(); } catch {}
    throw error;
  }
}

export async function resetPlanSandbox() {
  await SandboxManager.reset();
}

export async function runSandboxed(command, cwd, { signal, onData, timeout, commandId } = {}) {
  if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
  const wrapped = await SandboxManager.wrapWithSandbox(
    command,
    undefined,
    undefined,
    signal,
    { commandId, commandText: command },
  );
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", ["-c", wrapped], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = onData ?? (() => {});
    let settled = false;
    let timedOut = false;
    const kill = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch { try { child.kill("SIGKILL"); } catch {} }
      }
    };
    const timer = timeout && timeout > 0
      ? setTimeout(() => { timedOut = true; kill(); }, timeout * 1000)
      : undefined;
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", output);
    child.stderr?.on("data", output);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (timedOut) reject(new Error(`timeout:${timeout}`));
      else resolveResult({ exitCode: code });
    });
  });
}

// A small, testable command builder used by the context bridge wrapper. The
// command is executed by the native sandbox, never by eval or a shell parser
// supplied by the caller.
export function buildReadOnlyExecuteCommand(runtime, script) {
  if (typeof runtime !== "string" || runtime.length === 0) throw new TypeError("runtime is required");
  if (typeof script !== "string" || script.length === 0) throw new TypeError("script is required");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(runtime)} ${quote(script)}`;
}

export function contextSandboxPaths() {
  const configuredRoot = process.env.CONTEXT_MODE_DATA_DIR?.trim();
  const contextState = configuredRoot
    ? join(resolve(configuredRoot), "context-mode")
    : DEFAULT_CONTEXT_STATE;
  return {
    contextState,
    contextTemp: join(contextState, "plan-tmp"),
    hostTemp: tmpdir(),
    sandboxRuntimeTemp: SANDBOX_RUNTIME_TMP,
  };
}
