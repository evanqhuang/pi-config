import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeCommandRunner } from "../src/commands.js";
import { recordReviewDispositions, runManagedReview } from "../src/lifecycle.js";
import type { AgentInvocation, AgentResult, ReviewAgentRunner } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture(): Promise<{ repo: string; plan: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-code-review-lifecycle-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  git(root, "init", "-b", "main", repo);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  await writeFile(join(repo, "src", "a.ts"), "export const value = 1;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "checkout", "-b", "feature");
  await writeFile(join(repo, "src", "a.ts"), "export const value = 2;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "implementation");
  const plan = join(root, "plan.md");
  await writeFile(plan, [
    "# Plan",
    "",
    "## Review contract",
    "",
    "### Guarantees",
    "- The exported value changes safely.",
    "",
    "### Non-goals",
    "- Unrelated refactors.",
    "",
    "### Risk areas",
    "- Runtime correctness.",
    "",
    "### Required checks",
    "- `npm test`",
    "",
  ].join("\n"));
  return { repo, plan };
}

function candidateIds(prompt: string): string[] {
  const serialized = prompt.split("\n").at(-1);
  if (!serialized) return [];
  const parsed = JSON.parse(serialized) as { candidates?: readonly { id?: unknown }[] };
  return parsed.candidates?.flatMap((candidate) => typeof candidate.id === "string" ? [candidate.id] : []) ?? [];
}

class FakeAgents implements ReviewAgentRunner {
  public candidates = true;
  public calls = 0;

  public run<T>(invocation: AgentInvocation, validate: (value: unknown) => T): Promise<AgentResult<T>> {
    this.calls += 1;
    let value: unknown;
    if (invocation.role === "summary") value = { summary: "Changes one exported value" };
    else if (invocation.role.startsWith("finder:")) value = this.candidates ? {
      candidates: [{
        id: "exported-value-regression",
        file: "src/a.ts",
        line: 1,
        summary: "Exports the wrong value",
        failureScenario: "Importing the module returns the wrong value",
        evidence: "The changed line sets the incorrect constant",
        category: "correctness",
        severity: "high",
      }],
    } : { candidates: [] };
    else value = {
      verifications: candidateIds(invocation.prompt).map((candidateId) => ({
        candidateId,
        confidence: 95,
        verification: "The changed line deterministically returns the wrong value",
        confirmed: true,
        disposition: "CONFIRMED",
      })),
    };
    return Promise.resolve({
      data: validate(value),
      usage: { role: invocation.role, turns: 1, inputTokens: 1, outputTokens: 1, contextTokens: 2 },
    });
  }
}

describe("managed review lifecycle", () => {
  it("converges from initial blocker through one remediation delta", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    const dependencies = { commands, agents };

    const initial = await runManagedReview({
      cwd: repo,
      target: { kind: "current-diff" },
      requestedPhase: "auto",
      effort: "medium",
      planPath: plan,
    }, dependencies);

    expect(initial.decision).toBe("awaiting-adjudication");
    expect(initial.phase).toBe("initial");
    expect(initial.findings[0]?.id).toBe("REV-001");
    expect(initial.sessionId).toBeTruthy();
    expect(initial.reviewedSnapshotHash).toBeTruthy();

    const blocked = await recordReviewDispositions({
      cwd: repo,
      sessionId: initial.sessionId!,
      reviewedSnapshotHash: initial.reviewedSnapshotHash!,
      dispositions: [{
        id: "REV-001",
        disposition: "confirmed-blocker",
        parentEvidence: "Importing src/a.ts returns the wrong value in a focused reproduction.",
      }],
    }, dependencies);
    expect(blocked.decision).toBe("request-changes");

    await writeFile(join(repo, "src", "a.ts"), "export const value = 3;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fix review finding");
    agents.candidates = false;

    const delta = await runManagedReview({
      cwd: repo,
      target: { kind: "current-diff" },
      requestedPhase: "auto",
      effort: "medium",
      planPath: plan,
    }, dependencies);
    expect(delta.phase).toBe("delta");
    expect(delta.decision).toBe("awaiting-adjudication");

    const approved = await recordReviewDispositions({
      cwd: repo,
      sessionId: delta.sessionId!,
      reviewedSnapshotHash: delta.reviewedSnapshotHash!,
      dispositions: [{ id: "REV-001", disposition: "resolved", parentEvidence: "The remediation commit removes the reproduced behavior." }],
    }, dependencies);
    expect(approved.decision).toBe("approve");
    expect(approved.ledger?.completedPasses).toBe(2);
    expect(approved.ledger?.remediationBatches).toBe(1);
  });

  it("refuses to advance a managed lifecycle from a dirty worktree", async () => {
    const { repo, plan } = await fixture();
    await writeFile(join(repo, "src", "dirty.ts"), "export {};\n");
    const result = await runManagedReview({
      cwd: repo,
      target: { kind: "current-diff" },
      requestedPhase: "auto",
      effort: "medium",
      planPath: plan,
    }, { commands: new NodeCommandRunner(), agents: new FakeAgents() });
    expect(result.status).toBe("incomplete");
    expect(result.report).toContain("clean worktree");
  });

  it("blocks after the final confirmation instead of starting a fourth review", async () => {
    const { repo, plan } = await fixture();
    const commands = new NodeCommandRunner();
    const agents = new FakeAgents();
    const dependencies = { commands, agents };
    let result = await runManagedReview({
      cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "medium", planPath: plan,
    }, dependencies);
    result = await recordReviewDispositions({
      cwd: repo, sessionId: result.sessionId!, reviewedSnapshotHash: result.reviewedSnapshotHash!,
      dispositions: [{ id: "REV-001", disposition: "confirmed-blocker", parentEvidence: "Reproduced." }],
    }, dependencies);

    for (const [index, expectedPhase] of ["delta", "final"].entries()) {
      await writeFile(join(repo, "src", "a.ts"), `export const value = ${index + 3};\n`);
      git(repo, "add", ".");
      git(repo, "commit", "-m", `remediation ${index + 1}`);
      result = await runManagedReview({
        cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "medium", planPath: plan,
      }, dependencies);
      expect(result.phase).toBe(expectedPhase);
      result = await recordReviewDispositions({
        cwd: repo, sessionId: result.sessionId!, reviewedSnapshotHash: result.reviewedSnapshotHash!,
        dispositions: [{ id: "REV-001", disposition: "confirmed-blocker", parentEvidence: "Still reproduced." }],
      }, dependencies);
    }

    expect(result.decision).toBe("blocked");
    expect(result.ledger?.completedPasses).toBe(3);
    const calls = agents.calls;
    await expect(runManagedReview({
      cwd: repo, target: { kind: "current-diff" }, requestedPhase: "auto", effort: "medium", planPath: plan,
    }, dependencies)).rejects.toThrow(/blocked|fourth/i);
    expect(agents.calls).toBe(calls);
  });
});
