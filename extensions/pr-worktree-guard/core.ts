import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export type PullRequestRef = {
	url: string;
	owner: string;
	repository: string;
	number: number;
};

export type WorktreeRecord = {
	path: string;
	head: string;
	branch: string | undefined;
	detached: boolean;
	bare: boolean;
	prunable: boolean;
};

export type WorktreeMatchInput = {
	primaryPath: string;
	headBranch: string;
	headSha: string;
};

export type WorktreeSelection =
	| { kind: "match"; reason: "branch" | "sha"; worktree: WorktreeRecord }
	| { kind: "none"; reason: "no matching worktree" }
	| { kind: "ambiguous"; paths: string[]; reason: "branch" | "sha" };

export type PathRewriteOptions = {
	sourceRoot: string;
	targetRoot: string;
	linkedRoots: string[];
	allowOutside: boolean;
	workingDirectory?: string;
	remapOtherLinkedRoots?: boolean;
	preserveExternalAbsolute?: boolean;
	globalSkillRoot?: string;
};

const GITHUB_PR_URL_PATTERN = /https?:\/\/github\.com\/([^/\s"'<>]+)\/([^/\s"'<>]+)\/pull\/(\d+)/gi;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=(?:[^\s]|\s*$)/;
const CUSTOM_TOOLS_WITH_CWD = new Set(["ctx_execute", "ctx_batch_execute"]);
const UNSUPPORTED_SHELL_COMMANDS = new Set([
	"bash",
	"builtin",
	"case",
	"cmd",
	"command",
	"env",
	"eval",
	"exec",
	"for",
	"function",
	"if",
	"powershell",
	"pwsh",
	"sh",
	"sudo",
	"until",
	"while",
	"zsh",
]);

export function canonicalRepositoryPath(path: string): string {
	const resolved = normalize(resolve(path));
	let existing = resolved;
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return resolved;
		existing = parent;
	}

	try {
		const realExisting = normalize(realpathSync(existing));
		return normalize(join(realExisting, relative(existing, resolved)));
	} catch {
		return resolved;
	}
}

export function extractPullRequestUrls(text: string): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(GITHUB_PR_URL_PATTERN)) {
		const [, owner, repository, number] = match;
		if (!owner || !repository || !number) continue;
		const url = `https://github.com/${owner}/${repository}/pull/${number}`;
		if (seen.has(url)) continue;
		seen.add(url);
		urls.push(url);
	}
	return urls;
}

export function parsePullRequestUrl(value: string): PullRequestRef | undefined {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}

	if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") {
		return undefined;
	}

	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[2]?.toLowerCase() !== "pull" || !/^\d+$/.test(parts[3] ?? "")) {
		return undefined;
	}

	const owner = parts[0];
	const repository = parts[1];
	const number = Number(parts[3]);
	if (!owner || !repository || !Number.isSafeInteger(number) || number <= 0) return undefined;

	return {
		url: `https://github.com/${owner}/${repository}/pull/${number}`,
		owner,
		repository,
		number,
	};
}

export function parseWorktreePorcelain(output: string): WorktreeRecord[] {
	const records: WorktreeRecord[] = [];
	for (const block of output.split(/\n\s*\n/)) {
		const values = new Map<string, string>();
		for (const line of block.split("\n")) {
			const separator = line.indexOf(" ");
			if (separator < 0) {
				values.set(line.trim(), "");
				continue;
			}
			values.set(line.slice(0, separator), line.slice(separator + 1).trim());
		}

		const path = values.get("worktree");
		if (!path) continue;
		records.push({
			path: canonicalRepositoryPath(path),
			head: values.get("HEAD") ?? "",
			branch: values.get("branch"),
			detached: values.has("detached"),
			bare: values.has("bare"),
			prunable: values.has("prunable"),
		});
	}
	return records;
}

function branchRef(branch: string): string {
	return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/**
 * Guard-created worktrees have both a stable branch prefix and a stable path
 * prefix. Keep these checks deliberately anchored: a PR number appearing in
 * the middle of an otherwise unrelated branch or path is not guard identity.
 */
export function isGuardWorktree(record: WorktreeRecord, prNumber: number): boolean {
	return (
		record.branch?.startsWith(`refs/heads/pr-guard/${prNumber}-`) === true ||
		basename(record.path).startsWith(`pr-${prNumber}-`)
	);
}

function isPrimary(record: WorktreeRecord, primaryPath: string): boolean {
	return canonicalRepositoryPath(record.path) === canonicalRepositoryPath(primaryPath);
}

function eligible(record: WorktreeRecord, primaryPath: string): boolean {
	return !record.bare && !record.prunable && !record.detached && !isPrimary(record, primaryPath);
}

function uniqueMatch(
	matches: readonly WorktreeRecord[],
	reason: "branch" | "sha",
): WorktreeSelection | undefined {
	if (matches.length > 1) return { kind: "ambiguous", reason, paths: matches.map((record) => record.path) };
	if (matches.length === 1) return { kind: "match", reason, worktree: matches[0] };
	return undefined;
}

export function selectMatchingWorktree(
	records: readonly WorktreeRecord[],
	input: WorktreeMatchInput,
): WorktreeSelection {
	const candidates = records.filter((record) => eligible(record, input.primaryPath));
	const expectedBranch = branchRef(input.headBranch);

	const branchMatch = uniqueMatch(
		candidates.filter((record) => record.branch === expectedBranch),
		"branch",
	);
	if (branchMatch) return branchMatch;

	const shaMatch = uniqueMatch(
		candidates.filter((record) => record.head.toLowerCase() === input.headSha.toLowerCase()),
		"sha",
	);
	if (shaMatch) return shaMatch;
	return { kind: "none", reason: "no matching worktree" };
}

type ShellSegment = {
	text: string;
	start: number;
	end: number;
};

function trimShellSegment(command: string, start: number, end: number): ShellSegment | undefined {
	while (start < end && /\s/.test(command[start] ?? "")) start += 1;
	while (end > start && /\s/.test(command[end - 1] ?? "")) end -= 1;
	return start < end ? { text: command.slice(start, end), start, end } : undefined;
}

function splitShellCommandParts(command: string): ShellSegment[] | undefined {
	if (!command.trim()) return undefined;
	const segments: ShellSegment[] = [];
	let start = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = quote === character ? undefined : quote ?? character;
			continue;
		}
		if (quote === "'") continue;
		if (
			character === "<" ||
			character === ">" ||
			character === "`" ||
			character === "(" ||
			character === ")" ||
			character === "{" ||
			character === "}" ||
			character === "%" ||
			character === "$"
		) {
			return undefined;
		}
		if (quote) continue;
		if (character === "&" && command[index + 1] !== "&") return undefined;
		if (character === ";" || character === "\n" || character === "\r" || character === "|" || character === "&") {
			const segment = trimShellSegment(command, start, index);
			if (segment) segments.push(segment);
			if ((character === "|" || character === "&") && command[index + 1] === character) index += 1;
			start = index + 1;
		}
	}
	if (quote || escaped) return undefined;
	const finalSegment = trimShellSegment(command, start, command.length);
	if (finalSegment) segments.push(finalSegment);
	return segments.length > 0 ? segments : undefined;
}

function splitShellCommands(command: string): string[] | undefined {
	return splitShellCommandParts(command)?.map((segment) => segment.text);
}

function commandWords(command: string): string[] | undefined {
	const words = literalShellWords(command);
	if (!words || words.some((word) => word.escaped || word.dynamic)) return undefined;
	return words.map((word) => word.value);
}

type ShellWord = {
	raw: string;
	value: string;
	quoted: boolean;
	escaped: boolean;
	dynamic: boolean;
};

/**
 * Parse just enough shell syntax for the deliberately narrow bash-script
 * allowance. A word is accepted only when it is a single literal (possibly
 * quoted) token; shell expansion and composition are retained as rejection
 * signals instead of being interpreted.
 */
function literalShellWords(command: string): ShellWord[] | undefined {
	const words: ShellWord[] = [];
	let index = 0;
	while (index < command.length) {
		while (index < command.length && /\s/.test(command[index] ?? "")) index += 1;
		if (index >= command.length) break;

		const start = index;
		let value = "";
		let quoted = false;
		let escaped = false;
		let dynamic = false;
		let quote: "'" | '"' | undefined;
		while (index < command.length) {
			const character = command[index] ?? "";
			if (!quote && /\s/.test(character)) break;
			if (quote === "'") {
				if (character === "'") {
					quote = undefined;
					index += 1;
					continue;
				}
				value += character;
				index += 1;
				continue;
			}
			if (quote === '"') {
				if (character === '"') {
					quote = undefined;
					index += 1;
					continue;
				}
				if (character === "\\") {
					const next = command[index + 1];
					if (next === undefined) return undefined;
					escaped = true;
					index += 2;
					value += next;
					continue;
				}
				if (character === "$" || character === "`") dynamic = true;
				value += character;
				index += 1;
				continue;
			}

			if (character === "'") {
				quoted = true;
				quote = "'";
				index += 1;
				continue;
			}
			if (character === '"') {
				quoted = true;
				quote = '"';
				index += 1;
				continue;
			}
			if (character === "\\") {
				const next = command[index + 1];
				if (next === undefined) return undefined;
				escaped = true;
				index += 2;
				value += next;
				continue;
			}
			if (character === "$" || character === "`" || character === "(" || character === ")" || character === "{" || character === "}") {
				dynamic = true;
				index += 1;
				value += character;
				continue;
			}
			if (character === "*" || character === "?" || character === "[") dynamic = true;
			if (character === "<" || character === ">" || character === ";" || character === "|" || character === "&") {
				return undefined;
			}
			value += character;
			index += 1;
		}
		if (quote) return undefined;
		if (index === start) return undefined;
		words.push({ raw: command.slice(start, index), value, quoted, escaped, dynamic });
	}
	return words.length > 0 ? words : undefined;
}

function isLiteralScriptWord(word: ShellWord | undefined, allowShellQuoteEscape = false): word is ShellWord {
	if (!word || !word.value || word.dynamic) return false;
	if (!word.escaped) return true;
	return allowShellQuoteEscape && shellQuote(word.value) === word.raw;
}

function isBashInterpreter(word: ShellWord | undefined): word is ShellWord {
	return word !== undefined && !word.quoted && !word.escaped && !word.dynamic && basename(word.value) === "bash";
}

function isLexicallyWithin(root: string, candidate: string): boolean {
	const relativePath = relative(canonicalRepositoryPath(root), canonicalRepositoryPath(candidate));
	return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function isAllowedBashSyntaxCheck(segment: string, allowedDirectory: string | undefined): boolean {
	if (!allowedDirectory) return false;
	const words = literalShellWords(segment);
	if (!words || words.length < 3 || !isBashInterpreter(words[0]) || words[1]?.value !== "-n") return false;
	return words.slice(2).every(
		(word) => isLiteralScriptWord(word, true) && isAbsolute(word.value) && isLexicallyWithin(allowedDirectory, word.value),
	);
}

function stripEnvironment(words: string[]): string[] {
	let index = 0;
	while (index < words.length && ENV_ASSIGNMENT_PATTERN.test(words[index] ?? "")) index += 1;
	return words.slice(index);
}

export function isRemoteInspectionCommand(command: string): boolean {
	const segments = splitShellCommands(command);
	if (!segments || segments.length !== 1) return false;
	const words = commandWords(segments[0]);
	if (!words) return false;
	const args = stripEnvironment(words);
	if (args[0] !== "gh") return false;

	if (args[1] === "pr") return args[2] === "view" || args[2] === "checks" || args[2] === "diff";
	if (args[1] === "run") return args[2] === "view" || args[2] === "list";
	if (args[1] !== "api") return false;

	const mutationFlags = [
		"--method",
		"-X",
		"--input",
		"--input-file",
		"--raw-field",
		"-f",
		"--field",
		"-H",
		"--header",
	];
	return !args.slice(2).some((arg) =>
		mutationFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`) || (flag.length === 2 && arg.startsWith(flag) && arg.length > 2)),
	);
}

function isGitExecutable(word: string): boolean {
	return word === "git" || word.endsWith("/git");
}

function gitSubcommandPosition(words: readonly string[], start: number): number | undefined {
	let index = start + 1;
	while (index < words.length) {
		const word = words[index];
		if (!word) return undefined;
		if (
			word === "-C" ||
			word === "-c" ||
			word === "--git-dir" ||
			word === "--work-tree" ||
			word === "--exec-path" ||
			word === "--config-env" ||
			word === "--namespace"
		) {
			index += 2;
			continue;
		}
		if (
			word === "--no-pager" ||
			word === "--no-optional-locks" ||
			word === "--literal-pathspecs" ||
			word === "--glob-pathspecs" ||
			word === "--noglob-pathspecs" ||
			word.startsWith("--git-dir=") ||
			word.startsWith("--work-tree=") ||
			word.startsWith("--exec-path=") ||
			word.startsWith("--config-env=") ||
			word.startsWith("-C") ||
			word.startsWith("-c")
		) {
			index += 1;
			continue;
		}
		return index;
	}
	return undefined;
}

function gitSubcommand(words: readonly string[], start: number): string | undefined {
	const position = gitSubcommandPosition(words, start);
	return position === undefined ? undefined : words[position];
}

function hasUnsafeGitRepositoryOverride(
	words: readonly string[],
	start: number,
	allowedDirectory: string | undefined,
	allowPathOverride: boolean,
): boolean {
	let index = start + 1;
	while (index < words.length) {
		const word = words[index];
		if (!word) return false;
		if (word === "-C") {
			const path = words[index + 1];
			if (!allowPathOverride || !path || !allowedDirectory || !isWithin(allowedDirectory, path)) return true;
			index += 2;
			continue;
		}
		if (word.startsWith("-C") && word.length > 2) {
			if (!allowPathOverride || !allowedDirectory || !isWithin(allowedDirectory, word.slice(2))) return true;
			index += 1;
			continue;
		}
		if (
			word === "-c" ||
			word === "--git-dir" ||
			word === "--work-tree" ||
			word === "--exec-path" ||
			word === "--config-env" ||
			word === "--namespace" ||
			word.startsWith("-c") ||
			word.startsWith("--git-dir=") ||
			word.startsWith("--work-tree=") ||
			word.startsWith("--exec-path=") ||
			word.startsWith("--config-env=")
		) {
			return true;
		}
		if (!word.startsWith("-")) return false;
		index += 1;
	}
	return false;
}

function isGhPullRequestCheckout(words: readonly string[], start: number): boolean {
	for (let index = start + 1; index < words.length - 1; index += 1) {
		if (words[index] === "pr" && words[index + 1] === "checkout") return true;
	}
	return false;
}

function isAllowedDirectoryChange(words: readonly string[], allowedDirectory: string | undefined): boolean {
	if (!allowedDirectory) return false;
	const args = stripEnvironment([...words]);
	const command = args[0]?.toLowerCase();
	if (command === "cd" || command === "chdir" || command === "pushd") {
		const path = args[1] === "--" ? args[2] : args[1];
		return args.length === (args[1] === "--" ? 3 : 2) && path !== undefined && isWithin(allowedDirectory, path);
	}
	if (command === "set-location" || command === "sl") {
		const path = args[1]?.toLowerCase() === "-literalpath" || args[1]?.toLowerCase() === "-path" ? args[2] : args[1];
		const expectedLength = path === args[2] ? 3 : 2;
		return args.length === expectedLength && path !== undefined && isWithin(allowedDirectory, path);
	}
	return false;
}

function segmentHasForbiddenCommand(
	segment: string,
	allowedDirectory: string | undefined,
	allowDirectoryChange: boolean,
): boolean {
	const words = commandWords(segment);
	if (!words) return true;
	if (isAllowedBashSyntaxCheck(segment, allowedDirectory)) return false;
	const firstCommand = stripEnvironment(words)[0]?.toLowerCase();
	if (!firstCommand || UNSUPPORTED_SHELL_COMMANDS.has(firstCommand)) return true;
	if (
		firstCommand === "cd" ||
		firstCommand === "pushd" ||
		firstCommand === "popd" ||
		firstCommand === "chdir" ||
		firstCommand === "set-location" ||
		firstCommand === "sl"
	) {
		return !allowDirectoryChange || !isAllowedDirectoryChange(words, allowedDirectory);
	}
	for (let index = 0; index < words.length; index += 1) {
		if (isGitExecutable(words[index] ?? "")) {
			if (hasUnsafeGitRepositoryOverride(words, index, allowedDirectory, allowDirectoryChange)) return true;
			const subcommand = gitSubcommand(words, index);
			if (subcommand === "switch" || subcommand === "checkout" || subcommand === "reset" || subcommand === "clean") {
				return true;
			}
			if (subcommand === "worktree") {
				const position = gitSubcommandPosition(words, index);
				if (position === undefined || words[position + 1] !== "list") return true;
			}
		}
		if (words[index] === "gh" && isGhPullRequestCheckout(words, index)) return true;
	}
	return false;
}

export function isForbiddenCheckoutCommand(command: string, allowedDirectory?: string): boolean {
	const segments = splitShellCommands(command);
	return (
		!segments ||
		segments.some((segment, index) => segmentHasForbiddenCommand(segment, allowedDirectory, index === 0))
	);
}

function isWithin(root: string, candidate: string): boolean {
	const relativePath = relative(canonicalRepositoryPath(root), canonicalRepositoryPath(candidate));
	return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function findLinkedRoot(candidate: string, roots: readonly string[]): string | undefined {
	return [...roots]
		.map(canonicalRepositoryPath)
		.filter((root) => isWithin(root, candidate))
		.sort((left, right) => right.length - left.length)[0];
}

function globalSkillPath(rawPath: string, options: PathRewriteOptions): string | undefined {
	if (isAbsolute(rawPath)) return undefined;
	const normalized = rawPath.replaceAll("\\", "/");
	const globalRoot = options.globalSkillRoot ?? join(homedir(), ".agents", "skills");
	const globalRootCanonical = canonicalRepositoryPath(globalRoot);
	const resolvedInput = canonicalRepositoryPath(resolve(options.workingDirectory ?? options.sourceRoot, rawPath));
	if (existsSync(globalRoot) && /\/SKILL\.md$/.test(resolvedInput) && isWithin(globalRootCanonical, resolvedInput)) {
		return resolvedInput;
	}

	const relativeMatch = normalized.match(/^(?:\.\/)?(\.agents\/skills\/.+\/SKILL\.md)$/);
	const homeMatch = normalized.match(/^~\/(\.agents\/skills\/.+\/SKILL\.md)$/);
	if (!relativeMatch?.[1] && !homeMatch?.[1]) return undefined;

	const skillPath = relativeMatch?.[1] ?? homeMatch?.[1];
	if (!skillPath) return undefined;
	const globalCandidate = resolve(globalRoot, skillPath.replace(/^\.agents\/skills\//, ""));
	if (homeMatch?.[1]) return canonicalRepositoryPath(globalCandidate);

	const projectCandidates = [
		options.workingDirectory ?? options.sourceRoot,
		options.sourceRoot,
		options.targetRoot,
	].map((root) => resolve(root, skillPath));
	if (projectCandidates.some((candidate) => existsSync(candidate))) return undefined;

	return existsSync(globalCandidate) ? canonicalRepositoryPath(globalCandidate) : undefined;
}

export function rewriteRepositoryPath(rawPath: string, options: PathRewriteOptions): string {
	const sourceRoot = canonicalRepositoryPath(options.sourceRoot);
	const targetRoot = canonicalRepositoryPath(options.targetRoot);
	const workingDirectory = canonicalRepositoryPath(options.workingDirectory ?? sourceRoot);
	const absoluteInput = isAbsolute(rawPath);
	const globalPath = globalSkillPath(rawPath, options);
	if (globalPath) return globalPath;
	const candidate = canonicalRepositoryPath(absoluteInput ? rawPath : resolve(workingDirectory, rawPath));
	const workingRoot = findLinkedRoot(workingDirectory, options.linkedRoots);
	const linkedRoot = findLinkedRoot(candidate, options.linkedRoots);

	if (!absoluteInput && workingRoot && workingRoot !== sourceRoot && workingRoot !== targetRoot) {
		throw new Error(`relative path starts in another checkout: ${workingDirectory}`);
	}
	if (!absoluteInput && workingRoot === targetRoot && !isWithin(targetRoot, candidate)) {
		if (options.remapOtherLinkedRoots && linkedRoot) return join(targetRoot, relative(linkedRoot, candidate));
		throw new Error(`path escapes the locked worktree: ${candidate}`);
	}
	if (linkedRoot && linkedRoot !== targetRoot && linkedRoot !== sourceRoot) {
		if (options.remapOtherLinkedRoots) return join(targetRoot, relative(linkedRoot, candidate));
		throw new Error(`path points into another checkout: ${candidate}`);
	}
	if (linkedRoot === targetRoot) return candidate;
	if (!isWithin(sourceRoot, candidate)) {
		if (options.allowOutside) return candidate;
		if (options.preserveExternalAbsolute && absoluteInput) return rawPath;
		throw new Error(`path is outside the locked worktree: ${candidate}`);
	}

	return join(targetRoot, relative(sourceRoot, candidate));
}

function unquoteShellPath(value: string): string {
	if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
		return value.slice(1, -1);
	}
	return value;
}

function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function rewriteShellPath(value: string, options: PathRewriteOptions): string {
	return rewriteRepositoryPath(unquoteShellPath(value), {
		...options,
		allowOutside: false,
		workingDirectory: options.targetRoot,
		remapOtherLinkedRoots: true,
	});
}

function rewriteBashScriptPath(word: ShellWord | undefined, options: PathRewriteOptions, executable: boolean): string {
	if (!isLiteralScriptWord(word)) throw new Error("bash script path must be a literal token");
	if (word.value.startsWith("-")) throw new Error("bash script options are not allowed");

	const rewritten = rewriteShellPath(word.value, options);
	if (!isAbsolute(rewritten) || !isWithin(options.targetRoot, rewritten)) {
		throw new Error("bash script path escapes the locked worktree");
	}
	try {
		if (!statSync(rewritten).isFile()) throw new Error("bash script path is not a regular file");
		if (executable) accessSync(rewritten, constants.X_OK);
	} catch {
		throw new Error(executable ? "bash script must be an executable regular file" : "bash syntax-check path must be a regular file");
	}
	return rewritten;
}

function rewriteBashScriptSegment(segment: string, options: PathRewriteOptions, shell: "bash" | "powershell"): string | undefined {
	const words = literalShellWords(segment);
	if (!words || !isBashInterpreter(words[0])) return undefined;

	const quote = shell === "powershell" ? powershellQuote : shellQuote;
	if (words[1]?.value === "-n") {
		if (words.length < 3 || words[1].quoted || words[1].escaped || words[1].dynamic) {
			throw new Error("bash syntax check must use only the literal -n option");
		}
		const paths = words.slice(2).map((word) => quote(rewriteBashScriptPath(word, options, false)));
		return `bash -n ${paths.join(" ")}`;
	}
	if (words.length !== 2) throw new Error("bash direct execution accepts exactly one script path");
	return quote(rewriteBashScriptPath(words[1], options, true));
}

function hasPowerShellCallOperator(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = quote === character ? undefined : quote ?? character;
			continue;
		}
		if (!quote && character === "&") {
			if (command[index + 1] === "&") {
				index += 1;
				continue;
			}
			return true;
		}
	}
	return false;
}

function rewriteBashScripts(command: string, options: PathRewriteOptions, shell: "bash" | "powershell"): string {
	if (shell === "powershell" && hasPowerShellCallOperator(command)) return command;
	const segments = splitShellCommandParts(command);
	if (!segments) return command;
	let rewritten = command;
	for (const segment of [...segments].reverse()) {
		const replacement = rewriteBashScriptSegment(segment.text, options, shell);
		if (replacement === undefined || replacement === segment.text) continue;
		rewritten = `${rewritten.slice(0, segment.start)}${replacement}${rewritten.slice(segment.end)}`;
	}
	return rewritten;
}

export function rewriteShellCommand(
	command: string,
	options: PathRewriteOptions,
	shell: "bash" | "powershell",
): string {
	const quote = shell === "powershell" ? powershellQuote : shellQuote;
	const scriptRewritten = rewriteBashScripts(command, options, shell);
	const separator = String.raw`(^|(?:&&|\|\||;|\n)\s*)`;
	const pathToken = String.raw`("(?:\\.|[^"])*"|'[^']*'|[^\s;&|]+)`;
	const directoryPattern = new RegExp(
		`${separator}(cd|chdir|pushd|set-location|sl)\\s+(?:(?:--|-LiteralPath|-Path)(?:=|\\s+))?${pathToken}`,
		"gi",
	);
	const gitCwdPattern = new RegExp(`${separator}((?:[^\\s;&|]+/)?git)\\s+-C(?:\\s+)?${pathToken}`, "gi");

	const directoryRewritten = scriptRewritten.replace(directoryPattern, (match, prefix: string, executable: string, path: string) => {
		const rewritten = rewriteShellPath(path, options);
		const normalizedExecutable = shell === "powershell" && /^(set-location|sl)$/i.test(executable) ? "Set-Location -LiteralPath" : executable;
		return `${prefix}${normalizedExecutable} ${quote(rewritten)}`;
	});
	return directoryRewritten.replace(gitCwdPattern, (match, prefix: string, executable: string, path: string) => {
		const rewritten = rewriteShellPath(path, options);
		if (canonicalRepositoryPath(rewritten) === canonicalRepositoryPath(options.targetRoot)) return `${prefix}${executable}`;
		return `${prefix}${executable} -C ${quote(rewritten)}`;
	});
}

export function routeCustomToolWorkingDirectory(
	input: Record<string, unknown>,
	toolName: string,
	targetRoot: string,
): void {
	if (CUSTOM_TOOLS_WITH_CWD.has(toolName) && input.cwd === undefined) input.cwd = targetRoot;
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
