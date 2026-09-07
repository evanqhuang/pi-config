import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadSettings,
  MAX_PROGRESS_CHECKPOINT_OVERRIDES,
  MAX_PROGRESS_CHECKPOINT_PROVIDER_MODEL_LENGTH,
  resolveProgressCheckpointSettings,
} from "../src/settings.js";

let tempRoot: string;
let previousAgentDir: string | undefined;

beforeEach(async () => {
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  tempRoot = await mkdtemp(join(tmpdir(), "pi-progress-settings-"));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "global-agent");
});

afterEach(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe("progress checkpoint settings", () => {
  it("sanitizes malformed values while retaining valid policy and opt-in warning", async () => {
    const cwd = join(tempRoot, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({
        progressCheckpoints: {
          enabled: true,
          displayTokenInterval: 0,
          elapsedIntervalMs: Number.NaN,
          repeatedFingerprintThreshold: -1,
          repeatedReportThreshold: 2,
          ignored: "dropped",
        },
        usageWarningUsd: 0.25,
      }),
    );

    const settings = loadSettings(cwd);
    expect(settings.progressCheckpoints).toEqual({
      enabled: true,
      repeatedReportThreshold: 2,
    });
    expect(settings.usageWarningUsd).toBe(0.25);
    expect(resolveProgressCheckpointSettings(settings, "acme", "model-a")).toEqual({
      enabled: true,
      repeatedReportThreshold: 2,
    });
  });

  it("drops zero, NaN, and negative values supplied directly to the resolver", () => {
    const settings = {
      progressCheckpoints: {
        displayTokenInterval: 0,
        elapsedIntervalMs: Number.NaN,
        repeatedFingerprintThreshold: -1,
        repeatedReportThreshold: 0,
      },
      usageWarningUsd: -0.01,
    } as unknown as Parameters<typeof resolveProgressCheckpointSettings>[0];

    expect(resolveProgressCheckpointSettings(settings, "acme", "model-a")).toBeUndefined();
  });

  it("selects exact overrides by model+provider, then single identity, then global", () => {
    const settings = {
      progressCheckpoints: {
        enabled: true,
        displayTokenInterval: 150_000,
        overrides: [
          { displayTokenInterval: 90_000 },
          { provider: "acme", elapsedIntervalMs: 5_000 },
          { model: "model-a", elapsedIntervalMs: 7_000 },
          { provider: "acme", model: "model-a", displayTokenInterval: 10_000 },
        ],
      },
    };

    expect(resolveProgressCheckpointSettings(settings, "acme", "model-a")).toEqual({
      enabled: true,
      displayTokenInterval: 10_000,
    });
    expect(resolveProgressCheckpointSettings(settings, "acme", "other-model")).toEqual({
      enabled: true,
      displayTokenInterval: 150_000,
      elapsedIntervalMs: 5_000,
    });
    expect(resolveProgressCheckpointSettings(settings, "other-provider", "model-a")).toEqual({
      enabled: true,
      displayTokenInterval: 150_000,
      elapsedIntervalMs: 7_000,
    });
    expect(resolveProgressCheckpointSettings(settings, "other-provider", "other-model")).toEqual({
      enabled: true,
      displayTokenInterval: 90_000,
    });
    // Selectors are exact identities, not patterns or prefixes.
    expect(resolveProgressCheckpointSettings(settings, "acme-extra", "model-a")).toEqual({
      enabled: true,
      displayTokenInterval: 150_000,
      elapsedIntervalMs: 7_000,
    });
  });

  it("bounds override count and provider/model selector strings", async () => {
    const cwd = join(tempRoot, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const longIdentity = "x".repeat(MAX_PROGRESS_CHECKPOINT_PROVIDER_MODEL_LENGTH + 50);
    const overrides = Array.from({ length: MAX_PROGRESS_CHECKPOINT_OVERRIDES + 10 }, (_, index) => ({
      provider: index === 0 ? longIdentity : `provider-${index}`,
      model: `model-${index}`,
      displayTokenInterval: index + 1,
    }));
    await writeFile(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ progressCheckpoints: { overrides }}),
    );

    const settings = loadSettings(cwd);
    expect(settings.progressCheckpoints?.overrides).toHaveLength(MAX_PROGRESS_CHECKPOINT_OVERRIDES);
    expect(settings.progressCheckpoints?.overrides?.[0]?.provider).toHaveLength(
      MAX_PROGRESS_CHECKPOINT_PROVIDER_MODEL_LENGTH,
    );
    expect(resolveProgressCheckpointSettings(settings, "provider-64", "model-64")).toEqual(undefined);
  });

  it("keeps global defaults and project settings merged at the top level", async () => {
    const cwd = join(tempRoot, "project");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(join(tempRoot, "global-agent"), { recursive: true });
    await writeFile(
      join(tempRoot, "global-agent", "subagents.json"),
      JSON.stringify({ maxConcurrent: 3, usageWarningUsd: 0.5 }),
    );
    await writeFile(
      join(cwd, ".pi", "subagents.json"),
      JSON.stringify({ maxConcurrent: 5, progressCheckpoints: { enabled: true }}),
    );

    expect(loadSettings(cwd)).toEqual({
      maxConcurrent: 5,
      usageWarningUsd: 0.5,
      progressCheckpoints: { enabled: true },
    });
  });
});
