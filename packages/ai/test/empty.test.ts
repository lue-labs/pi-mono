import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Api, AssistantMessage, Context, Model, StreamOptions, UserMessage } from "../src/types.ts";
import { pickModel } from "./helpers/models.ts";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.ts";
import { hasBedrockCredentials } from "./bedrock-utils.ts";
import { hasCloudflareAiGatewayCredentials, hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";
import { resolveApiKey } from "./oauth.ts";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with completely empty content array
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	// Should either handle gracefully or return an error
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty string content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with whitespace-only content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle whitespace-only gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	// Test with empty assistant message in conversation flow
	// User -> Empty Assistant -> User
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty assistant message in context gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

describe("AI Providers Empty Message Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Empty Messages", () => {
		const llm = pickModel("google");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Empty Messages", () => {
		const llm = pickModel("openai");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Empty Messages", () => {
		const llm = pickModel("openai");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider Empty Messages", () => {
		const llm = pickModel("azure-openai-responses");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, azureOptions);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, azureOptions);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm, azureOptions);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider Empty Messages", () => {
		const llm = pickModel("anthropic");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Empty Messages", () => {
		const llm = pickModel("xai");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Empty Messages", () => {
		const llm = pickModel("groq");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Empty Messages", () => {
		const llm = pickModel("cerebras");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI Provider Empty Messages", () => {
		const llm = pickModel("cloudflare-workers-ai");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasCloudflareAiGatewayCredentials())("Cloudflare AI Gateway Provider Empty Messages", () => {
		const llm = pickModel("cloudflare-ai-gateway");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider Empty Messages", () => {
		const llm = pickModel("huggingface");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.TOGETHER_API_KEY)("Together AI Provider Empty Messages", () => {
		const llm = pickModel("together");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.BASETEN_API_KEY)("Baseten Provider Empty Messages", () => {
		const llm = getModel("baseten", "zai-org/GLM-5.2");
		const options = { reasoningEffort: "high" } satisfies StreamOptionsWithExtras;

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, options);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, options);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm, options);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm, options);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Empty Messages", () => {
		const llm = pickModel("zai");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider Empty Messages", () => {
		const llm = pickModel("mistral");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider Empty Messages", () => {
		const llm = pickModel("minimax");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider Empty Messages", () => {
		const llm = pickModel("xiaomi");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY)(
		"Xiaomi MiMo Token Plan (CN) Provider Empty Messages",
		() => {
			const llm = pickModel("xiaomi-token-plan-cn");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_AMS_API_KEY)(
		"Xiaomi MiMo Token Plan (AMS) Provider Empty Messages",
		() => {
			const llm = pickModel("xiaomi-token-plan-ams");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.XIAOMI_TOKEN_PLAN_SGP_API_KEY)(
		"Xiaomi MiMo Token Plan (SGP) Provider Empty Messages",
		() => {
			const llm = pickModel("xiaomi-token-plan-sgp");

			it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyMessage(llm);
			});

			it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyStringMessage(llm);
			});

			it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
				await testWhitespaceOnlyMessage(llm);
			});

			it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
				await testEmptyAssistantMessage(llm);
			});
		},
	);

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_API_KEY)("Qwen Token Plan Provider Empty Messages", () => {
		const llm = getModel("qwen-token-plan", "qwen3.7-max");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.QWEN_TOKEN_PLAN_CN_API_KEY)("Qwen Token Plan (CN) Provider Empty Messages", () => {
		const llm = getModel("qwen-token-plan-cn", "qwen3.7-max");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider Empty Messages", () => {
		const llm = pickModel("kimi-coding");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider Empty Messages", () => {
		const llm = pickModel("vercel-ai-gateway");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider Empty Messages", () => {
		const llm = pickModel("amazon-bedrock");

		it("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", { retry: 3, timeout: 30000 }, async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider Empty Messages", () => {
		const llm = pickModel("anthropic");

		it.skipIf(!anthropicOAuthToken)("should handle empty content array", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle empty string content", { retry: 3, timeout: 30000 }, async () => {
			await testEmptyStringMessage(llm, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testWhitespaceOnlyMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testEmptyAssistantMessage(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider Empty Messages", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-5.5 - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testEmptyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5.5 - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testEmptyStringMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5.5 - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testWhitespaceOnlyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-5.5 - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testEmptyAssistantMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testEmptyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testEmptyStringMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testWhitespaceOnlyMessage(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("github-copilot");
				await testEmptyAssistantMessage(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider Empty Messages", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle empty content array",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("openai-codex");
				await testEmptyMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle empty string content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("openai-codex");
				await testEmptyStringMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle whitespace-only content",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("openai-codex");
				await testWhitespaceOnlyMessage(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should handle empty assistant message in conversation",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = pickModel("openai-codex");
				await testEmptyAssistantMessage(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
