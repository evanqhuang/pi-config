import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalRepositoryPath } from "./core.ts";

const SETTINGS_VERSION = 1;

export type GuardSettings = {
	version: number;
	enabledRepositoryRoots: string[];
};

export const DEFAULT_SETTINGS_PATH = join(homedir(), ".pi", "agent", "pr-worktree-guard.json");

function defaultSettings(): GuardSettings {
	return { version: SETTINGS_VERSION, enabledRepositoryRoots: [] };
}

export function parseGuardSettings(content: string): GuardSettings {
	try {
		const value: unknown = JSON.parse(content);
		if (!value || typeof value !== "object" || Array.isArray(value)) return defaultSettings();
		const record = value as Record<string, unknown>;
		if (record.version !== SETTINGS_VERSION || !Array.isArray(record.enabledRepositoryRoots)) return defaultSettings();
		const enabledRepositoryRoots = [...new Set(
			record.enabledRepositoryRoots
				.filter((root): root is string => typeof root === "string" && root.trim().length > 0)
				.map((root) => canonicalRepositoryPath(root)),
		)].sort();
		return { version: SETTINGS_VERSION, enabledRepositoryRoots };
	} catch {
		return defaultSettings();
	}
}

export class RepositoryScopeStore {
	constructor(private readonly settingsPath = DEFAULT_SETTINGS_PATH) {}

	isEnabled(repositoryRoot: string): boolean {
		return this.read().enabledRepositoryRoots.includes(canonicalRepositoryPath(repositoryRoot));
	}

	setEnabled(repositoryRoot: string, enabled: boolean): void {
		const root = canonicalRepositoryPath(repositoryRoot);
		const settings = this.read();
		const roots = new Set(settings.enabledRepositoryRoots);
		if (enabled) roots.add(root);
		else roots.delete(root);
		this.write({ version: SETTINGS_VERSION, enabledRepositoryRoots: [...roots].sort() });
	}

	private read(): GuardSettings {
		try {
			return parseGuardSettings(readFileSync(this.settingsPath, "utf8"));
		} catch {
			return defaultSettings();
		}
	}

	private write(settings: GuardSettings): void {
		const directory = dirname(this.settingsPath);
		mkdirSync(directory, { recursive: true });
		const temporaryPath = `${this.settingsPath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		renameSync(temporaryPath, this.settingsPath);
	}
}
