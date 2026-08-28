import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { planSandboxConfig } from "./sandbox.mjs";

const PATCH_KEY = Symbol.for("pi-plan-mode.context-bridge-sandbox");
const BRIDGE_RELATIVE_PATH = ["build", "adapters", "pi", "mcp-bridge.js"];

function contextBridgeCandidates() {
  const here = dirname(fileURLToPath(import.meta.url));
  const configDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
  return [
    resolve(here, "../../../npm/node_modules/context-mode", ...BRIDGE_RELATIVE_PATH),
    resolve(configDir, "agent/npm/node_modules/context-mode", ...BRIDGE_RELATIVE_PATH),
    resolve(homedir(), ".pi/agent/npm/node_modules/context-mode", ...BRIDGE_RELATIVE_PATH),
  ];
}

async function importContextBridge() {
  for (const candidate of contextBridgeCandidates()) {
    try {
      return await import(pathToFileURL(candidate).href);
    } catch {
      // Try the next supported installation location.
    }
  }
  return undefined;
}

function wrapperSource(config, runtimeModule, tempRoot, runtimeTemp, dataRoot) {
  const configText = JSON.stringify(config);
  const moduleUrl = pathToFileURL(runtimeModule).href;
  const tempText = JSON.stringify(tempRoot);
  return `#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { SandboxManager } from ${JSON.stringify(moduleUrl)};

const serverScript = process.argv[2];
if (!serverScript) {
  console.error("pi-plan-mode: context bridge server path is missing");
  process.exit(64);
}
const tempRoot = ${tempText};
const runtimeTemp = ${JSON.stringify(runtimeTemp)};
const dataRoot = process.env.CONTEXT_MODE_DATA_DIR || ${JSON.stringify(dataRoot)};
mkdirSync(tempRoot, { recursive: true });
mkdirSync(runtimeTemp, { recursive: true });
const env = {
  ...process.env,
  TMPDIR: runtimeTemp,
  TMP: runtimeTemp,
  TEMP: runtimeTemp,
  CONTEXT_MODE_DATA_DIR: process.env.CONTEXT_MODE_DATA_DIR || dataRoot,
};
process.env.TMPDIR = runtimeTemp;
process.env.TMP = runtimeTemp;
process.env.TEMP = runtimeTemp;
process.env.CONTEXT_MODE_DATA_DIR = env.CONTEXT_MODE_DATA_DIR;
const quote = (value) => "'" + value.replaceAll("'", "'\\\\''") + "'";
const command = quote(process.execPath) + " " + quote(serverScript);
let child;
try {
  await SandboxManager.initialize(${configText});
  const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, {
    commandId: "pi-plan-mode-context-bridge",
    commandText: "context-mode MCP server",
  });
  child = spawn("bash", ["-c", wrapped], { cwd: process.cwd(), env, stdio: "inherit" });
  const forward = (signal) => { try { child.kill(signal); } catch {} };
  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGINT", () => forward("SIGINT"));
  const result = await new Promise((resolve) => {
    child.once("error", (error) => { console.error(error?.message || String(error)); resolve({ code: 1 }); });
    child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }));
  });
  await SandboxManager.reset();
  process.exit(result.code);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  try { await SandboxManager.reset(); } catch {}
  process.exit(1);
}
`;
}

async function createWrapper({ contextState, contextTemp } = {}) {
  const stateRoot = resolve(contextState || join(homedir(), ".pi", "context-mode"));
  const tempRoot = resolve(contextTemp || join(stateRoot, "plan-tmp"));
  mkdirSync(tempRoot, { recursive: true });
  const runtimeModule = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/@anthropic-ai/sandbox-runtime/dist/index.js");
  const wrapperPath = join(tempRoot, `bridge-wrapper-${process.pid}.mjs`);
  const dataRoot = process.env.CONTEXT_MODE_DATA_DIR ? resolve(process.env.CONTEXT_MODE_DATA_DIR) : dirname(stateRoot);
  writeFileSync(wrapperPath, wrapperSource(planSandboxConfig({ contextState: stateRoot, contextTemp: tempRoot, allowContextState: true, allowHostTemp: true }), runtimeModule, tempRoot, process.platform === "win32" ? join(tmpdir(), "claude") : "/tmp/claude", dataRoot), { mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  return wrapperPath;
}

export async function installContextBridgeSandboxPatch() {
  const bridge = await importContextBridge();
  const Client = bridge?.MCPStdioClient;
  if (!Client?.prototype?.start) return { available: false, setWrapper: () => {}, cleanup: () => {} };

  let state = globalThis[PATCH_KEY];
  if (!state) {
    const originalStart = Client.prototype.start;
    const originalShutdown = Client.prototype.shutdown;
    state = {
      originalStart,
      originalShutdown,
      wrapperPath: undefined,
      clients: new Set(),
      clientWrappers: new Map(),
      leases: new Set(),
    };
    state.patchedStart = function patchedStart(...args) {
      state.clients.add(this);
      // A client keeps the policy it had when it first started. Without this
      // per-client assignment, a PLAN subagent changing the process-global
      // wrapper could silently change the parent bridge on its next respawn.
      if (!state.clientWrappers.has(this)) {
        state.clientWrappers.set(this, state.wrapperPath);
      }
      const wrapperPath = state.clientWrappers.get(this);
      if (!wrapperPath) return state.originalStart.apply(this, args);
      const previous = this.runtimeOverride;
      this.runtimeOverride = wrapperPath;
      try { return state.originalStart.apply(this, args); }
      finally { this.runtimeOverride = previous; }
    };
    state.patchedShutdown = function patchedShutdown(...args) {
      // context-mode's shutdown() marks the client exited before the child's
      // exit event runs. Its onExit() therefore cannot reject in-flight calls,
      // leaving a ctx_execute promise pending forever when another session
      // tears down the shared bridge. Reject first, then perform the normal
      // shutdown so callers receive an error instead of hanging.
      try { this.onExit?.(); } catch {}
      return state.originalShutdown.apply(this, args);
    };
    Client.prototype.start = state.patchedStart;
    Client.prototype.shutdown = state.patchedShutdown;
    globalThis[PATCH_KEY] = state;
  }

  const lease = { wrapperPath: undefined };
  state.leases.add(lease);
  let released = false;
  const shutdownClient = (client) => {
    try { client.onExit?.(); } catch {}
    try { client.shutdown?.(); } catch {}
  };

  return {
    available: true,
    async setWrapper(options) {
      lease.wrapperPath = await createWrapper(options);
      state.wrapperPath = lease.wrapperPath;
      // Do not tear down existing clients here. PLAN subagents share this
      // process with their parent, and restarting every client invalidates a
      // sibling's in-flight ctx_execute. New clients use the wrapper, and
      // clients that already use it retain it across respawns; existing
      // clients retain their first-start policy.
      return lease.wrapperPath;
    },
    clearWrapper() {
      // This only affects clients that have not started yet. Existing clients
      // retain their policy so another session cannot un-sandbox a PLAN bridge
      // during a later respawn. Restore another active PLAN session's wrapper
      // when this session leaves PLAN mode.
      lease.wrapperPath = undefined;
      const activeLeases = [...state.leases];
      state.wrapperPath = activeLeases.reverse().find((item) => item.wrapperPath)?.wrapperPath;
    },
    cleanup() {
      if (released) return;
      released = true;
      state.leases.delete(lease);
      // The patch is process-global because Pi creates subagent sessions in
      // this process. Keep another PLAN session's wrapper active; only the
      // last session releases the shared clients.
      const activeLeases = [...state.leases];
      state.wrapperPath = activeLeases.reverse().find((item) => item.wrapperPath)?.wrapperPath;
      if (state.leases.size > 0) return;
      for (const client of state.clients) shutdownClient(client);
      state.clients.clear();
      state.clientWrappers.clear();
    },
  };
}
