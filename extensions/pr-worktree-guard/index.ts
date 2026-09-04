import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	extractPullRequestUrls,
	isForbiddenCheckoutCommand,
	isRemoteInspectionCommand,
	parsePullRequestUrl,
	parseWorktreePorcelain,
	rewriteRepositoryPath,
	rewriteShellCommand,
	routeCustomToolWorkingDirectory,
	selectMatchingWorktree,
	isGuardWorktree,
	shellQuote,
	type PullRequestRef,
	type WorktreeRecord,
	canonicalRepositoryPath,
} from "./core.ts";
import { RepositoryScopeStore } from "./settings.ts";

const COMMAND_TIMEOUT_MS = 15_000;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_ERROR_LENGTH = 500;
const WORKTREE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const REMOTE_CUSTOM_TOOLS = new Set(["code_review", "code-review"]);
const ROUTABLE_PATH_FIELDS = ["path", "cwd", "worktree", "workingDirectory"] as const;

// Keep this local type narrow: the extension only reads these fields from gh JSON.
type PullRequestJson = {
	number?: unknown;
	url?: unknown;
	state?: unknown;
	isDraft?: unknown;
	headRefName?: unknown;
	headRefOid?: unknown;
	headRepository?: unknown;
	headRepositoryOwner?: unknown;
};

type PullRequestTarget = {
	ref: PullRequestRef;
	repository: string;
	number: number;
	url: string;
	state: string;
	isDraft: boolean;
	headRefName: string;
	headRefOid: string;
	headRepository: string;
};

type LockedWorktree = {
	primaryRoot: string;
	worktree: WorktreeRecord;
	worktrees: WorktreeRecord[];
	target: PullRequestTarget;
};

type GuardState = {
	enabled: boolean;
	generation: number;
	ref?: PullRequestRef;
	target?: PullRequestTarget;
	repositoryRoot?: string;
	scopeRoot?: string;
	lock?: LockedWorktree;
	phase: "idle" | "remote" | "resolving" | "recovering" | "locked" | "blocked";
	error?: string;
	resolution?: Promise<LockedWorktree>;
	lastNotice?: string;
	scopeError?: string;
};

type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
};

type RawRecord = Record<string, unknown>;

class WorktreeRecoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorktreeRecoveryError";
	}
}

class WorktreeSynchronizationError extends Error {
	constructor(
		message: string,
		readonly lock: LockedWorktree,
	) {
		super(message);
		this.name = "WorktreeSynchronizationError";
	}
}

function shortError(value: string) {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > MAX_ERROR_LENGTH ? `${normalized.slice(0, MAX_ERROR_LENGTH - 1)}…` : normalized;
}

function resultError(result: CommandResult, fallback: string): Error {
	const details = shortError(result.stderr || result.stdout);
	return new Error(details ? `${fallback}: ${details}` : fallback);
}

async function run(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	cwd: string,
	timeout = COMMAND_TIMEOUT_MS,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return pi.exec(command, args, { cwd, timeout, signal });
}

function parseJson(stdout: string, label: string): RawRecord {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
		return parsed as RawRecord;
	} catch (error) {
		throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function getNameWithOwner(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!value || typeof value !== "object") return undefined;
	const record = value as RawRecord;
	return asString(record.nameWithOwner);
}

function getOwnerLogin(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (!value || typeof value !== "object") return undefined;
	return asString((value as RawRecord).login);
}

function sameRepository(left: string, right: string): boolean {
	return left.toLowerCase() === right.toLowerCase();
}

function isValidSha(value: string): boolean {
	return /^[0-9a-f]{7,64}$/i.test(value);
}

function parseTarget(ref: PullRequestRef, raw: PullRequestJson, repository: string): PullRequestTarget {
	const number = typeof raw.number === "number" ? raw.number : ref.number;
	const state = asString(raw.state)?.toUpperCase();
	const isDraft = asBoolean(raw.isDraft) ?? false;
	const headRefName = asString(raw.headRefName);
	const headRefOid = asString(raw.headRefOid);
	const directHeadRepository = getNameWithOwner(raw.headRepository);
	const owner = getOwnerLogin(raw.headRepositoryOwner);
	const headRepository = directHeadRepository ?? (owner ? `${owner}/${ref.repository}` : repository);

	if (!Number.isSafeInteger(number) || number !== ref.number) throw new Error("gh returned a mismatched pull-request number");
	if (!state) throw new Error("gh did not return pull-request state");
	if (state !== "OPEN") throw new Error(`pull request is ${state.toLowerCase()}`);
	if (isDraft) throw new Error("pull request is a draft");
	if (!headRefName) throw new Error("gh did not return the pull-request head branch");
	if (!headRefOid || !isValidSha(headRefOid)) throw new Error("gh did not return a valid pull-request head SHA");
	if (!headRepository.includes("/")) throw new Error("gh did not return the pull-request head repository");

	return {
		ref,
		repository,
		number,
		url: asString(raw.url) ?? ref.url,
		state,
		isDraft,
		headRefName,
		headRefOid,
		headRepository,
	};
}

async function resolveCurrentRepository(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await run(pi, "gh", ["repo", "view", "--json", "nameWithOwner"], cwd, COMMAND_TIMEOUT_MS, signal);
	if (result.code !== 0) throw resultError(result, "unable to identify the current GitHub repository");
	const data = parseJson(result.stdout, "gh repo view");
	const repository = asString(data.nameWithOwner);
	if (!repository || !repository.includes("/")) throw new Error("gh repo view did not return nameWithOwner");
	return repository;
}

async function resolveGitRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
	const result = await run(pi, "git", ["rev-parse", "--show-toplevel"], cwd, COMMAND_TIMEOUT_MS, signal);
	if (result.code !== 0) throw resultError(result, "current directory is not a Git checkout");
	const root = result.stdout.trim();
	if (!root) throw new Error("git did not return a repository root");
	return resolve(root);
}

async function resolvePullRequest(
	pi: ExtensionAPI,
	ref: PullRequestRef,
	cwd: string,
	signal?: AbortSignal,
): Promise<PullRequestTarget> {
	const repository = await resolveCurrentRepository(pi, cwd, signal);
	const expectedRepository = `${ref.owner}/${ref.repository}`;
	if (!sameRepository(repository, expectedRepository)) {
		throw new Error(`PR ${ref.url} belongs to ${expectedRepository}, but the current checkout is ${repository}`);
	}

	const result = await run(
		pi,
		"gh",
		[
			"pr",
			"view",
			ref.url,
			"--repo",
			repository,
			"--json",
			"number,url,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner",
		],
		cwd,
		COMMAND_TIMEOUT_MS,
		signal,
	);
	if (result.code !== 0) throw resultError(result, `unable to read ${ref.url}`);
	return parseTarget(ref, parseJson(result.stdout, "gh pr view") as PullRequestJson, repository);
}

async function listWorktrees(pi: ExtensionAPI, root: string, signal?: AbortSignal): Promise<WorktreeRecord[]> {
	const result = await run(pi, "git", ["worktree", "list", "--porcelain"], root, COMMAND_TIMEOUT_MS, signal);
	if (result.code !== 0) throw resultError(result, "unable to list Git worktrees");
	return parseWorktreePorcelain(result.stdout);
}

async function resolveRepositoryScope(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ repositoryRoot: string; scopeRoot: string }> {
	const repositoryRoot = await resolveGitRoot(pi, cwd, signal);
	const worktrees = await listWorktrees(pi, repositoryRoot, signal);
	const scopeRoot = worktrees[0]?.path;
	if (!scopeRoot) throw new Error("Git did not report a primary worktree");
	return { repositoryRoot, scopeRoot: canonicalRepositoryPath(scopeRoot) };
}

async function worktreeStatus(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<string> {
	const result = await run(
		pi,
		"git",
		["status", "--porcelain", "--untracked-files=all"],
		path,
		COMMAND_TIMEOUT_MS,
		signal,
	);
	if (result.code !== 0) throw resultError(result, `unable to inspect worktree ${path}`);
	return result.stdout.trim();
}

async function ensureWorktreesIgnored(pi: ExtensionAPI, root: string, signal?: AbortSignal): Promise<void> {
	const worktreesDirectory = resolve(root, ".worktrees");
	if (existsSync(worktreesDirectory) && resolve(realpathSync(worktreesDirectory)) !== worktreesDirectory) {
		throw new Error(`refusing to use symlinked worktree directory ${worktreesDirectory}`);
	}
	const check = await run(pi, "git", ["check-ignore", "-q", "--", ".worktrees/"], root, COMMAND_TIMEOUT_MS, signal);
	if (check.code === 0) return;
	if (check.code !== 1) throw resultError(check, "unable to verify .worktrees/ ignore protection");

	const pathResult = await run(pi, "git", ["rev-parse", "--git-path", "info/exclude"], root, COMMAND_TIMEOUT_MS, signal);
	if (pathResult.code !== 0) throw resultError(pathResult, "unable to locate Git local excludes");
	const excludePath = resolve(root, pathResult.stdout.trim());
	const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
	const lines = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
	if (lines.has(".worktrees/") || lines.has(".worktrees")) return;

	mkdirSync(resolve(excludePath, ".."), { recursive: true });
	const prefix = existing.length > 0 && !existing.endsWith("\n") ? `${existing}\n` : existing;
	writeFileSync(excludePath, `${prefix}.worktrees/\n`, "utf8");
}

function sanitizeSegment(value: string): string {
	const sanitized = value
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return sanitized || "head";
}

async function branchExists(pi: ExtensionAPI, root: string, branch: string, signal?: AbortSignal): Promise<boolean> {
	const result = await run(pi, "git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], root, COMMAND_TIMEOUT_MS, signal);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw resultError(result, `unable to inspect local branch ${branch}`);
}

function isGuardGeneratedVariant(value: string, base: string): boolean {
	if (value === base) return true;
	const prefix = `${base}-`;
	if (!value.startsWith(prefix)) return false;
	const suffix = value.slice(prefix.length);
	return suffix.length > 0 && suffix[0] >= "2" && suffix[0] <= "9" && [...suffix].every((character) => character >= "0" && character <= "9");
}

async function guardBranchConflicts(
	pi: ExtensionAPI,
	root: string,
	base: string,
	signal?: AbortSignal,
): Promise<string[]> {
	const result = await run(
		pi,
		"git",
		["for-each-ref", "--format=%(refname:short)", "refs/heads/pr-guard/"],
		root,
		COMMAND_TIMEOUT_MS,
		signal,
	);
	if (result.code !== 0) throw resultError(result, "unable to inspect guard-generated local branches");
	const matches = result.stdout
		.split(/\r?\n/)
		.map((branch) => branch.trim())
		.filter(Boolean)
		.filter((branch) => isGuardGeneratedVariant(branch, base));
	return [...new Set(matches)];
}

export async function chooseLocalBranch(
	pi: ExtensionAPI,
	root: string,
	target: PullRequestTarget,
	signal?: AbortSignal,
): Promise<string> {
	const base = `pr-guard/${target.number}-${sanitizeSegment(target.headRefName)}`;
	const [sourceExists, generatedBranches] = await Promise.all([
		branchExists(pi, root, target.headRefName, signal),
		guardBranchConflicts(pi, root, base, signal),
	]);
	const conflicts = sourceExists
		? [`authoritative source branch ${target.headRefName}`]
		: [];
	for (const branch of generatedBranches) conflicts.push(`guard-generated branch ${branch}`);
	if (conflicts.length > 0) {
		throw new Error(
			`cannot create local guard branch ${base}: existing ${conflicts.join(", ")}; repair the existing branch, attach to its worktree, or choose explicitly before retrying`,
		);
	}
	return base;
}

function isMissingPathError(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertWorktreeParentSafe(parent: string): void {
	try {
		const parentStat = lstatSync(parent);
		if (parentStat.isSymbolicLink()) throw new Error(`refusing to use symlinked worktree directory ${parent}`);
		if (!parentStat.isDirectory()) throw new Error(`expected worktree parent is not a directory: ${parent}`);
	} catch (error) {
		if (isMissingPathError(error)) return;
		if (error instanceof Error && error.message.startsWith("refusing to use symlinked")) throw error;
		if (error instanceof Error && error.message.startsWith("expected worktree parent")) throw error;
		throw new Error(`unable to inspect worktree parent ${parent}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function pathEntryExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isMissingPathError(error)) return false;
		throw new Error(`unable to inspect worktree path ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function worktreeDirectoryEntries(parent: string): string[] {
	try {
		return readdirSync(parent);
	} catch (error) {
		if (isMissingPathError(error)) return [];
		throw new Error(`unable to inspect worktree parent ${parent}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function chooseWorktreePath(root: string, target: PullRequestTarget, records: readonly WorktreeRecord[]): string {
	const parent = resolve(root, ".worktrees");
	assertWorktreeParentSafe(parent);
	const base = join(parent, `pr-${target.number}-${sanitizeSegment(target.headRefName)}`);
	const baseName = base.slice(parent.length + 1);
	const canonicalBase = canonicalRepositoryPath(base);
	const conflicts = new Set<string>();

	if (pathEntryExists(base)) conflicts.add(base);
	for (const entry of worktreeDirectoryEntries(parent)) {
		if (isGuardGeneratedVariant(entry, baseName)) conflicts.add(join(parent, entry));
	}

	for (const record of records) {
		const recordPath = resolve(record.path);
		const recordName = recordPath.slice(parent.length + 1);
		if (dirname(recordPath) !== parent) continue;
		if (recordPath === resolve(base) || canonicalRepositoryPath(record.path) === canonicalBase || isGuardGeneratedVariant(recordName, baseName)) {
			conflicts.add(record.path);
		}
	}

	if (conflicts.size > 0) {
		throw new Error(
			`cannot create PR #${target.number} worktree at ${base}: existing generated or registered path(s) ${[...conflicts].join(", ")}; repair the existing checkout, attach to it, or choose explicitly before retrying`,
		);
	}
	return base;
}

function remoteRefName(target: PullRequestTarget): string {
	return `refs/remotes/pr-worktree-guard/${sanitizeSegment(target.repository)}-${target.number}`;
}

async function fetchHead(
	pi: ExtensionAPI,
	root: string,
	target: PullRequestTarget,
	signal?: AbortSignal,
): Promise<string> {
	const remoteRef = remoteRefName(target);
	const remoteUrl = `https://github.com/${target.headRepository}.git`;
	const refspec = `+refs/heads/${target.headRefName}:${remoteRef}`;
	const fetch = await run(pi, "git", ["fetch", "--no-tags", remoteUrl, refspec], root, FETCH_TIMEOUT_MS, signal);
	if (fetch.code !== 0) throw resultError(fetch, `unable to fetch ${target.headRepository}/${target.headRefName}`);

	const revision = await run(pi, "git", ["rev-parse", remoteRef], root, COMMAND_TIMEOUT_MS, signal);
	if (revision.code !== 0) throw resultError(revision, "unable to verify fetched pull-request head");
	const fetchedSha = revision.stdout.trim();
	if (fetchedSha.toLowerCase() !== target.headRefOid.toLowerCase()) {
		throw new Error(
			`PR #${target.number} changed while fetching (expected ${target.headRefOid}, fetched ${fetchedSha}); retry the operation`,
		);
	}
	return remoteRef;
}

function findStaleGuardMatch(records: readonly WorktreeRecord[], root: string, target: PullRequestTarget): WorktreeRecord[] {
	return records.filter(
		(record) =>
			resolve(record.path) !== resolve(root) &&
			!record.bare &&
			!record.prunable &&
			isGuardWorktree(record, target.number) &&
			record.head.toLowerCase() !== target.headRefOid.toLowerCase(),
	);
}

function findDetachedHeadMatch(records: readonly WorktreeRecord[], root: string, sha: string): WorktreeRecord | undefined {
	return records.find(
		(record) =>
			resolve(record.path) !== resolve(root) &&
			record.detached &&
			!record.bare &&
			!record.prunable &&
			record.head.toLowerCase() === sha.toLowerCase(),
	);
}

function findPrunableMatch(records: readonly WorktreeRecord[], root: string, target: PullRequestTarget): WorktreeRecord[] {
	const expectedBranch = `refs/heads/${target.headRefName}`;
	return records.filter(
		(record) =>
			record.prunable &&
			!record.bare &&
			resolve(record.path) !== resolve(root) &&
			(isGuardWorktree(record, target.number) ||
				record.branch === expectedBranch ||
				record.head.toLowerCase() === target.headRefOid.toLowerCase()),
	);
}

async function createWorktree(
	pi: ExtensionAPI,
	root: string,
	target: PullRequestTarget,
	records: WorktreeRecord[],
	signal?: AbortSignal,
): Promise<WorktreeRecord> {
	const branch = await chooseLocalBranch(pi, root, target, signal);
	const path = chooseWorktreePath(root, target, records);
	await ensureWorktreesIgnored(pi, root, signal);
	const remoteRef = await fetchHead(pi, root, target, signal);
	mkdirSync(resolve(path, ".."), { recursive: true });

	const result = await run(pi, "git", ["worktree", "add", "-b", branch, path, remoteRef], root, FETCH_TIMEOUT_MS, signal);
	if (result.code !== 0) throw resultError(result, `unable to create worktree for PR #${target.number}`);

	const refreshed = await listWorktrees(pi, root, signal);
	const created = refreshed.find((record) => resolve(record.path) === resolve(path));
	if (!created) throw new Error(`Git did not register the created worktree ${path}`);
	if (created.head.toLowerCase() !== target.headRefOid.toLowerCase()) {
		throw new Error(`created worktree ${path} has an unexpected HEAD ${created.head}`);
	}
	if (await worktreeStatus(pi, path, signal)) throw new Error(`created worktree ${path} is unexpectedly dirty`);
	return created;
}

async function currentHead(pi: ExtensionAPI, path: string, signal?: AbortSignal): Promise<string> {
	const result = await run(pi, "git", ["rev-parse", "HEAD"], path, COMMAND_TIMEOUT_MS, signal);
	if (result.code !== 0) throw resultError(result, `unable to inspect HEAD for ${path}`);
	const head = result.stdout.trim();
	if (!isValidSha(head)) throw new Error(`worktree ${path} has an invalid HEAD`);
	return head;
}

async function isAncestor(
	pi: ExtensionAPI,
	ancestor: string,
	descendant: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await run(pi, "git", ["merge-base", "--is-ancestor", ancestor, descendant], cwd, COMMAND_TIMEOUT_MS, signal);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw resultError(result, "unable to compare local and remote pull-request history");
}

export type GitRecoveryState = {
	active: boolean;
	conflictedPaths: string;
};

async function inspectGitRecovery(
	pi: ExtensionAPI,
	worktreePath: string,
	signal?: AbortSignal,
): Promise<GitRecoveryState> {
	const conflicts = await run(pi, "git", ["diff", "--name-only", "--diff-filter=U"], worktreePath, COMMAND_TIMEOUT_MS, signal);
	if (conflicts.code !== 0) throw resultError(conflicts, `unable to inspect synchronization conflicts in ${worktreePath}`);

	const rebasePaths = await Promise.all(
		["rebase-merge", "rebase-apply"].map(async (name) => {
			const result = await run(pi, "git", ["rev-parse", "--git-path", name], worktreePath, COMMAND_TIMEOUT_MS, signal);
			if (result.code !== 0) throw resultError(result, `unable to inspect Git recovery state in ${worktreePath}`);
			return resolve(worktreePath, result.stdout.trim());
		}),
	);
	const conflictedPaths = conflicts.stdout.trim();
	return { active: conflictedPaths.length > 0 || rebasePaths.some((path) => existsSync(path)), conflictedPaths };
}

export async function synchronizeStaleWorktree(
	pi: ExtensionAPI,
	root: string,
	target: PullRequestTarget,
	worktree: WorktreeRecord,
	signal?: AbortSignal,
): Promise<{ worktree: WorktreeRecord; worktrees: WorktreeRecord[] }> {
	const remoteRef = await fetchHead(pi, root, target, signal);
	const rebase = await run(pi, "git", ["rebase", "--autostash", remoteRef], worktree.path, FETCH_TIMEOUT_MS, signal);
	const recovery = await inspectGitRecovery(pi, worktree.path, signal);
	if (rebase.code !== 0 && !recovery.active) {
		throw resultError(rebase, `unable to synchronize stale worktree ${worktree.path}`);
	}
	if (recovery.active) {
		const detail = recovery.conflictedPaths
			? `unresolved conflicts: ${recovery.conflictedPaths}`
			: "a Git rebase is still in progress";
		throw new WorktreeRecoveryError(`automatic synchronization needs recovery in ${worktree.path}: ${detail}`);
	}

	const worktrees = await listWorktrees(pi, root, signal);
	const synchronized = worktrees.find((record) => resolve(record.path) === resolve(worktree.path));
	if (!synchronized) throw new Error(`synchronized worktree is no longer registered: ${worktree.path}`);
	const head = await currentHead(pi, synchronized.path, signal);
	if (!(await isAncestor(pi, target.headRefOid, head, root, signal))) {
		throw new Error(`synchronized worktree ${synchronized.path} does not contain PR head ${target.headRefOid}`);
	}
	return { worktree: synchronized, worktrees };
}

async function resolveOrCreateWorktree(
	pi: ExtensionAPI,
	target: PullRequestTarget,
	cwd: string,
	signal?: AbortSignal,
): Promise<LockedWorktree> {
	const currentRoot = await resolveGitRoot(pi, cwd, signal);
	const records = await listWorktrees(pi, currentRoot, signal);
	const primaryRoot = records[0]?.path;
	if (!primaryRoot) throw new Error("Git did not report a primary worktree");
	const selection = selectMatchingWorktree(records, {
		primaryPath: primaryRoot,
		headBranch: target.headRefName,
		headSha: target.headRefOid,
	});

	if (selection.kind === "ambiguous") {
		throw new Error(
			`multiple worktrees match PR #${target.number} by ${selection.reason}: ${selection.paths.join(", ")}; choose one explicitly`,
		);
	}

	if (selection.kind === "match") {
		const worktree = selection.worktree;
		if (!existsSync(worktree.path)) throw new Error(`matching worktree does not exist: ${worktree.path}`);
		if (worktree.head.toLowerCase() === target.headRefOid.toLowerCase()) {
			return { primaryRoot, worktree, worktrees: records, target };
		}
		try {
			const synchronized = await synchronizeStaleWorktree(pi, primaryRoot, target, worktree, signal);
			return { primaryRoot, ...synchronized, target };
		} catch (error) {
			if (error instanceof WorktreeRecoveryError) {
				throw new WorktreeSynchronizationError(error.message, { primaryRoot, worktree, worktrees: records, target });
			}
			throw error;
		}
	}

	const staleGuard = findStaleGuardMatch(records, primaryRoot, target);
	if (staleGuard.length > 1) {
		throw new Error(
			`multiple guard-managed worktrees are stale for PR #${target.number}: ${staleGuard.map((record) => `${record.path} @ ${record.head}`).join(", ")}; choose one explicitly`,
		);
	}
	if (staleGuard.length === 1) {
		const worktree = staleGuard[0];
		try {
			const synchronized = await synchronizeStaleWorktree(pi, primaryRoot, target, worktree, signal);
			return { primaryRoot, ...synchronized, target };
		} catch (error) {
			if (error instanceof WorktreeRecoveryError) {
				throw new WorktreeSynchronizationError(error.message, { primaryRoot, worktree, worktrees: records, target });
			}
			throw error;
		}
	}

	const prunable = findPrunableMatch(records, primaryRoot, target);
	if (prunable.length > 0) {
		throw new Error(
			`matching worktree records are prunable (${prunable.map((record) => record.path).join(", ")}); repair or remove them manually instead of creating a replacement`,
		);
	}

	const detached = findDetachedHeadMatch(records, primaryRoot, target.headRefOid);
	if (detached) {
		throw new Error(`PR head is checked out detached at ${detached.path}; attach or choose that worktree manually`);
	}

	const worktree = await createWorktree(pi, primaryRoot, target, records, signal);
	const refreshed = await listWorktrees(pi, primaryRoot, signal);
	return { primaryRoot, worktree, worktrees: refreshed, target };
}

function pathFields(input: RawRecord): string[] {
	const values: string[] = [];
	for (const field of ROUTABLE_PATH_FIELDS) {
		if (typeof input[field] === "string") values.push(field);
	}
	return values;
}

export function routeInputPaths(
	input: RawRecord,
	toolName: string,
	lock: LockedWorktree,
	cwd: string,
	globalSkillRoot?: string,
): void {
	const options = {
		sourceRoot: lock.primaryRoot,
		targetRoot: lock.worktree.path,
		linkedRoots: lock.worktrees.map((record) => record.path),
		allowOutside: false,
		preserveExternalAbsolute: true,
		workingDirectory: cwd,
		globalSkillRoot,
	};

	for (const field of pathFields(input)) {
		const value = input[field];
		if (typeof value !== "string") continue;
		input[field] = rewriteRepositoryPath(value, options);
	}

	if (Array.isArray(input.paths)) {
		input.paths = input.paths.map((value) => {
			if (typeof value !== "string") throw new Error("paths must contain only strings");
			return rewriteRepositoryPath(value, options);
		});
	}

	if (WORKTREE_TOOL_NAMES.has(toolName) && input.path === undefined) input.path = lock.worktree.path;
	routeCustomToolWorkingDirectory(input, toolName, lock.worktree.path);
}

function containsPathReference(command: string, path: string): boolean {
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[\\s\\"'=:(])${escaped}(?=$|[\\s\\"'=:/\\\\),;])`).test(command);
}

function removePathReference(command: string, path: string): string {
	const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`(?:^|[\\s\\"'=:(])${escaped}(?=$|[\\s\\"'=:/\\\\),;])`, "g");
	return command.replace(pattern, (match) => match.replace(path, ""));
}

function assertNoOtherCheckoutReference(command: string, lock: LockedWorktree): void {
	const withoutTarget = removePathReference(command, lock.worktree.path);
	for (const record of lock.worktrees) {
		if (resolve(record.path) === resolve(lock.worktree.path)) continue;
		if (containsPathReference(withoutTarget, record.path)) {
			throw new Error(`command references another checkout (${record.path}); use ${lock.worktree.path}`);
		}
	}
}

function routeBash(command: string, lock: LockedWorktree): string {
	assertNoOtherCheckoutReference(command, lock);
	return `cd ${shellQuote(lock.worktree.path)} && ${command}`;
}

function routePowerShell(command: string, lock: LockedWorktree): string {
	assertNoOtherCheckoutReference(command, lock);
	const escaped = lock.worktree.path.replaceAll("'", "''");
	return `Set-Location -LiteralPath '${escaped}'; ${command}`;
}

function customInput(event: ToolCallEvent): RawRecord {
	// SAFETY: Pi validates tool-call inputs as objects; this guard only accesses known optional fields.
	return event.input as unknown as RawRecord;
}

function toolNeedsLocalCheckout(event: ToolCallEvent): boolean {
	if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) return true;
	if (WORKTREE_TOOL_NAMES.has(event.toolName)) return true;
	const input = customInput(event);
	return (
		typeof input.path === "string" ||
		Array.isArray(input.paths) ||
		typeof input.cwd === "string" ||
		typeof input.worktree === "string" ||
		typeof input.workingDirectory === "string" ||
		typeof input.command === "string" ||
		"content" in input ||
		"edits" in input
	);
}

function isWithinCurrentRepository(path: string, repositoryRoot: string, cwd: string): boolean {
	const root = resolve(repositoryRoot);
	const candidate = resolve(cwd, path);
	return candidate === root || candidate.startsWith(`${root}/`);
}

export function shellCommandTargetsCurrentRepository(command: string, repositoryRoot: string): boolean {
	if (/\b(?:git|gh)\b/.test(command)) return true;
	const paths = [...command.matchAll(/(?:^|[\s"'=])(?<path>\/[^\s"';&|)]+)/g)].map((match) => match.groups?.path ?? "");
	return paths.length === 0 || paths.some((path) => isWithinCurrentRepository(path, repositoryRoot, repositoryRoot));
}

export function toolTargetsCurrentRepository(event: ToolCallEvent, repositoryRoot: string, cwd: string): boolean {
	if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
		return shellCommandTargetsCurrentRepository(event.input.command, repositoryRoot);
	}
	const input = customInput(event);
	const explicitPaths = pathFields(input).flatMap((field) => (typeof input[field] === "string" ? [input[field]] : []));
	if (Array.isArray(input.paths)) {
		if (input.paths.length === 0 || input.paths.some((value) => typeof value !== "string")) return true;
		explicitPaths.push(...input.paths);
	}
	return explicitPaths.length === 0 || explicitPaths.some((path) => isWithinCurrentRepository(path, repositoryRoot, cwd));
}

function isRemoteTool(event: ToolCallEvent): boolean {
	return REMOTE_CUSTOM_TOOLS.has(event.toolName);
}

function activeTargetDescription(state: GuardState): string {
	if (!state.ref) return "no pull request target";
	if (!state.target) return `${state.ref.url} (metadata unavailable)`;
	if (!state.lock) return `${state.target.url} (worktree not selected)`;
	return `${state.target.url} → ${state.lock.worktree.path}`;
}

function clearTargetState(state: GuardState): void {
	state.generation += 1;
	state.ref = undefined;
	state.target = undefined;
	state.lock = undefined;
	state.phase = "idle";
	state.error = undefined;
	state.resolution = undefined;
	state.lastNotice = undefined;
}

function clearState(state: GuardState): void {
	clearTargetState(state);
	state.repositoryRoot = undefined;
	state.scopeRoot = undefined;
	state.scopeError = undefined;
}

async function refreshRepositoryScope(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: GuardState,
	scopeStore: RepositoryScopeStore,
): Promise<boolean> {
	try {
		const scope = await resolveRepositoryScope(pi, ctx.cwd, ctx.signal);
		if (state.scopeRoot && canonicalRepositoryPath(state.scopeRoot) !== canonicalRepositoryPath(scope.scopeRoot)) {
			clearTargetState(state);
		}
		state.repositoryRoot = scope.repositoryRoot;
		state.scopeRoot = scope.scopeRoot;
		state.scopeError = undefined;
		state.enabled = scopeStore.isEnabled(scope.scopeRoot);
		if (!state.enabled && state.ref) clearTargetState(state);
		return state.enabled;
	} catch (error) {
		if (state.ref) clearTargetState(state);
		state.enabled = false;
		state.repositoryRoot = undefined;
		state.scopeRoot = undefined;
		state.scopeError = error instanceof Error ? error.message : String(error);
		return false;
	}
}

function notifyOnce(ctx: ExtensionContext, state: GuardState, message: string, type: "info" | "warning" | "error"): void {
	if (state.lastNotice === message) return;
	state.lastNotice = message;
	ctx.ui.notify(message, type);
}

async function activateFromUrl(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: GuardState,
	url: string,
): Promise<void> {
	const ref = parsePullRequestUrl(url);
	if (!ref) {
		clearTargetState(state);
		state.phase = "blocked";
		state.error = `unsupported pull-request URL: ${url}`;
		notifyOnce(ctx, state, `PR worktree guard: ${state.error}`, "warning");
		return;
	}

	if (state.ref?.url === ref.url && state.target) return;
	clearTargetState(state);
	const generation = state.generation;
	state.ref = ref;
	state.phase = "remote";
	try {
		const [target, repositoryRoot] = await Promise.all([
			resolvePullRequest(pi, ref, ctx.cwd, ctx.signal),
			resolveGitRoot(pi, ctx.cwd, ctx.signal),
		]);
		if (state.generation !== generation) return;
		state.target = target;
		state.repositoryRoot = repositoryRoot;
		notifyOnce(ctx, state, `PR worktree guard tracking ${state.target.url}`, "info");
	} catch (error) {
		if (state.generation !== generation) return;
		state.phase = "blocked";
		state.error = error instanceof Error ? error.message : String(error);
		notifyOnce(ctx, state, `PR worktree guard: ${state.error}`, "warning");
	}
}

async function revalidateLocked(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: GuardState,
	lock: LockedWorktree,
): Promise<LockedWorktree> {
	if (!existsSync(lock.worktree.path)) throw new Error("the locked worktree no longer exists");

	const refreshedTarget = await resolvePullRequest(pi, lock.target.ref, ctx.cwd, ctx.signal);
	if (!sameRepository(refreshedTarget.repository, lock.target.repository)) {
		throw new Error("the pull-request repository changed while the worktree was locked");
	}
	if (!sameRepository(refreshedTarget.headRepository, lock.target.headRepository)) {
		throw new Error("the pull-request head repository changed while the worktree was locked");
	}
	if (refreshedTarget.headRefName !== lock.target.headRefName) {
		throw new Error("the pull-request head branch changed while the worktree was locked");
	}

	const records = await listWorktrees(pi, lock.primaryRoot, ctx.signal);
	const record = records.find((candidate) => resolve(candidate.path) === resolve(lock.worktree.path));
	if (!record) throw new Error(`the locked worktree is no longer registered: ${lock.worktree.path}`);
	if (record.detached || record.bare || record.prunable) {
		throw new Error(`the locked worktree is no longer a usable linked checkout: ${lock.worktree.path}`);
	}
	if (record.branch !== lock.worktree.branch) {
		throw new Error(`the locked worktree branch changed unexpectedly: ${record.branch ?? "detached"}`);
	}
	if (state.phase === "recovering") {
		const recovery = await inspectGitRecovery(pi, record.path, ctx.signal);
		if (recovery.active) {
			const detail = recovery.conflictedPaths
				? `unresolved conflicts: ${recovery.conflictedPaths}`
				: "a Git rebase is still in progress";
			throw new Error(`the locked worktree still needs Git recovery: ${detail}`);
		}
	}

	const oldRemoteHead = lock.target.headRefOid;
	const newRemoteHead = refreshedTarget.headRefOid;
	if (newRemoteHead !== oldRemoteHead) {
		try {
			const synchronized = await synchronizeStaleWorktree(pi, lock.primaryRoot, refreshedTarget, record, ctx.signal);
			state.target = refreshedTarget;
			return { primaryRoot: lock.primaryRoot, ...synchronized, target: refreshedTarget };
		} catch (error) {
			if (error instanceof WorktreeRecoveryError) {
				throw new WorktreeSynchronizationError(error.message, {
					primaryRoot: lock.primaryRoot,
					worktree: record,
					worktrees: records,
					target: refreshedTarget,
				});
			}
			throw error;
		}
	}

	const localHead = await currentHead(pi, lock.worktree.path, ctx.signal);
	if (localHead !== oldRemoteHead && !(await isAncestor(pi, oldRemoteHead, localHead, lock.primaryRoot, ctx.signal))) {
		throw new Error(`the locked worktree HEAD ${localHead} no longer descends from the original PR head ${oldRemoteHead}`);
	}

	state.target = refreshedTarget;
	return { primaryRoot: lock.primaryRoot, worktree: record, worktrees: records, target: refreshedTarget };
}

function enterRecovery(pi: ExtensionAPI, state: GuardState, error: WorktreeSynchronizationError): LockedWorktree {
	state.lock = error.lock;
	state.phase = "recovering";
	state.error = error.message;
	pi.sendMessage(
		{
			customType: "pr-worktree-guard",
			content:
				`Automatic PR worktree synchronization needs recovery in ${error.lock.worktree.path}: ${error.message} ` +
				"Inspect the Git state, resolve it in this worktree, and continue without creating another checkout.",
			display: true,
		},
		{ deliverAs: "steer" },
	);
	return error.lock;
}

async function ensureLocked(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: GuardState,
): Promise<LockedWorktree> {
	if (state.lock) {
		try {
			const lock = await revalidateLocked(pi, ctx, state, state.lock);
			state.lock = lock;
			state.phase = "locked";
			state.error = undefined;
			return lock;
		} catch (error) {
			if (error instanceof WorktreeSynchronizationError) return enterRecovery(pi, state, error);
			if (state.phase !== "recovering") throw error;
			return state.lock;
		}
	}
	if (!state.target) throw new Error(state.error ?? "pull-request metadata is not available");
	if (state.resolution) return state.resolution;

	state.phase = "resolving";
	state.error = undefined;
	const generation = state.generation;
	const resolution = resolveOrCreateWorktree(pi, state.target, ctx.cwd, ctx.signal)
		.then((lock) => {
			if (state.generation !== generation) throw new Error("PR worktree resolution was superseded by a newer target");
			state.lock = lock;
			state.phase = "locked";
			state.error = undefined;
			return lock;
		})
		.catch((error: unknown) => {
			if (error instanceof WorktreeSynchronizationError && state.generation === generation) {
				return enterRecovery(pi, state, error);
			}
			if (state.generation === generation) {
				state.phase = "blocked";
				state.error = error instanceof Error ? error.message : String(error);
			}
			throw error;
		})
		.finally(() => {
			if (state.generation === generation) state.resolution = undefined;
		});
	state.resolution = resolution;
	return resolution;
}

function blockReason(state: GuardState, detail: string): string {
	return `PR worktree guard blocked this operation (${activeTargetDescription(state)}): ${detail}`;
}

function routeLockedTool(event: ToolCallEvent, ctx: ExtensionContext, lock: LockedWorktree): void {
	const shellRewriteOptions = {
		sourceRoot: lock.primaryRoot,
		targetRoot: lock.worktree.path,
		linkedRoots: lock.worktrees.map((record) => record.path),
		allowOutside: false,
	};
	if (isToolCallEventType("bash", event)) {
		const rewritten = rewriteShellCommand(event.input.command, shellRewriteOptions, "bash");
		if (isForbiddenCheckoutCommand(rewritten, lock.worktree.path)) {
			throw new Error("branch/worktree-changing Git commands are controlled by the PR worktree guard");
		}
		event.input.command = routeBash(rewritten, lock);
		return;
	}
	if (isToolCallEventType("powershell", event)) {
		const rewritten = rewriteShellCommand(event.input.command, shellRewriteOptions, "powershell");
		if (isForbiddenCheckoutCommand(rewritten, lock.worktree.path)) {
			throw new Error("branch/worktree-changing Git commands are controlled by the PR worktree guard");
		}
		event.input.command = routePowerShell(rewritten, lock);
		return;
	}

	const input = customInput(event);
	if (typeof input.command === "string") {
		throw new Error("command-bearing custom tools cannot be safely routed; use bash or powershell");
	}
	routeInputPaths(input, event.toolName, lock, ctx.cwd);
}

function statusText(state: GuardState): string {
	const lines = [
		`enabled: ${state.enabled}`,
		`repository: ${state.scopeRoot ?? "unavailable"}`,
		`phase: ${state.phase}`,
		`target: ${activeTargetDescription(state)}`,
	];
	if (state.scopeError) lines.push(`scope error: ${state.scopeError}`);
	if (state.target) lines.push(`head: ${state.target.headRefName} @ ${state.target.headRefOid}`);
	if (state.error) lines.push(`error: ${state.error}`);
	return lines.join("\n");
}

export default function prWorktreeGuard(pi: ExtensionAPI, configuredScopeStore?: RepositoryScopeStore): void {
	const scopeStore = configuredScopeStore ?? new RepositoryScopeStore();
	const state: GuardState = { enabled: false, generation: 0, phase: "idle" };

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") clearState(state);
		await refreshRepositoryScope(pi, ctx, state, scopeStore);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (!(await refreshRepositoryScope(pi, ctx, state, scopeStore))) return { action: "continue" };
		const urls = extractPullRequestUrls(event.text);
		if (urls.length > 1) {
			clearTargetState(state);
			state.phase = "blocked";
			state.error = "multiple PR URLs were supplied; use one explicit PR URL";
			notifyOnce(ctx, state, `PR worktree guard: ${state.error}`, "warning");
			return { action: "continue" };
		}
		const url = urls[0];
		if (url) await activateFromUrl(pi, ctx, state, url);
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!(await refreshRepositoryScope(pi, ctx, state, scopeStore))) return;
		const urls = extractPullRequestUrls(event.prompt);
		if (urls.length === 1 && urls[0]) await activateFromUrl(pi, ctx, state, urls[0]);
		if (!state.ref) return;
		const targetText = state.lock
			? state.phase === "recovering"
				? `The selected worktree is ${state.lock.worktree.path}. Its automatic update needs Git recovery; inspect and resolve it there, then continue working in the same checkout.`
				: `The selected worktree is ${state.lock.worktree.path}. All local repository reads, builds, tests, and edits must use it.`
			: "The worktree guard must resolve the PR worktree before any local repository operation.";
		const errorText = state.error ? ` Current guard error: ${state.error}` : "";
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\nPR WORKTREE GUARD (enforced): Target ${activeTargetDescription(state)}. ${targetText} Do not create, switch, reset, or remove another checkout; the guard controls that operation. Global skills under ~/.agents/skills are external resources; use their exact paths and never rewrite them as repository-relative .agents/skills paths.${errorText}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled || !state.ref) return;
		if (isRemoteTool(event)) return;

		if (!state.ref) {
			if (state.error) {
				return { block: true, terminate: true, reason: blockReason(state, state.error) };
			}
			return;
		}

		if (!toolNeedsLocalCheckout(event) || !toolTargetsCurrentRepository(event, state.repositoryRoot ?? ctx.cwd, ctx.cwd)) return;

		if (!state.target) {
			if (isToolCallEventType("bash", event) && isRemoteInspectionCommand(event.input.command)) return;
			return { block: true, reason: blockReason(state, state.error ?? "PR metadata is unavailable") };
		}

		if (!state.lock && isToolCallEventType("bash", event) && isRemoteInspectionCommand(event.input.command)) return;

		let lock: LockedWorktree;
		try {
			lock = await ensureLocked(pi, ctx, state);
		} catch (error) {
			return {
				block: true,
				terminate: true,
				reason: blockReason(state, error instanceof Error ? error.message : String(error)),
			};
		}

		try {
			routeLockedTool(event, ctx, lock);
		} catch (error) {
			return {
				block: true,
				reason: blockReason(state, error instanceof Error ? error.message : String(error)),
			};
		}
	});

	pi.registerCommand("worktree-guard", {
		description: "Show or control the PR worktree guard for the current repository",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();
			if (!command || command === "status") {
				await refreshRepositoryScope(pi, ctx, state, scopeStore);
				ctx.ui.notify(statusText(state), "info");
				return;
			}
			if (command === "clear") {
				clearTargetState(state);
				ctx.ui.notify("PR worktree guard target cleared", "info");
				return;
			}
			if (command === "on" || command === "off") {
				try {
					const scope = await resolveRepositoryScope(pi, ctx.cwd, ctx.signal);
					scopeStore.setEnabled(scope.scopeRoot, command === "on");
					state.repositoryRoot = scope.repositoryRoot;
					state.scopeRoot = scope.scopeRoot;
					state.scopeError = undefined;
					state.enabled = command === "on";
					clearTargetState(state);
					ctx.ui.notify(
						`PR worktree guard ${command === "on" ? "enabled" : "disabled"} for ${scope.scopeRoot}`,
						command === "on" ? "info" : "warning",
					);
				} catch (error) {
					ctx.ui.notify(`PR worktree guard: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /worktree-guard [status|on|off|clear]", "warning");
		},
	});
}
