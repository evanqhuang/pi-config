import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settings = JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8"));
const runtimePackage = JSON.parse(
  readFileSync(new URL("../dev/pi-runtime-tasks/package.json", import.meta.url), "utf8"),
);

test("local runtime and goal packages replace the external goal package", () => {
  assert.deepEqual(settings.packages.slice(0, 2), [
    "dev/pi-runtime-tasks",
    "dev/pi-goal-local",
  ]);
  assert.equal(settings.packages.includes("npm:@pandi-coding-agent/goal"), false);
  assert.equal(settings.packages.includes("npm:@juicesharp/rpiv-todo"), true);
  assert.deepEqual(runtimePackage.pi.extensions, [
    "./src/index.ts",
    "./src/subagent-adapter/index.ts",
  ]);
});

test("GoalJudge is isolated and tool-less", () => {
  const card = readFileSync(new URL("../agents/GoalJudge.md", import.meta.url), "utf8");
  for (const line of [
    "tools: none",
    "extensions: false",
    "skills: false",
    "persist_session: false",
    "output_transcript: false",
  ]) {
    assert.equal(card.includes(line), true);
  }
});
