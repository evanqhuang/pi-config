import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
	extractPullRequestUrls,
	isForbiddenCheckoutCommand,
	isRemoteInspectionCommand,
	parsePullRequestUrl,
	parseWorktreePorcelain,
	rewriteRepositoryPath,
	rewriteShellCommand,
	selectMatchingWorktree,
	shellQuote,
} from "../extensions/pr-worktree-guard/core.ts";

test("extracts and deduplicates canonical GitHub pull request URLs", () => {
	assert.deepEqual(
		extractPullRequestUrls(
			"Check https://github.com/acme/widgets/pull/42 and https://github.com/acme/widgets/pull/42/files.",
		),
		["https://github.com/acme/widgets/pull/42"],
	);
	assert.equal(parsePullRequestUrl("https://github.com/acme/widgets/pull/42")?.number, 42);
	assert.equal(parsePullRequestUrl("https://example.com/acme/widgets/pull/42"), undefined);
});

test("parses porcelain worktree records", () => {
	const records = parseWorktreePorcelain(
		"worktree /repo\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /repo/.worktrees/pr-42\nHEAD bbbb\nbranch refs/heads/fix/build\n\nworktree /tmp/detached\nHEAD cccc\ndetached\n",
	);
	assert.equal(records.length, 3);
	assert.deepEqual(records[1], {
		path: "/repo/.worktrees/pr-42",
		head: "bbbb",
		branch: "refs/heads/fix/build",
		detached: false,
		bare: false,
		prunable: false,
	});
	assert.equal(records[2]?.detached, true);
});

test("prefers the PR branch and never chooses the primary checkout", () => {
	const records = parseWorktreePorcelain(
		"worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /repo/.worktrees/pr-42\nHEAD abc\nbranch refs/heads/fix/build\n",
	);
	const selected = selectMatchingWorktree(records, {
		primaryPath: "/repo",
		headBranch: "fix/build",
		headSha: "abc",
	});
	assert.equal(selected.kind, "match");
	if (selected.kind === "match") {
		assert.equal(selected.worktree.path, "/repo/.worktrees/pr-42");
		assert.equal(selected.reason, "branch");
	}
});

test("reports ambiguous SHA-only worktree matches", () => {
	const records = parseWorktreePorcelain(
		"worktree /repo\nHEAD aaa\nbranch refs/heads/main\n\nworktree /one\nHEAD abc\nbranch refs/heads/one\n\nworktree /two\nHEAD abc\nbranch refs/heads/two\n",
	);
	assert.equal(
		selectMatchingWorktree(records, {
			primaryPath: "/repo",
			headBranch: "missing",
			headSha: "abc",
		}).kind,
		"ambiguous",
	);
});

test("permits only narrow remote inspection commands", () => {
	assert.equal(isRemoteInspectionCommand("gh pr checks 42 --repo acme/widgets"), true);
	assert.equal(isRemoteInspectionCommand("gh run view 123 --log"), true);
	assert.equal(isRemoteInspectionCommand("gh api repos/acme/widgets/pulls/42"), true);
	assert.equal(isRemoteInspectionCommand("gh api -X POST repos/acme/widgets/issues"), false);
	assert.equal(isRemoteInspectionCommand("gh api --method=POST repos/acme/widgets/issues"), false);
	assert.equal(isRemoteInspectionCommand("gh api --field=title=x repos/acme/widgets/issues"), false);
	assert.equal(isRemoteInspectionCommand("gh pr view 42 && rm -rf ."), false);
	assert.equal(isRemoteInspectionCommand("pnpm build"), false);
});

test("blocks worktree and branch-changing bypass commands", () => {
	assert.equal(isForbiddenCheckoutCommand("git worktree add /tmp/new branch"), true);
	assert.equal(isForbiddenCheckoutCommand("git worktree lock /tmp/new"), true);
	assert.equal(isForbiddenCheckoutCommand("git -C ../../ worktree repair"), true);
	assert.equal(isForbiddenCheckoutCommand("git worktree list --porcelain"), false);
	assert.equal(isForbiddenCheckoutCommand("gh pr checkout 42"), true);
	assert.equal(isForbiddenCheckoutCommand("git switch fix/build"), true);
	assert.equal(isForbiddenCheckoutCommand("git -C ../../ switch fix/build"), true);
	assert.equal(isForbiddenCheckoutCommand("git --git-dir=/repo/.git checkout fix/build"), true);
	assert.equal(isForbiddenCheckoutCommand("git -C../../ switch fix/build"), true);
	assert.equal(isForbiddenCheckoutCommand("git -C ../../ status --short"), true);
	assert.equal(isForbiddenCheckoutCommand("git --work-tree=/repo status"), true);
	assert.equal(isForbiddenCheckoutCommand("cd ../other && git status"), true);
	assert.equal(isForbiddenCheckoutCommand("Set-Location ../other; git status"), true);
	assert.equal(
		isForbiddenCheckoutCommand(
			"pwd && git rev-parse --show-toplevel && git branch --show-current && git status --short && git worktree list --porcelain",
		),
		false,
	);
	assert.equal(
		isForbiddenCheckoutCommand(
			"cd /repo/.worktrees/pr-42 && pwd && git status --short",
			"/repo/.worktrees/pr-42",
		),
		false,
	);
	assert.equal(
		isForbiddenCheckoutCommand("cd /repo/.worktrees/other && git status", "/repo/.worktrees/pr-42"),
		true,
	);
	assert.equal(isForbiddenCheckoutCommand("pwd && git switch main"), true);
	assert.equal(isForbiddenCheckoutCommand("(cd /tmp && pwd)"), true);
	assert.equal(isForbiddenCheckoutCommand("if cd /tmp; then pwd; fi"), true);
	assert.equal(isForbiddenCheckoutCommand("sh -c 'git checkout main'"), true);
	assert.equal(isForbiddenCheckoutCommand("command cd /tmp"), true);
	assert.equal(isForbiddenCheckoutCommand("builtin cd /tmp"), true);
	assert.equal(isForbiddenCheckoutCommand("env sh -c 'git checkout main'"), true);
	assert.equal(isForbiddenCheckoutCommand("git chec\\kout main"), true);
	assert.equal(isForbiddenCheckoutCommand("git \\--work-tree=/tmp status"), true);
	assert.equal(isForbiddenCheckoutCommand("git status $GIT_ARGS"), true);
	assert.equal(isForbiddenCheckoutCommand("git status $env:GIT_ARGS"), true);
	assert.equal(isForbiddenCheckoutCommand("git status $@"), true);
	assert.equal(isForbiddenCheckoutCommand("git $'--work-tree=/tmp' status"), true);
	assert.equal(isForbiddenCheckoutCommand("ln -s /tmp link && cd link && pwd", "/repo/.worktrees/pr-42"), true);
	assert.equal(isForbiddenCheckoutCommand("gh --repo acme/repo pr checkout 42"), true);
	assert.equal(isForbiddenCheckoutCommand("gh -R acme/repo pr checkout 42"), true);
	assert.equal(isForbiddenCheckoutCommand("git checkout fix/build"), true);
	assert.equal(isForbiddenCheckoutCommand("git checkout -- src/a.ts"), true);
	assert.equal(isForbiddenCheckoutCommand("git status --short"), false);
});

test("routes repository paths into the locked worktree and rejects escapes", () => {
	const options = {
		sourceRoot: "/repo",
		targetRoot: "/repo/.worktrees/pr-42",
		linkedRoots: ["/repo", "/repo/.worktrees/other", "/repo/.worktrees/pr-42"],
		allowOutside: false,
	};
	assert.equal(rewriteRepositoryPath("src/a.ts", options), "/repo/.worktrees/pr-42/src/a.ts");
	assert.equal(rewriteRepositoryPath("/repo/src/a.ts", options), "/repo/.worktrees/pr-42/src/a.ts");
	assert.equal(
		rewriteRepositoryPath("/repo/.worktrees/pr-42/src/a.ts", options),
		"/repo/.worktrees/pr-42/src/a.ts",
	);
	assert.throws(() => rewriteRepositoryPath("../outside", options), /outside the locked worktree/);
	assert.throws(
		() => rewriteRepositoryPath("../../file", { ...options, workingDirectory: "/repo/.worktrees/pr-42/src" }),
		/escapes the locked worktree/,
	);
	assert.throws(
		() => rewriteRepositoryPath("/repo/.worktrees/other/src/a.ts", options),
		/another checkout/,
	);
});

test("rewrites safe shell directory targets into the locked worktree", () => {
	const options = {
		sourceRoot: "/repo",
		targetRoot: "/repo/.worktrees/pr-42",
		linkedRoots: ["/repo", "/repo/.worktrees/other", "/repo/.worktrees/pr-42"],
		allowOutside: false,
	};
	assert.equal(
		rewriteShellCommand("cd /repo/web && git status", options, "bash"),
		"cd '/repo/.worktrees/pr-42/web' && git status",
	);
	assert.equal(
		rewriteShellCommand("cd ../other && git status", options, "bash"),
		"cd '/repo/.worktrees/pr-42' && git status",
	);
	assert.equal(rewriteShellCommand("git -C /repo status --short", options, "bash"), "git status --short");
	assert.equal(
		rewriteShellCommand("pwd && git -C /repo status --short", options, "bash"),
		"pwd && git status --short",
	);
	assert.equal(
		rewriteShellCommand("Set-Location -LiteralPath /repo/web; git status", options, "powershell"),
		"Set-Location -LiteralPath '/repo/.worktrees/pr-42/web'; git status",
	);
	assert.equal(
		rewriteShellCommand("Set-Location -LiteralPath=/repo/web; git status", options, "powershell"),
		"Set-Location -LiteralPath '/repo/.worktrees/pr-42/web'; git status",
	);
	assert.equal(
		rewriteShellCommand("pushd /repo/web && pwd", options, "bash"),
		"pushd '/repo/.worktrees/pr-42/web' && pwd",
	);
	assert.equal(
		isForbiddenCheckoutCommand("pushd '/repo/.worktrees/pr-42/web' && pwd", "/repo/.worktrees/pr-42"),
		false,
	);
	assert.throws(() => rewriteShellCommand("cd /tmp && pwd", options, "bash"), /outside the locked worktree/);
});

test("rejects symlinked paths that escape the locked checkout", () => {
	const root = mkdtempSync(join(tmpdir(), "pr-guard-symlink-"));
	const target = join(root, ".worktrees", "pr-42");
	const outside = join(root, "outside");
	try {
		mkdirSync(target, { recursive: true });
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "secret.txt"), "secret\n");
		symlinkSync(outside, join(target, "link"), "dir");
		assert.throws(
			() =>
				rewriteRepositoryPath("link/secret.txt", {
					sourceRoot: root,
					targetRoot: target,
					linkedRoots: [root, target],
					allowOutside: false,
					workingDirectory: target,
				}),
			/escapes the locked worktree/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("quotes shell paths containing apostrophes", () => {
	assert.equal(shellQuote("/tmp/a b/c'd"), "'/tmp/a b/c'\\''d'");
});
