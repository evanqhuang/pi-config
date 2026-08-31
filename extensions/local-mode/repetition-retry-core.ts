export const MAX_REPETITION_RETRIES = 5;
export const REPETITION_RETRY_INSTRUCTION =
	"Your prior generation was interrupted due to repetition. Continue from the conversation state.";

export interface RetryContext {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
	[key: string]: unknown;
}

export interface RetryOptions {
	signal?: AbortSignal;
	samplingParams?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface RetryEvent {
	type: string;
	error?: {
		rawStopReason?: string;
		content?: unknown[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export type RetryDirectStream = (
	context: RetryContext,
	options: RetryOptions | undefined,
) => AsyncIterable<RetryEvent>;

function retryContext(context: RetryContext): RetryContext {
	return {
		...context,
		systemPrompt: context.systemPrompt
			? `${context.systemPrompt}\n\n${REPETITION_RETRY_INSTRUCTION}`
			: REPETITION_RETRY_INSTRUCTION,
		messages: context.messages,
		tools: context.tools,
	};
}

function retryOptions(options: RetryOptions | undefined): RetryOptions {
	return {
		...options,
		samplingParams: {
			...(options?.samplingParams ?? {}),
			skip_reading_prefix_cache: true,
		},
	};
}

function isRepetitionError(event: RetryEvent): boolean {
	return event.type === "error" && event.error?.rawStopReason === "repetition";
}

export async function runRepetitionRetry(
	context: RetryContext,
	options: RetryOptions | undefined,
	directStream: RetryDirectStream,
): Promise<RetryEvent[]> {
	for (let attempt = 0; attempt <= MAX_REPETITION_RETRIES; attempt += 1) {
		const retry = attempt > 0;
		const events: RetryEvent[] = [];
		for await (const event of directStream(
			retry ? retryContext(context) : context,
			retry ? retryOptions(options) : options,
		)) {
			events.push(structuredClone(event));
		}

		const terminal = events.at(-1);
		if (!terminal) throw new Error("Local provider stream ended without a terminal event");
		if (!isRepetitionError(terminal)) return events;

		const canRetry =
			attempt < MAX_REPETITION_RETRIES && !options?.signal?.aborted;
		if (canRetry) continue;
		return [
			{
				...terminal,
				error: terminal.error
					? { ...terminal.error, content: [] }
					: terminal.error,
			},
		];
	}
	throw new Error("Unreachable repetition retry state");
}
