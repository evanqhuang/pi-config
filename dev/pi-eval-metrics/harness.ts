import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { buildReport, writeReport, type EvalReport } from "./report.js";
import { writeJsonAtomically, writeTextAtomically } from "./writer.js";

const execFileAsync = promisify(execFile);
const PACKAGE_DIR = resolve(new URL(".", import.meta.url).pathname);
const DEFAULT_EVAL_ROOT = join(homedir(), ".pi", "evals");
const HARNESS_SCHEMA_VERSION = 2;
const COMMON_PROTOCOL = `

## Completion protocol

Work through the entire feature, not just the first passing test. Inspect the
existing repository patterns before editing. Add focused unit/integration/UI
coverage as appropriate, update documentation, and run the repository's
prescribed focused tests, full applicable test suites, typecheck, build, and
lint. Fix regressions before reporting completion. Do not commit or push. Do
not modify pi-notes, pi-eval-metrics, or the runner. Keep going until the
implementation and verification are complete.`;

type Arm = "notes-absent" | "notes-present";
type RunStatus = "pending" | "running" | "completed" | "failed";
type RepositoryKey = "records" | "hostelhawk";

interface Scenario {
	id: string;
	title: string;
	repository: RepositoryKey;
	path: string;
	prompt: string;
	promptHash: string;
	promptLength: number;
}

interface ProcessResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
}

interface RunProcessOptions {
	stdoutPath?: string;
	stderrPath?: string;
	onStdoutLine?: (line: string) => void;
	heartbeat?: () => void;
}

export interface ActivitySnapshot {
	turns: number;
	tools: number;
	toolErrors: number;
	compactions: number;
	thinkingChars: number;
	responseChars: number;
	repeatedToolCalls: number;
	postCompactionRediscoveries: number;
	maxConsecutiveSameTool: number;
	firstToolMs: number | null;
	firstMutationMs: number | null;
	firstVerificationMs: number | null;
}

interface HarnessRun {
	scenarioId: string;
	repository: RepositoryKey;
	arm: Arm;
	status: RunStatus;
	worktree: string;
	sessionDir: string;
	startedAt?: string;
	endedAt?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	timedOut?: boolean;
	worktreeDirty?: boolean;
	stdoutPath?: string;
	stderrPath?: string;
	activity?: ActivitySnapshot;
	evalRunId?: string;
	experimentKey?: string;
	evalManifestPath?: string;
	sessionFile?: string;
	reportJson?: string;
}

interface HarnessManifest {
	schemaVersion: number;
	kind: "pi-eval-harness";
	harnessId: string;
	createdAt: string;
	updatedAt: string;
	status: "running" | "completed" | "partial";
	repositories: Record<RepositoryKey, { path: string; baselineCommit: string; sourceDirty: boolean }>;
	provider: string;
	model: string;
	thinking: string;
	timeoutMs: number;
	scenarios: Array<{ id: string; title: string; repository: RepositoryKey; promptHash: string; promptLength: number }>;
	runs: HarnessRun[];
}

interface CliOptions {
	repo?: string;
	hostelhawkRepo?: string;
	baseline?: string;
	hostelhawkBaseline?: string;
	provider: string;
	model: string;
	thinking: string;
	timeoutMs: number;
	piBin: string;
	cleanupWorktrees: boolean;
	skipInstall: boolean;
	dryRun: boolean;
	resume?: string;
	scenarioIds?: string[];
}

interface EvalManifestLike {
	kind?: string;
	runId?: string;
	experimentKey?: string;
	sessionFile?: string;
}

const DEFAULT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const DEFAULT_PROVIDER = process.env.PI_EVAL_PROVIDER ?? "qwen38-main";
const DEFAULT_MODEL = process.env.PI_EVAL_MODEL ?? "qwen3.8-27b";
const DEFAULT_THINKING = process.env.PI_EVAL_THINKING ?? "medium";

function printHelp(): void {
	console.log(`Usage: npm run benchmark -- [options]

Runs every scenario sequentially, Notes-absent first and Notes-present second.

Options:
  --repo <path>             Records repository (default: /private/tmp/records-dd-eval)
  --hostelhawk-repo <path> HostelHawk repository (default: ~/hostelhawk)
  --baseline <commit>      Records baseline commit (default: repository HEAD)
  --hostelhawk-baseline <commit> HostelHawk baseline (default: repository HEAD)
  --scenario <id,...>      Run selected scenario IDs (default: all twelve)
  --provider <name>        Pi provider (default: ${DEFAULT_PROVIDER})
  --model <id>             Pi model (default: ${DEFAULT_MODEL})
  --thinking <level>       Thinking level (default: ${DEFAULT_THINKING})
  --timeout <duration>     Per-arm timeout, e.g. 3h, 90m, 30s
  --pi-bin <path>          Pi executable (default: pi)
  --resume <harness-id>    Resume pending/failed runs from ~/.pi/evals/harness
  --cleanup-worktrees      Remove worktrees after each run
  --skip-install           Do not install dependencies during setup
  --dry-run                Validate and print the 16-run plan without running
  --help                   Show this help
`);
}

function requiredValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

export function parseDuration(value: string): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/iu.exec(value.trim());
	if (!match) throw new Error(`Invalid duration: ${value}; use values such as 3h, 90m, or 30s`);
	const amount = Number(match[1]);
	const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2].toLowerCase() as "ms" | "s" | "m" | "h"];
	return Math.max(1, Math.round(amount * multiplier));
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL,
		thinking: DEFAULT_THINKING,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		piBin: "pi",
		cleanupWorktrees: false,
		skipInstall: false,
		dryRun: false,
	};
	const scenarioIds: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--repo": options.repo = requiredValue(argv, index, arg); index += 1; break;
			case "--hostelhawk-repo": options.hostelhawkRepo = requiredValue(argv, index, arg); index += 1; break;
			case "--baseline": options.baseline = requiredValue(argv, index, arg); index += 1; break;
			case "--hostelhawk-baseline": options.hostelhawkBaseline = requiredValue(argv, index, arg); index += 1; break;
			case "--provider": options.provider = requiredValue(argv, index, arg); index += 1; break;
			case "--model": options.model = requiredValue(argv, index, arg); index += 1; break;
			case "--thinking": options.thinking = requiredValue(argv, index, arg); index += 1; break;
			case "--timeout": options.timeoutMs = parseDuration(requiredValue(argv, index, arg)); index += 1; break;
			case "--pi-bin": options.piBin = requiredValue(argv, index, arg); index += 1; break;
			case "--scenario": scenarioIds.push(...requiredValue(argv, index, arg).split(",").map(id => id.trim()).filter(Boolean)); index += 1; break;
			case "--resume": options.resume = requiredValue(argv, index, arg); index += 1; break;
			case "--cleanup-worktrees": options.cleanupWorktrees = true; break;
			case "--skip-install": options.skipInstall = true; break;
			case "--dry-run": options.dryRun = true; break;
			case "--help": printHelp(); process.exit(0);
			default: throw new Error(`Unknown option: ${arg}`);
		}
	}
	if (scenarioIds.length) options.scenarioIds = [...new Set(scenarioIds)];
	return options;
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(() => true).catch(() => false);
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		maxBuffer: 2 * 1024 * 1024,
	});
	return result.stdout.trim();
}

async function resolveRepository(requested: string | undefined, fallbacks: string[]): Promise<string> {
	const candidates = [requested, ...fallbacks].filter((value): value is string => Boolean(value));
	for (const candidate of candidates) {
		try {
			return await git(resolve(candidate), ["rev-parse", "--show-toplevel"]);
		} catch {
			// Try the next candidate.
		}
	}
	throw new Error(`Could not find a Git repository from: ${candidates.join(", ")}`);
}

export async function loadScenarios(selectedIds?: string[]): Promise<Scenario[]> {
	const entries = await readdir(join(PACKAGE_DIR, "benchmarks", "scenarios"), { withFileTypes: true });
	const scenarios: Scenario[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
		const path = join(PACKAGE_DIR, "benchmarks", "scenarios", entry.name);
		const body = (await readFile(path, "utf8")).trim();
		const title = body.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? basename(entry.name, ".md");
		const repositoryValue = body.match(/<!--\s*repository:\s*([a-z-]+)\s*-->/iu)?.[1] ?? "records";
		if (repositoryValue !== "records" && repositoryValue !== "hostelhawk") throw new Error(`Unsupported repository '${repositoryValue}' in ${path}`);
		const id = basename(entry.name, ".md").replace(/^\d+-/u, "");
		const prompt = `${body}\n${COMMON_PROTOCOL}`;
		scenarios.push({ id, title, repository: repositoryValue, path, prompt, promptHash: hashText(prompt), promptLength: prompt.length });
	}
	if (!scenarios.length) throw new Error("No scenario markdown files found");
	const selected = selectedIds ? scenarios.filter(scenario => selectedIds.includes(scenario.id)) : scenarios;
	const missing = selectedIds?.filter(id => !scenarios.some(scenario => scenario.id === id)) ?? [];
	if (missing.length) throw new Error(`Unknown scenario ID(s): ${missing.join(", ")}`);
	if (!selected.length) throw new Error("No scenarios selected");
	return selected;
}

function hashText(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

async function setupDependencies(repo: string, skipInstall: boolean): Promise<void> {
	if (skipInstall || await exists(join(repo, "node_modules")) || await exists(join(repo, "web", "node_modules"))) return;
	const packageRoot = await exists(join(repo, "package.json")) ? repo : await exists(join(repo, "web", "package.json")) ? join(repo, "web") : undefined;
	if (!packageRoot) return;
	const packageManager = await exists(join(packageRoot, "pnpm-lock.yaml")) || await exists(join(repo, "pnpm-lock.yaml")) ? "pnpm" : await exists(join(packageRoot, "package-lock.json")) ? "npm" : "yarn";
	const args = packageManager === "npm" ? ["ci"] : packageManager === "pnpm" ? ["install", "--frozen-lockfile"] : ["install", "--frozen-lockfile"];
	console.log(`Installing dependencies once with ${packageManager} ${args.join(" ")}...`);
	const result = await runProcess(packageManager, args, packageRoot, process.env, 30 * 60 * 1000);
	if (result.timedOut || result.exitCode !== 0) throw new Error(`Dependency setup failed (${packageManager} exit ${result.exitCode ?? "null"})`);
}

async function prepareWorktree(repo: string, baseline: string, worktree: string): Promise<void> {
	if (await exists(worktree)) {
		await git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
		await rm(worktree, { recursive: true, force: true });
	}
	await mkdir(dirname(worktree), { recursive: true });
	await git(repo, ["worktree", "add", "--detach", worktree, baseline]);
	const dependencies = join(repo, "node_modules");
	if (await exists(dependencies) && !(await exists(join(worktree, "node_modules")))) await symlink(dependencies, join(worktree, "node_modules"), "dir");
	const webDependencies = join(repo, "web", "node_modules");
	if (await exists(webDependencies) && !(await exists(join(worktree, "web", "node_modules")))) await symlink(webDependencies, join(worktree, "web", "node_modules"), "dir");
	for (const name of [".env", ".env.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local"]) {
		const source = join(repo, name);
		const destination = join(worktree, name);
		if (await exists(source) && !(await exists(destination))) await symlink(source, destination);
	}
	for (const name of [".env", ".env.local", ".env.test"]) {
		const source = join(repo, "web", name);
		const destination = join(worktree, "web", name);
		if (await exists(source) && !(await exists(destination))) await symlink(source, destination);
	}
}

function extensionPaths(notesPresent: boolean): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const required = [
		join(agentDir, "dev", "pi-goal-local", "src", "index.ts"),
		join(agentDir, "dev", "pi-plan-mode", "index.ts"),
		join(agentDir, "dev", "rpiv-mono", "packages", "rpiv-todo", "index.ts"),
		join(agentDir, "dev", "pi-subagents-local", "src", "index.ts"),
		join(agentDir, "extensions", "local-mode", "index.ts"),
	];
	if (notesPresent) required.push(join(agentDir, "dev", "pi-notes", "entry.ts"));
	required.push(join(PACKAGE_DIR, "entry.ts"));
	const optional = [
		join(agentDir, "npm", "node_modules", "pi-lens", "dist", "index.js"),
		join(agentDir, "npm", "node_modules", "pi-rtk-rewrite", "extensions", "rtk-rewrite.ts"),
	];
	return [...required, ...optional.filter(path => existsSync(path))];
}

async function assertExtensionPaths(paths: string[]): Promise<void> {
	const missing: string[] = [];
	for (const path of paths) if (!(await exists(path))) missing.push(path);
	if (missing.length) throw new Error(`Required Pi extension path(s) missing:\n${missing.join("\n")}`);
}

function piArgs(options: CliOptions, scenario: Scenario, arm: Arm, sessionDir: string): string[] {
	const extensions = extensionPaths(arm === "notes-present");
	return [
		"--approve",
		"--offline",
		"--no-extensions",
		...extensions.flatMap(path => ["--extension", path]),
		"--provider", options.provider,
		"--model", options.model,
		"--thinking", options.thinking,
		"--session-dir", sessionDir,
		"--name", `eval-${scenario.id}-${arm}`,
		"--mode", "json",
		"--print",
		"--",
		scenario.prompt,
	];
}

function compactValue(value: unknown, maxLength = 300): string {
	let text: string;
	try { text = typeof value === "string" ? value : JSON.stringify(value); } catch { text = String(value); }
	text = text.replace(/\s+/gu, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export class LiveActivity {
	private readonly startedAt = Date.now();
	private turns = 0;
	private tools = 0;
	private toolErrors = 0;
	private textChars = 0;
	private thinkingChars = 0;
	private compactions = 0;
	private lastEvent = "starting";
	private repeatedToolCalls = 0;
	private postCompactionRediscoveries = 0;
	private maxConsecutiveSameTool = 0;
	private consecutiveSameTool = 0;
	private lastTool = "";
	private firstToolMs: number | null = null;
	private firstMutationMs: number | null = null;
	private firstVerificationMs: number | null = null;
	private readonly toolSignatures = new Set<string>();
	private afterCompaction = false;

	constructor(private readonly label: string, private readonly output: (line: string) => void = console.log) {}

	consumeLine(line: string): void {
		let event: Record<string, unknown>;
		try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
		const type = typeof event.type === "string" ? event.type : "unknown";
		if (type === "turn_start") {
			this.turns += 1;
			this.lastEvent = `turn ${this.turns}`;
			this.emit(`turn ${this.turns} started`);
			return;
		}
		if (type === "tool_execution_start") {
			this.tools += 1;
			const tool = String(event.toolName ?? "unknown");
			const args = compactValue(event.args, 10_000);
			const signature = hashText(`${tool}\0${args}`);
			if (this.toolSignatures.has(signature)) {
				this.repeatedToolCalls += 1;
				if (this.afterCompaction) this.postCompactionRediscoveries += 1;
			}
			this.toolSignatures.add(signature);
			this.consecutiveSameTool = tool === this.lastTool ? this.consecutiveSameTool + 1 : 1;
			this.lastTool = tool;
			this.maxConsecutiveSameTool = Math.max(this.maxConsecutiveSameTool, this.consecutiveSameTool);
			const elapsed = Date.now() - this.startedAt;
			this.firstToolMs ??= elapsed;
			if (/^(?:edit|write|apply_patch|ast_grep_replace)$/iu.test(tool)) this.firstMutationMs ??= elapsed;
			if (/(?:test|build|lint|typecheck|diagnostic)/iu.test(`${tool} ${args}`)) this.firstVerificationMs ??= elapsed;
			this.lastEvent = `running ${tool}`;
			this.emit(`→ ${tool} ${compactValue(event.args)}`);
			return;
		}
		if (type === "tool_execution_end") {
			const failed = event.isError === true;
			if (failed) this.toolErrors += 1;
			const tool = String(event.toolName ?? "unknown");
			this.lastEvent = `${tool} ${failed ? "failed" : "finished"}`;
			this.emit(`${failed ? "✗" : "✓"} ${tool}`);
			return;
		}
		if (type === "message_update") {
			const update = event.assistantMessageEvent && typeof event.assistantMessageEvent === "object" ? event.assistantMessageEvent as Record<string, unknown> : {};
			const deltaLength = typeof update.delta === "string" ? update.delta.length : 0;
			if (update.type === "thinking_delta") this.thinkingChars += deltaLength;
			if (update.type === "text_delta") this.textChars += deltaLength;
			if (update.type === "toolcall_start") this.lastEvent = `preparing ${String(update.toolName ?? "tool")}`;
			return;
		}
		if (type === "compaction_start") {
			this.compactions += 1;
			this.afterCompaction = true;
			this.lastEvent = "compacting context";
			this.emit(`context compaction ${this.compactions} started`);
			return;
		}
		if (type === "compaction_end") {
			this.lastEvent = "compaction complete";
			this.emit(`context compaction ${this.compactions} completed`);
			return;
		}
		if (type === "agent_end") {
			this.lastEvent = "agent ended";
			this.emit("agent ended");
		}
	}

	heartbeat(): void {
		this.emit(`alive ${this.elapsed()} · turns=${this.turns} tools=${this.tools} errors=${this.toolErrors} repeats=${this.repeatedToolCalls} rediscovery=${this.postCompactionRediscoveries} thinking=${this.thinkingChars}ch response=${this.textChars}ch · ${this.lastEvent}`);
	}

	snapshot(): ActivitySnapshot {
		return {
			turns: this.turns,
			tools: this.tools,
			toolErrors: this.toolErrors,
			compactions: this.compactions,
			thinkingChars: this.thinkingChars,
			responseChars: this.textChars,
			repeatedToolCalls: this.repeatedToolCalls,
			postCompactionRediscoveries: this.postCompactionRediscoveries,
			maxConsecutiveSameTool: this.maxConsecutiveSameTool,
			firstToolMs: this.firstToolMs,
			firstMutationMs: this.firstMutationMs,
			firstVerificationMs: this.firstVerificationMs,
		};
	}

	private elapsed(): string {
		const seconds = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
		return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	}

	private emit(message: string): void {
		this.output(`[${this.label}] ${message}`);
	}
}

async function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, options: RunProcessOptions = {}): Promise<ProcessResult> {
	const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const stdoutFile = options.stdoutPath ? createWriteStream(options.stdoutPath, { flags: "a" }) : undefined;
	const stderrFile = options.stderrPath ? createWriteStream(options.stderrPath, { flags: "a" }) : undefined;
	if (stdoutFile) child.stdout.pipe(stdoutFile);
	if (stderrFile) child.stderr.pipe(stderrFile);
	const lines = createInterface({ input: child.stdout });
	lines.on("line", line => options.onStdoutLine ? options.onStdoutLine(line) : console.log(line));
	child.stderr.on("data", chunk => process.stderr.write(chunk));
	return new Promise(resolveResult => {
		let timedOut = false;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		let forceTimer: NodeJS.Timeout | undefined;
		const heartbeatTimer = options.heartbeat ? setInterval(options.heartbeat, 30_000) : undefined;
		const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (!timedOut && forceTimer) clearTimeout(forceTimer);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			resolveResult({ exitCode, signal, timedOut });
		};
		child.once("error", () => finish(null, null));
		child.once("close", (exitCode, signal) => finish(exitCode, signal));
		timer = setTimeout(() => {
			timedOut = true;
			const processGroup = child.pid;
			if (processGroup) {
				try { process.kill(-processGroup, "SIGTERM"); } catch { /* already exited */ }
			}
			forceTimer = setTimeout(() => {
				if (!processGroup) return;
				try { process.kill(-processGroup, "SIGKILL"); } catch { /* process group already exited */ }
			}, 10_000).unref();
		}, timeoutMs);
	});
}

async function listFiles(root: string, maxDepth: number, depth = 0): Promise<string[]> {
	if (depth > maxDepth) return [];
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const files: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...await listFiles(path, maxDepth, depth + 1));
		else files.push(path);
	}
	return files;
}

async function findEvalManifest(sessionDir: string): Promise<{ path: string; manifest: EvalManifestLike } | undefined> {
	const prefix = `${resolve(sessionDir)}${process.platform === "win32" ? "\\" : "/"}`;
	for (const path of await listFiles(DEFAULT_EVAL_ROOT, 5)) {
		if (!path.endsWith("manifest.json")) continue;
		try {
			const manifest = JSON.parse(await readFile(path, "utf8")) as EvalManifestLike;
			if (manifest.kind === "run-manifest" && typeof manifest.sessionFile === "string" && (resolve(manifest.sessionFile) === resolve(sessionDir) || resolve(manifest.sessionFile).startsWith(prefix))) return { path, manifest };
		} catch {
			// Ignore partial manifests.
		}
	}
	return undefined;
}

async function loadHarness(harnessId: string): Promise<{ path: string; manifest: HarnessManifest }> {
	const path = join(DEFAULT_EVAL_ROOT, "harness", harnessId, "harness.json");
	const manifest = JSON.parse(await readFile(path, "utf8")) as HarnessManifest;
	if (manifest.kind !== "pi-eval-harness" || manifest.schemaVersion !== HARNESS_SCHEMA_VERSION) throw new Error(`Unsupported harness manifest: ${path}`);
	return { path, manifest };
}

async function persistHarness(path: string, manifest: HarnessManifest): Promise<void> {
	manifest.updatedAt = new Date().toISOString();
	await writeJsonAtomically(path, manifest);
}

async function createHarness(options: CliOptions, repositories: HarnessManifest["repositories"], scenarios: Scenario[]): Promise<{ path: string; manifest: HarnessManifest }> {
	const harnessId = `harness-${Date.now()}-${randomUUID().slice(0, 8)}`;
	const directory = join(DEFAULT_EVAL_ROOT, "harness", harnessId);
	const now = new Date().toISOString();
	const manifest: HarnessManifest = {
		schemaVersion: HARNESS_SCHEMA_VERSION,
		kind: "pi-eval-harness",
		harnessId,
		createdAt: now,
		updatedAt: now,
		status: "running",
		repositories,
		provider: options.provider,
		model: options.model,
		thinking: options.thinking,
		timeoutMs: options.timeoutMs,
		scenarios: scenarios.map(scenario => ({ id: scenario.id, title: scenario.title, repository: scenario.repository, promptHash: scenario.promptHash, promptLength: scenario.promptLength })),
		runs: scenarios.flatMap(scenario => (["notes-absent", "notes-present"] as Arm[]).map(arm => ({
			scenarioId: scenario.id,
			repository: scenario.repository,
			arm,
			status: "pending" as const,
			worktree: join(repositories[scenario.repository].path, ".worktrees", "pi-eval-harness", harnessId, scenario.id, arm),
			sessionDir: join(directory, "sessions", scenario.id, arm),
		}))),
	};
	const path = join(directory, "harness.json");
	await persistHarness(path, manifest);
	return { path, manifest };
}

function runFor(manifest: HarnessManifest, scenarioId: string, arm: Arm): HarnessRun {
	const run = manifest.runs.find(item => item.scenarioId === scenarioId && item.arm === arm);
	if (!run) throw new Error(`Missing harness run record for ${scenarioId}/${arm}`);
	return run;
}

async function runScenarioArm(options: CliOptions, manifestPath: string, manifest: HarnessManifest, scenario: Scenario, arm: Arm): Promise<void> {
	const run = runFor(manifest, scenario.id, arm);
	if (run.status === "completed") return;
	run.status = "running";
	run.startedAt = new Date().toISOString();
	await persistHarness(manifestPath, manifest);
	let result: ProcessResult = { exitCode: null, signal: null, timedOut: false };
	let activity: LiveActivity | undefined;
	try {
		const repository = manifest.repositories[run.repository];
		await assertExtensionPaths(extensionPaths(arm === "notes-present"));
		await prepareWorktree(repository.path, repository.baselineCommit, run.worktree);
		await mkdir(run.sessionDir, { recursive: true });
		run.stdoutPath = join(run.sessionDir, "activity.jsonl");
		run.stderrPath = join(run.sessionDir, "stderr.log");
		const label = `${scenario.id}/${arm}`;
		activity = new LiveActivity(label);
		console.log(`\n[${label}] starting in ${run.repository} worktree ${run.worktree}`);
		console.log(`[${label}] raw JSON: ${run.stdoutPath}`);
		result = await runProcess(
			options.piBin,
			piArgs(options, scenario, arm, run.sessionDir),
			run.worktree,
			{ ...process.env, PI_OFFLINE: "1" },
			manifest.timeoutMs,
			{ stdoutPath: run.stdoutPath, stderrPath: run.stderrPath, onStdoutLine: line => activity?.consumeLine(line), heartbeat: () => activity?.heartbeat() },
		);
		run.activity = activity.snapshot();
		run.worktreeDirty = (await git(run.worktree, ["status", "--porcelain"]).catch(() => "")).length > 0;
		const evalManifest = await findEvalManifest(run.sessionDir);
		if (evalManifest) {
			run.evalRunId = evalManifest.manifest.runId;
			run.experimentKey = evalManifest.manifest.experimentKey;
			run.evalManifestPath = evalManifest.path;
			run.sessionFile = evalManifest.manifest.sessionFile;
		}
		run.status = result.exitCode === 0 && !result.timedOut && Boolean(evalManifest) ? "completed" : "failed";
	} catch (error) {
		console.error(`[${scenario.id}] ${arm} setup/run failed: ${error instanceof Error ? error.message : String(error)}`);
		run.status = "failed";
	} finally {
		run.exitCode = result.exitCode;
		run.signal = result.signal;
		run.timedOut = result.timedOut;
		run.activity ??= activity?.snapshot();
		run.endedAt = new Date().toISOString();
		if (options.cleanupWorktrees && await exists(run.worktree)) {
			await git(manifest.repositories[run.repository].path, ["worktree", "remove", "--force", run.worktree]).catch(() => undefined);
			await rm(run.worktree, { recursive: true, force: true });
		}
		await persistHarness(manifestPath, manifest);
		console.log(`[${scenario.id}] ${arm} ${run.status} (exit=${result.exitCode ?? "null"}${result.timedOut ? ", timed out" : ""})`);
	}
}

async function writeScenarioReport(manifest: HarnessManifest, scenario: Scenario): Promise<EvalReport | undefined> {
	const records = manifest.runs.filter(run => run.scenarioId === scenario.id && run.evalRunId && run.experimentKey);
	if (!records.length) return undefined;
	const experimentKey = records[0].experimentKey!;
	const report = await buildReport(DEFAULT_EVAL_ROOT, new Date(), { experimentKey, runIds: records.map(run => run.evalRunId!) });
	const paths = await writeReport(report, DEFAULT_EVAL_ROOT);
	for (const record of records) record.reportJson = paths.json;
	return report;
}

function renderHarnessSummary(manifest: HarnessManifest, reports: Array<{ scenario: Scenario; report?: EvalReport }>): string {
	const lines = [
		"# Pi long-horizon evaluation harness",
		"",
		`Harness: ${manifest.harnessId}`,
		`Records: ${manifest.repositories.records.path} @ ${manifest.repositories.records.baselineCommit}`,
		`HostelHawk: ${manifest.repositories.hostelhawk.path} @ ${manifest.repositories.hostelhawk.baselineCommit}`,
		`Model: ${manifest.provider}/${manifest.model} (${manifest.thinking})`,
		"",
		"Runs are sequential: Notes-absent first, then Notes-present. Pair deltas are Notes-present minus Notes-absent. See each JSON report for bounded post-compaction trace excerpts and the raw sessionFile links.",
	];
	for (const { scenario, report } of reports) {
		lines.push("", `## ${scenario.title}`, "", `Scenario: \`${scenario.id}\` (${scenario.repository})`);
		const scenarioRuns = manifest.runs.filter(run => run.scenarioId === scenario.id);
		const reportPath = scenarioRuns.find(run => run.reportJson)?.reportJson;
		lines.push(`Report JSON: ${reportPath ? `[${reportPath}](file://${reportPath})` : "not generated"}`);
		lines.push(`Evaluator manifests: ${scenarioRuns.map(run => run.evalManifestPath ? `[${run.evalManifestPath}](file://${run.evalManifestPath})` : "not found").join(", ")}`);
		for (const run of scenarioRuns) {
			lines.push(`- ${run.arm} session: ${run.sessionFile ? `[${run.sessionFile}](file://${run.sessionFile})` : "not found"}`);
			lines.push(`  - raw activity: ${run.stdoutPath ? `[${run.stdoutPath}](file://${run.stdoutPath})` : "not found"}`);
			lines.push(`  - stderr: ${run.stderrPath ? `[${run.stderrPath}](file://${run.stderrPath})` : "not found"}`);
		}
		if (!report) {
			lines.push("No evaluator manifests were found for this scenario.");
			continue;
		}
		lines.push(`Rows: ${report.rows.length}; pairs: ${report.pairs.length}; excluded: ${report.excluded.length}`);
		for (const pair of report.pairs) lines.push(`- ${pair.strategy}: Notes-present r${pair.notesPresentReplicate} vs Notes-absent r${pair.notesAbsentReplicate}; elapsed Δ ${pair.elapsedMs ?? "n/a"}ms; requests Δ ${pair.providerRequests}; tools Δ ${pair.toolCalls}`);
		for (const row of report.rows) {
			const traceCount = row.postCompactionTraces.length;
			lines.push(`- ${row.variant} r${row.replicate}: ${row.providerRequests} requests, ${row.toolCalls} tools, ${row.compactionSuccesses} successful compactions, ${traceCount} post-compaction traces, completion signal ${row.completionSignal ? "yes" : "no"}`);
		}
		for (const run of scenarioRuns) {
			if (!run.activity) continue;
			lines.push(`- ${run.arm} live metrics: ${run.activity.turns} turns, ${run.activity.tools} tools, ${run.activity.toolErrors} tool errors, ${run.activity.repeatedToolCalls} repeated calls, ${run.activity.postCompactionRediscoveries} post-compaction rediscoveries; first tool/mutation/verification ${run.activity.firstToolMs ?? "n/a"}/${run.activity.firstMutationMs ?? "n/a"}/${run.activity.firstVerificationMs ?? "n/a"}ms`);
		}
	}
	return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options.resume) {
		const loaded = await loadHarness(options.resume);
		const scenarios = await loadScenarios(loaded.manifest.scenarios.map(scenario => scenario.id));
		if (options.repo || options.hostelhawkRepo || options.baseline || options.hostelhawkBaseline || options.provider !== DEFAULT_PROVIDER || options.model !== DEFAULT_MODEL || options.thinking !== DEFAULT_THINKING) console.warn("Resume uses the original harness repositories, baselines, model, and thinking configuration.");
		await executeHarness({ ...options, provider: loaded.manifest.provider, model: loaded.manifest.model, thinking: loaded.manifest.thinking }, loaded.path, loaded.manifest, scenarios);
		return;
	}
	const scenarios = await loadScenarios(options.scenarioIds);
	const records = await resolveRepository(options.repo, [process.env.PI_EVAL_REPO ?? "", "/private/tmp/records-dd-eval", process.cwd()]);
	const hostelhawk = await resolveRepository(options.hostelhawkRepo, [process.env.PI_EVAL_HOSTELHAWK_REPO ?? "", join(homedir(), "hostelhawk")]);
	const repositories: HarnessManifest["repositories"] = {
		records: {
			path: records,
			baselineCommit: options.baseline ?? await git(records, ["rev-parse", "HEAD"]),
			sourceDirty: (await git(records, ["status", "--porcelain"])).length > 0,
		},
		hostelhawk: {
			path: hostelhawk,
			baselineCommit: options.hostelhawkBaseline ?? await git(hostelhawk, ["rev-parse", "HEAD"]),
			sourceDirty: (await git(hostelhawk, ["status", "--porcelain"])).length > 0,
		},
	};
	for (const [key, repository] of Object.entries(repositories)) {
		if (repository.sourceDirty) console.warn(`${key} repository has local changes; runs use clean detached worktrees from ${repository.baselineCommit} and will not copy those changes.`);
	}
	const requiredPaths = [...extensionPaths(false), ...extensionPaths(true)];
	await assertExtensionPaths([...new Set(requiredPaths)]);
	if (options.dryRun) {
		console.log(`Dry run: ${scenarios.length} scenarios × 2 arms`);
		for (const [key, repository] of Object.entries(repositories)) console.log(`${key}: ${repository.path} @ ${repository.baselineCommit}`);
		for (const scenario of scenarios) console.log(`- ${scenario.id} [${scenario.repository}]: notes-absent → notes-present`);
		return;
	}
	for (const key of new Set(scenarios.map(scenario => scenario.repository))) await setupDependencies(repositories[key].path, options.skipInstall);
	const created = await createHarness(options, repositories, scenarios);
	console.log(`Harness ${created.manifest.harnessId}: ${scenarios.length} scenarios × 2 arms`);
	for (const [key, repository] of Object.entries(repositories)) console.log(`${key}: ${repository.path} @ ${repository.baselineCommit}`);
	await executeHarness(options, created.path, created.manifest, scenarios);
}

async function executeHarness(options: CliOptions, manifestPath: string, manifest: HarnessManifest, scenarios: Scenario[]): Promise<void> {
	for (const scenario of scenarios) {
		await runScenarioArm(options, manifestPath, manifest, scenario, "notes-absent");
		await runScenarioArm(options, manifestPath, manifest, scenario, "notes-present");
	}
	const reports: Array<{ scenario: Scenario; report?: EvalReport }> = [];
	for (const scenario of scenarios) reports.push({ scenario, report: await writeScenarioReport(manifest, scenario) });
	manifest.status = manifest.runs.every(run => run.status === "completed") ? "completed" : "partial";
	await persistHarness(manifestPath, manifest);
	const harnessDir = dirname(manifestPath);
	const summary = renderHarnessSummary(manifest, reports);
	await writeTextAtomically(join(harnessDir, "summary.md"), summary);
	await writeJsonAtomically(join(harnessDir, "summary.json"), {
		harnessId: manifest.harnessId,
		status: manifest.status,
		manifest: manifestPath,
		scenarios: reports.map(({ scenario, report }) => ({
			id: scenario.id,
			title: scenario.title,
			report: report ? { experimentKey: report.experimentKey, rows: report.rows.length, pairs: report.pairs.length, excluded: report.excluded.length } : null,
		})),
	});
	console.log(`\nHarness ${manifest.harnessId} ${manifest.status}`);
	console.log(`Summary: ${join(harnessDir, "summary.md")}`);
}

if (process.argv[1]?.endsWith("harness.ts")) {
	void main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
