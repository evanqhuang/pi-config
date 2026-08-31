import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AUTO_COMPACT_POLICY_REQUEST_EVENT =
	"pi-auto-compact:policy-request:v1";
export const AUTO_COMPACT_POLICY_EVENT = "pi-auto-compact:policy:v1";

export interface AutoCompactModelIdentity {
	api: string;
	provider: string;
	id: string;
}

export interface AutoCompactPolicySnapshot {
	protocolVersion: 1;
	model: AutoCompactModelIdentity;
	/** Echoed from the request so responses can be ordered across model changes. */
	requestId?: string;
	thresholdTokens: number;
	source: string;
	configPath: string;
	configError?: string;
}

type PolicyEvents = ExtensionAPI["events"];
type Unsubscribe = () => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function autoCompactModelIdentity(
	model: {
		api?: string;
		provider?: string;
		id?: string;
	} | undefined,
): AutoCompactModelIdentity | undefined {
	if (
		!model ||
		typeof model.api !== "string" ||
		typeof model.provider !== "string" ||
		typeof model.id !== "string"
	) {
		return undefined;
	}
	return { api: model.api, provider: model.provider, id: model.id };
}

export function autoCompactModelKey(model: AutoCompactModelIdentity): string {
	return `${model.api}/${model.provider}/${model.id}`;
}

export function parseAutoCompactPolicySnapshot(
	value: unknown,
): AutoCompactPolicySnapshot | undefined {
	if (
		!isRecord(value) ||
		value.protocolVersion !== 1 ||
		!isRecord(value.model) ||
		typeof value.model.api !== "string" ||
		typeof value.model.provider !== "string" ||
		typeof value.model.id !== "string" ||
		!Number.isSafeInteger(value.thresholdTokens) ||
		(value.thresholdTokens as number) < 0 ||
		typeof value.source !== "string" ||
		typeof value.configPath !== "string" ||
		(value.requestId !== undefined && typeof value.requestId !== "string") ||
		(value.configError !== undefined && typeof value.configError !== "string")
	) {
		return undefined;
	}

	return {
		protocolVersion: 1,
		model: {
			api: value.model.api,
			provider: value.model.provider,
			id: value.model.id,
		},
		...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
		thresholdTokens: value.thresholdTokens as number,
		source: value.source,
		configPath: value.configPath,
		...(typeof value.configError === "string"
			? { configError: value.configError }
			: {}),
	};
}

export interface AutoCompactPolicyClient {
	start(): void;
	stop(): void;
	clear(): void;
	request(model: AutoCompactModelIdentity): void;
	snapshotFor(
		model: AutoCompactModelIdentity | undefined,
	): AutoCompactPolicySnapshot | undefined;
}

let nextAutoCompactRequestId = 0;

export function createAutoCompactPolicyClient(
	events: PolicyEvents,
): AutoCompactPolicyClient {
	const requestedIds = new Map<string, string>();
	const legacyResponseKeys = new Set<string>();
	const snapshots = new Map<string, AutoCompactPolicySnapshot>();
	let unsubscribe: Unsubscribe | undefined;

	return {
		start() {
			if (unsubscribe) return;
			unsubscribe = events.on(AUTO_COMPACT_POLICY_EVENT, (value) => {
				const snapshot = parseAutoCompactPolicySnapshot(value);
				if (!snapshot) return;
				const key = autoCompactModelKey(snapshot.model);
				if (snapshot.requestId) {
					if (requestedIds.get(key) !== snapshot.requestId) return;
				} else if (!legacyResponseKeys.has(key)) {
					// Legacy responders do not echo request IDs. They are only safe to
					// accept while synchronously handling this request; delayed legacy
					// responses may belong to an earlier request for the same model.
					return;
				}
				snapshots.set(key, snapshot);
			});
		},
		stop() {
			unsubscribe?.();
			unsubscribe = undefined;
			requestedIds.clear();
			legacyResponseKeys.clear();
			snapshots.clear();
		},
		clear() {
			requestedIds.clear();
			legacyResponseKeys.clear();
			snapshots.clear();
		},
		request(model) {
			const key = autoCompactModelKey(model);
			const requestId = `local-mode-${++nextAutoCompactRequestId}`;
			requestedIds.set(key, requestId);
			legacyResponseKeys.add(key);
			try {
				events.emit(AUTO_COMPACT_POLICY_REQUEST_EVENT, {
					protocolVersion: 1,
					requestId,
					model,
				});
			} finally {
				legacyResponseKeys.delete(key);
			}
		},
		snapshotFor(model) {
			return model ? snapshots.get(autoCompactModelKey(model)) : undefined;
		},
	};
}
