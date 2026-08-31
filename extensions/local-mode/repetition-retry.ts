import {
	createAssistantMessageEventStream,
	getApiProvider,
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
	runRepetitionRetry,
	type RetryContext,
	type RetryEvent,
	type RetryOptions,
} from "./repetition-retry-core.js";

export {
	MAX_REPETITION_RETRIES,
	REPETITION_RETRY_INSTRUCTION,
} from "./repetition-retry-core.js";

type DirectStreamSimple = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

const directOpenAIStream: DirectStreamSimple = (model, context, options) => {
	const provider = getApiProvider("openai-completions");
	if (!provider) throw new Error("Built-in OpenAI completions adapter is unavailable");
	return provider.streamSimple(model, context, options);
};

function syntheticError(
	model: Model<Api>,
	error: unknown,
): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		},
	};
}

export function createRepetitionRetryStream(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	directStream: DirectStreamSimple = directOpenAIStream,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();

	void (async () => {
		try {
			const events = await runRepetitionRetry(
				context as RetryContext,
				options as RetryOptions | undefined,
				(attemptContext, attemptOptions) =>
					directStream(
						model as Model<"openai-completions">,
						attemptContext as Context,
						attemptOptions as SimpleStreamOptions | undefined,
					) as AsyncIterable<RetryEvent>,
			);
			for (const event of events) {
				outer.push(event as AssistantMessageEvent);
			}
		} catch (error) {
			outer.push(syntheticError(model, error));
		}
	})();

	return outer;
}
