import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_CONTEXT_STATE = join(homedir(), ".pi", "context-mode");
const SANDBOX_RUNTIME_TMP = process.platform === "win32" ? join(tmpdir(), "claude") : "/tmp/claude";

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
