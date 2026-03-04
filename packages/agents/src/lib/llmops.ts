import { llmops } from '@llmops/sdk';
import OpenAI from 'openai';

/** Create an OpenAI client pointed at the llmops.build gateway */
export function createClient(env: Env): OpenAI {
	const client = llmops({
		providers: [
			{
				slug: 'openrouter',
				provider: 'openrouter',
				apiKey: env.OPENROUTER_API_KEY,
			},
		],
	});

	return new OpenAI(client.provider());
}

export interface GatewayMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
}

export interface GatewayResponse {
	text: string;
	model: string;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Call a model via the llmops.build gateway using OpenAI-compatible API */
export async function callGateway(
	env: Env,
	opts: {
		model?: string;
		maxTokens?: number;
		system?: string;
		messages: GatewayMessage[];
	},
): Promise<GatewayResponse> {
	const client = createClient(env);

	const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
	if (opts.system) {
		messages.push({ role: 'system', content: opts.system });
	}
	messages.push(...opts.messages);

	const completion = await client.chat.completions.create({
		model: opts.model ?? '@openrouter/minimax/minimax-m2.5',
		messages,
	});

	const choice = completion.choices[0];
	if (!choice?.message?.content) {
		throw new Error('Empty response from gateway');
	}

	return {
		text: choice.message.content,
		model: completion.model,
		usage: {
			promptTokens: completion.usage?.prompt_tokens ?? 0,
			completionTokens: completion.usage?.completion_tokens ?? 0,
			totalTokens: completion.usage?.total_tokens ?? 0,
		},
	};
}
