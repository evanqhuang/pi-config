import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildManagedImplementationId,
  injectReviewResult,
  removeLegacyReviewSkills,
  validateFindingDispositionInputs,
} from "../extensions/code-review.js";
import type { ReviewResult } from "../src/types.js";

const result: ReviewResult = {
  effort: "medium",
  status: "complete",
  summary: "No issues found.",
  findings: [],
  failures: [],
  commented: false,
  report: "### Code review\n\nNo issues found.",
  usage: [],
};

describe("review extension helpers", () => {
  it("injects the complete rendered report as a model-visible custom message", () => {
    const sendMessage = vi.fn();
    injectReviewResult({ sendMessage }, result);
    expect(sendMessage).toHaveBeenCalledWith({
      customType: "code-review-result",
      content: result.report,
      display: true,
      details: result,
    });
  });

  it("binds an explicit managed review identity to checkout, branch, and plan path", () => {
    const first = buildManagedImplementationId("/repo", "feature", "/plans/feature.md");
    expect(buildManagedImplementationId("/repo", "feature", "/plans/feature.md")).toBe(first);
    expect(buildManagedImplementationId("/repo", "other", "/plans/feature.md")).not.toBe(first);
    expect(buildManagedImplementationId("/repo", "feature", "/plans/other.md")).not.toBe(first);
  });

  it("rejects unknown finding dispositions", () => {
    expect(() => validateFindingDispositionInputs([{
      id: "REV-001",
      disposition: "dismissed" as never,
    }])).toThrow("Unknown finding disposition");
  });

  it("removes only the three legacy local review skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-code-review-skills-"));
    for (const name of ["review-fix-loop", "review-loop", "review-pr", "keep-me"]) {
      await mkdir(join(root, "skills", name), { recursive: true });
      await writeFile(join(root, "skills", name, "SKILL.md"), name);
    }
    expect(await removeLegacyReviewSkills(root)).toEqual(["review-fix-loop", "review-loop", "review-pr"]);
    await expect(removeLegacyReviewSkills(root)).resolves.toEqual([]);
    await expect(import("node:fs/promises").then(({ access }) => access(join(root, "skills", "keep-me", "SKILL.md")))).resolves.toBeUndefined();
  });

});
