import test from "node:test";
import assert from "node:assert/strict";
import { initializePlanSandbox, resetPlanSandbox, runSandboxed, buildReadOnlyExecuteCommand } from "../src/sandbox.mjs";

test("native PLAN sandbox permits reads and denies writes for child processes", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") { t.skip("native sandbox is only supported on macOS/Linux"); return; }
  await initializePlanSandbox();
  t.after(async () => { await resetPlanSandbox(); });
  const cwd = new URL("..", import.meta.url).pathname;
  let output = "";
  const read = await runSandboxed("node -e 'process.stdout.write(require(\"fs\").readFileSync(\"package.json\", \"utf8\"))'", cwd, { onData: (chunk) => { output += chunk; } });
  assert.equal(read.exitCode, 0);
  assert.match(output, /pi-plan-mode/);
  const javascript = await runSandboxed("node -e 'console.log(require(\"fs\").existsSync(\"package.json\"))'", cwd, { onData: (chunk) => { output += chunk; } });
  assert.equal(javascript.exitCode, 0);
  const python = await runSandboxed("python3 -c 'print(open(\"package.json\").readline().strip())'", cwd, { onData: (chunk) => { output += chunk; } });
  assert.equal(python.exitCode, 0);
  const child = await runSandboxed("node -e 'require(\"child_process\").execFileSync(\"node\", [\"-e\", \"console.log(123)\"])'", cwd, { onData: (chunk) => { output += chunk; } });
  assert.equal(child.exitCode, 0);
  assert.match(output, /true/);

  for (const command of [
    "touch /tmp/pi-plan-mode-shell-denied",
    "python3 -c 'open(\"/tmp/pi-plan-mode-python-denied\", \"w\").write(\"x\")'",
    "node -e 'require(\"fs\").writeFileSync(\"/tmp/pi-plan-mode-js-denied\", \"x\")'",
    "node -e 'require(\"child_process\").execFileSync(\"node\", [\"-e\", \"require(\\\"fs\\\").writeFileSync(\\\"/tmp/pi-plan-mode-child-denied\\\", \\\"x\\\")\"])'",
  ]) {
    const write = await runSandboxed(command, cwd, { onData: () => {} });
    assert.notEqual(write.exitCode, 0, command);
  }
});

test("buildReadOnlyExecuteCommand quotes runtime and script as one argv command", () => {
  assert.equal(buildReadOnlyExecuteCommand("/bin/node", "/tmp/a script.mjs"), "'/bin/node' '/tmp/a script.mjs'");
  assert.throws(() => buildReadOnlyExecuteCommand("", "script"), /runtime is required/);
});
