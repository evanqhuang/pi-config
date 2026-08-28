import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
	canonicalRepositoryPath,
	parseWorktreePorcelain,
	rewriteRepositoryPath,
	routeCustomToolWorkingDirectory,
} from "./core.ts";
import { RepositoryScopeStore } from "./settings.ts";

mock.module("@earendil-works/pi-coding-agent", () => ({
	isToolCallEventType: (name: string, event: { toolName?: string }) => event.toolName === name,
}));

const {
	default: prWorktreeGuard,
	routeInputPaths,
	synchronizeStaleWorktree,
	toolTargetsCurrentRepository,
} = await import("./index.ts");

type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

function runGit(cwd: string, args: string[]): CommandResult {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
		code: result.exitCode,
		killed: false,
	};
}

function git(cwd: string, ...args: string[]): string {
	const result = runGit(cwd, args);
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

async function withRepositoryFixture(
	callback: (fixture: { root: string; remote: string; primary: string; worktree: string; remoteHead: string }) => Promise<void>,
	{ conflictingUpdate = false }: { conflictingUpdate?: boolean } = {},
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pr-worktree-guard-"));
	try {
		const remote = join(root, "remote.git");
		const seed = join(root, "seed");
		const primary = join(root, "primary");
		const worktree = join(root, "worktree");
		const updater = join(root, "updater");

		git(root, "init", "--bare", remote);
		git(root, "init", "--initial-branch=main", seed);
		git(seed, "config", "user.email", "guard@example.test");
		git(seed, "config", "user.name", "Guard Test");
		await writeFile(join(seed, "tracked.txt"), "base\n");
		git(seed, "add", "tracked.txt");
		git(seed, "commit", "-m", "initial");
		git(seed, "remote", "add", "origin", remote);
		git(seed, "push", "origin", "main");
		git(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");

		git(root, "clone", remote, primary);
		git(primary, "config", "user.email", "guard@example.test");
		git(primary, "config", "user.name", "Guard Test");
		git(primary, "worktree", "add", "-b", "pr-guard/588-main", worktree, "origin/main");
		await writeFile(join(worktree, "tracked.txt"), "local dirty change\n");
		await writeFile(join(worktree, "untracked.txt"), "untracked local change\n");

		git(root, "clone", remote, updater);
		git(updater, "config", "user.email", "guard@example.test");
		git(updater, "config", "user.name", "Guard Test");
		const upstreamFile = conflictingUpdate ? "tracked.txt" : "upstream.txt";
		await writeFile(join(updater, upstreamFile), "upstream change\n");
		git(updater, "add", upstreamFile);
		git(updater, "commit", "-m", "upstream");
		git(updater, "push", "origin", "main");

		await callback({ root, remote, primary, worktree, remoteHead: git(updater, "rev-parse", "HEAD") });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("context-mode worktree routing", () => {
	const options = {
		sourceRoot: "/repo",
		targetRoot: "/repo/.worktrees/pr-588",
		linkedRoots: ["/repo", "/repo/.worktrees/pr-588"],
		allowOutside: false,
		workingDirectory: "/repo",
	};

	test("injects the locked worktree cwd into context-mode command tools", () => {
		for (const toolName of ["ctx_execute", "ctx_batch_execute"]) {
			const input: Record<string, unknown> = {};
			routeCustomToolWorkingDirectory(input, toolName, options.targetRoot);
			expect(input.cwd).toBe(options.targetRoot);
		}
	});

	test("preserves an explicit context-mode cwd for path rewriting", () => {
		const input: Record<string, unknown> = { cwd: "/repo/web" };
		routeCustomToolWorkingDirectory(input, "ctx_execute", options.targetRoot);
		expect(input.cwd).toBe("/repo/web");
	});

	test("rewrites an explicit primary-checkout cwd to the locked worktree", () => {
		expect(rewriteRepositoryPath("/repo", options)).toBe("/repo/.worktrees/pr-588");
	});

	test("keeps an explicit locked-worktree cwd unchanged", () => {
		expect(rewriteRepositoryPath("/repo/.worktrees/pr-588/web", options)).toBe(
			"/repo/.worktrees/pr-588/web",
		);
	});
});

describe("PR worktree guard scope", () => {
	test("preserves global skills and routes project-local skills", async () => {
		const root = await mkdtemp(join(tmpdir(), "pr-worktree-skill-path-"));
		try {
			const sourceRoot = join(root, "repo");
			const targetRoot = join(sourceRoot, ".worktrees", "pr-588");
			const globalSkillRoot = join(root, "global", ".agents", "skills");
			const skillRelativePath = join("using-git-worktrees", "SKILL.md");
			const globalSkillPath = join(globalSkillRoot, skillRelativePath);
			await mkdir(join(globalSkillRoot, "using-git-worktrees"), { recursive: true });
			await writeFile(globalSkillPath, "global skill\n");

			const options = {
				sourceRoot,
				targetRoot,
				linkedRoots: [sourceRoot, targetRoot],
				allowOutside: false,
				preserveExternalAbsolute: true,
				workingDirectory: sourceRoot,
				globalSkillRoot,
			};

			expect(rewriteRepositoryPath(`.agents/skills/${skillRelativePath.replaceAll("\\\\", "/")}`, options)).toBe(
				canonicalRepositoryPath(globalSkillPath),
			);
			expect(rewriteRepositoryPath(`../global/.agents/skills/${skillRelativePath.replaceAll("\\\\", "/")}`, options)).toBe(
				canonicalRepositoryPath(globalSkillPath),
			);
			expect(rewriteRepositoryPath(`~/.agents/skills/${skillRelativePath.replaceAll("\\\\", "/")}`, options)).toBe(
				canonicalRepositoryPath(globalSkillPath),
			);
			expect(rewriteRepositoryPath(globalSkillPath, options)).toBe(globalSkillPath);

			const projectSkillPath = join(sourceRoot, ".agents", "skills", skillRelativePath);
			await mkdir(join(sourceRoot, ".agents", "skills", "using-git-worktrees"), { recursive: true });
			await writeFile(projectSkillPath, "project skill\n");
				expect(rewriteRepositoryPath(`.agents/skills/${skillRelativePath.replaceAll("\\\\", "/")}`, options)).toBe(
				join(canonicalRepositoryPath(targetRoot), ".agents", "skills", skillRelativePath),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("preserves global paths when routing mixed tool inputs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pr-worktree-mixed-paths-"));
		try {
			const sourceRoot = join(root, "repo");
			const targetRoot = join(sourceRoot, ".worktrees", "pr-588");
			const globalSkillRoot = join(root, "global", ".agents", "skills");
			const skillRelativePath = join("using-git-worktrees", "SKILL.md");
			const globalSkillPath = join(globalSkillRoot, skillRelativePath);
			await mkdir(join(sourceRoot, "src"), { recursive: true });
			await mkdir(join(globalSkillRoot, "using-git-worktrees"), { recursive: true });
			await writeFile(join(sourceRoot, "README.md"), "repo\n");
			await writeFile(globalSkillPath, "global\n");

			const lock = {
				primaryRoot: sourceRoot,
				worktree: { path: targetRoot, head: "head", branch: "refs/heads/pr-guard/588-main", detached: false, bare: false, prunable: false },
				worktrees: [
					{ path: sourceRoot, head: "base", branch: "refs/heads/main", detached: false, bare: false, prunable: false },
					{ path: targetRoot, head: "head", branch: "refs/heads/pr-guard/588-main", detached: false, bare: false, prunable: false },
				],
				target: {},
			} as Parameters<typeof routeInputPaths>[2];
			const input: Record<string, unknown> = {
				path: `.agents/skills/${skillRelativePath.replaceAll("\\\\", "/")}`,
				cwd: sourceRoot,
				paths: [globalSkillPath, join(sourceRoot, "README.md")],
			};

			routeInputPaths(input, "read", lock, sourceRoot, globalSkillRoot);
			expect(input.path).toBe(canonicalRepositoryPath(globalSkillPath));
			expect(input.cwd).toBe(join(canonicalRepositoryPath(targetRoot)));
			expect(input.paths).toEqual([globalSkillPath, join(canonicalRepositoryPath(targetRoot), "README.md")]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("bypasses an external absolute path", () => {
		const externalRead = { toolName: "read", input: { path: "/opt/homebrew/lib/node_modules/pi/README.md" } } as ToolCallEvent;
		const repositoryRead = { toolName: "read", input: { path: "/repo/README.md" } } as ToolCallEvent;
		const mixedPaths = { toolName: "read", input: { paths: ["/opt/README.md", "/repo/README.md"] } } as ToolCallEvent;
		const emptyPaths = { toolName: "read", input: { paths: [] } } as ToolCallEvent;
		const externalShell = { toolName: "bash", input: { command: "zsh -n /Users/evanhuang/.zshrc" } } as ToolCallEvent;
		const repositoryShell = { toolName: "bash", input: { command: "git status --short" } } as ToolCallEvent;

		expect(toolTargetsCurrentRepository(externalRead, "/repo", "/repo")).toBe(false);
		expect(toolTargetsCurrentRepository(repositoryRead, "/repo", "/repo")).toBe(true);
		expect(toolTargetsCurrentRepository(mixedPaths, "/repo", "/repo")).toBe(true);
		expect(toolTargetsCurrentRepository(emptyPaths, "/repo", "/repo")).toBe(true);
		expect(toolTargetsCurrentRepository(repositoryRead, "/repo", "/repo/web")).toBe(true);
		expect(toolTargetsCurrentRepository(externalShell, "/repo", "/repo")).toBe(false);
		expect(toolTargetsCurrentRepository(repositoryShell, "/repo", "/repo")).toBe(true);
	});
});

describe("persistent repository enablement", () => {
	test("stores enablement by the primary repository root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pr-worktree-scope-"));
		try {
			const settingsPath = join(root, "settings.json");
			const primaryRoot = join(root, "primary");
			const linkedWorktree = join(root, "linked");
			await mkdir(primaryRoot, { recursive: true });
			await mkdir(linkedWorktree, { recursive: true });
			const store = new RepositoryScopeStore(settingsPath);

			expect(store.isEnabled(primaryRoot)).toBe(false);
			store.setEnabled(primaryRoot, true);
			expect(store.isEnabled(primaryRoot)).toBe(true);
			expect(store.isEnabled(linkedWorktree)).toBe(false);
			store.setEnabled(primaryRoot, false);
			expect(store.isEnabled(primaryRoot)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("fails closed for malformed settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pr-worktree-settings-"));
		try {
			const settingsPath = join(root, "settings.json");
			const repositoryRoot = join(root, "repo");
			await mkdir(repositoryRoot, { recursive: true });
			await writeFile(settingsPath, "not json");
			expect(new RepositoryScopeStore(settingsPath).isEnabled(repositoryRoot)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("does not inspect PR metadata while the current repository is disabled", async () => {
		await withRepositoryFixture(async ({ primary }) => {
			const settingsPath = join(primary, ".guard-settings.json");
			const store = new RepositoryScopeStore(settingsPath);
			const handlers = new Map<string, (...args: any[]) => unknown>();
			const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
			const commandsRun: string[] = [];
			const pi = {
				exec: async (command: string, args: string[], options: { cwd: string }) => {
					commandsRun.push(command);
					return runGit(options.cwd, args);
				},
				on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
				registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, definition),
			} as unknown as ExtensionAPI;
			const context = {
				cwd: primary,
				signal: undefined,
				hasUI: false,
				ui: { notify: () => undefined },
			};
			prWorktreeGuard(pi, store);

			await handlers.get("session_start")?.({ reason: "startup" }, context);
			await handlers.get("input")?.(
				{ source: "interactive", text: "Fix https://github.com/example/hostelhawk/pull/588" },
				context,
			);
			expect(commandsRun).not.toContain("gh");
			expect(store.isEnabled(primary)).toBe(false);
		});
	});

	test("persists on and off through the worktree-guard command", async () => {
		await withRepositoryFixture(async ({ primary }) => {
			const settingsPath = join(primary, ".guard-settings.json");
			const store = new RepositoryScopeStore(settingsPath);
			const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
			const pi = {
				exec: async (command: string, args: string[], options: { cwd: string }) => {
					if (command !== "git") throw new Error(`unexpected command: ${command}`);
					return runGit(options.cwd, args);
				},
				on: () => undefined,
				registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, definition),
			} as unknown as ExtensionAPI;
			const notices: string[] = [];
			const context = {
				cwd: primary,
				signal: undefined,
				hasUI: false,
				ui: { notify: (message: string) => notices.push(message) },
			};
			prWorktreeGuard(pi, store);
			const command = commands.get("worktree-guard");
			if (!command) throw new Error("worktree-guard command was not registered");

			await command.handler("on", context);
			expect(store.isEnabled(primary)).toBe(true);
			await command.handler("status", context);
			expect(notices.at(-1)).toContain("enabled: true");
			await command.handler("off", context);
			expect(store.isEnabled(primary)).toBe(false);
			await command.handler("status", context);
			expect(notices.at(-1)).toContain("enabled: false");
		});
	});
});

describe("stale worktree synchronization", () => {
	test("fast-forwards a stale worktree and restores tracked dirty edits", async () => {
		await withRepositoryFixture(async ({ primary, remote, worktree, remoteHead }) => {
			const records = parseWorktreePorcelain(git(primary, "worktree", "list", "--porcelain"));
			const staleWorktree = records.find((record) => record.branch === "refs/heads/pr-guard/588-main");
			if (!staleWorktree) throw new Error("fixture worktree was not registered");

			const pi = {
				exec: async (command: string, args: string[], options: { cwd: string }) => {
					if (command !== "git") throw new Error(`unexpected command: ${command}`);
					const rewritten = args[0] === "fetch" ? [...args.slice(0, 2), remote, ...args.slice(3)] : args;
					return runGit(options.cwd, rewritten);
				},
			} as unknown as ExtensionAPI;
			const target = {
				number: 588,
				repository: "example/hostelhawk",
				headRepository: "example/hostelhawk",
				headRefName: "main",
				headRefOid: remoteHead,
			} as Parameters<typeof synchronizeStaleWorktree>[2];

			const synchronized = await synchronizeStaleWorktree(pi, primary, target, staleWorktree);

			expect(synchronized.worktree.branch).toBe("refs/heads/pr-guard/588-main");
			expect(git(worktree, "rev-parse", "HEAD")).toBe(remoteHead);
			expect(await readFile(join(worktree, "tracked.txt"), "utf8")).toBe("local dirty change\n");
			expect(await readFile(join(worktree, "untracked.txt"), "utf8")).toBe("untracked local change\n");
			expect(runGit(worktree, ["status", "--short"]).stdout.trimEnd()).toBe(" M tracked.txt\n?? untracked.txt");
		});
	});

	test("reports an autostash conflict without discarding the worktree state", async () => {
		await withRepositoryFixture(
			async ({ primary, remote, worktree, remoteHead }) => {
				const records = parseWorktreePorcelain(git(primary, "worktree", "list", "--porcelain"));
				const staleWorktree = records.find((record) => record.branch === "refs/heads/pr-guard/588-main");
				if (!staleWorktree) throw new Error("fixture worktree was not registered");

				const pi = {
					exec: async (command: string, args: string[], options: { cwd: string }) => {
						if (command !== "git") throw new Error(`unexpected command: ${command}`);
						const rewritten = args[0] === "fetch" ? [...args.slice(0, 2), remote, ...args.slice(3)] : args;
						return runGit(options.cwd, rewritten);
					},
				} as unknown as ExtensionAPI;
				const target = {
					number: 588,
					repository: "example/hostelhawk",
					headRepository: "example/hostelhawk",
					headRefName: "main",
					headRefOid: remoteHead,
				} as Parameters<typeof synchronizeStaleWorktree>[2];

				await expect(synchronizeStaleWorktree(pi, primary, target, staleWorktree)).rejects.toThrow(
					"automatic synchronization",
				);
				expect(runGit(worktree, ["status", "--short"]).stdout).toContain("UU tracked.txt");
			},
			{ conflictingUpdate: true },
		);
	});
});
