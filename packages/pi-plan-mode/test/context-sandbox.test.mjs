import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { MCPStdioClient } from "/Users/evanhuang/.pi/agent/npm/node_modules/context-mode/build/adapters/pi/mcp-bridge.js";
import { installContextBridgeSandboxPatch } from "../src/context-sandbox.mjs";

test("context-mode MCP execution is inside the native write boundary", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    t.skip("native sandbox is only supported on macOS/Linux");
    return;
  }

  const root = mkdtempSync(join("/tmp", "pi-plan-context-test-"));
  const contextState = join(root, "context-mode");
  const contextTemp = join(contextState, "plan-tmp");
  const denied = join(root, "outside-context-state");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const patch = await installContextBridgeSandboxPatch();
  assert.equal(patch.available, true);
  t.after(() => patch.cleanup());
  const wrapper = await patch.setWrapper({ contextState, contextTemp });
  const server = join(homedir(), ".pi", "agent", "npm", "node_modules", "context-mode", "server.bundle.mjs");
  const child = spawn(wrapper, [server], {
    cwd: root,
    env: { ...process.env, CONTEXT_MODE_DATA_DIR: root },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => output.push(chunk.toString("utf8")));
  child.stdin.end([
    JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, clientInfo: { name: "test", version: "1" } },
    }),
    JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: {
        name: "ctx_execute",
        arguments: {
          language: "javascript",
          code: `require("fs").writeFileSync(${JSON.stringify(denied)}, "x"); console.log("unexpected")`,
        },
      },
    }),
  ].join("\n") + "\n");

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const text = output.join("");
  assert.equal(exitCode, 0);
  assert.match(text, /EPERM|operation not permitted/);
  assert.equal(existsSync(denied), false);
});

test("bridge clients keep their lifecycle across concurrent plan sessions", async (t) => {
  const root = mkdtempSync(join("/tmp", "pi-plan-context-lifecycle-test-"));
  const server = join(root, "server.mjs");
  writeFileSync(server, `
import readline from "node:readline";
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");
  }
});
`);

  const firstSession = await installContextBridgeSandboxPatch();
  const secondSession = await installContextBridgeSandboxPatch();
  assert.equal(firstSession.available, true);
  assert.equal(secondSession.available, true);
  firstSession.clearWrapper();

  let client;
  t.after(() => {
    client?.shutdown();
    secondSession.cleanup();
    firstSession.cleanup();
    rmSync(root, { recursive: true, force: true });
  });
  client = new MCPStdioClient(server, process.env, process.execPath);
  client.start();
  await client.initialize();
  const pending = client.callTool("ctx_execute", {});

  // A second session changing PLAN wrapper state must not tear down the first
  // session's client while its tool request is in flight.
  await secondSession.setWrapper({ contextState: root, contextTemp: join(root, "plan-tmp") });
  assert.equal(client.exited, false);
  secondSession.cleanup();
  assert.equal(client.exited, false);

  // A client shutdown must reject immediately rather than waiting for a child
  // exit event that shutdown has already masked. This is also the path used by
  // context-mode's own session_shutdown handler.
  client.shutdown();
  await assert.rejects(
    Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error("request remained pending")), 500)),
    ]),
    /MCP server exited/,
  );
  firstSession.cleanup();
});
