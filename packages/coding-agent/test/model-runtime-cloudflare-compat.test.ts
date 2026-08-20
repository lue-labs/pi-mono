import { complete, resetApiProviders } from "@valkyriweb/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const openAIState = vi.hoisted(() => ({ clientOptions: undefined as unknown }));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			openAIState.clientOptions = options;
		}

		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse(): Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

async function createCloudflareRuntime(): Promise<{ modelRuntime: ModelRuntime; modelRegistry: ModelRegistry }> {
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify("cloudflare-ai-gateway", async () => ({
		type: "api_key",
		key: "test-token",
		env: {
			CLOUDFLARE_ACCOUNT_ID: "test-account",
			CLOUDFLARE_GATEWAY_ID: "test-gateway",
		},
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

// Pick by capability, never by literal id: the generated catalog is rebuilt from
// live provider data at build time, so a pinned id (this test used to hardcode
// workers-ai/@cf/moonshotai/kimi-k2.5) silently disappears when the provider
// retires the model. What matters here is only that the endpoint routes through
// the openai-completions compat path that the `openai` mock above intercepts.
function pickCompatModelId(modelRuntime: ModelRuntime): string {
	const model = modelRuntime.getModels("cloudflare-ai-gateway").find((m) => m.api === "openai-completions");
	if (!model) {
		throw new Error("no cloudflare-ai-gateway model with api=openai-completions in the generated catalog");
	}
	return model.id;
}

describe("ModelRegistry Cloudflare compat streaming", () => {
	it("materializes the Cloudflare endpoint through ModelRuntime streaming", async () => {
		const { modelRuntime } = await createCloudflareRuntime();
		const model = modelRuntime.getModel("cloudflare-ai-gateway", pickCompatModelId(modelRuntime));
		expect(model).toBeDefined();

		resetApiProviders();
		await modelRuntime.completeSimple(model!, { messages: [] });

		const clientOptions = openAIState.clientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test-token");
	});

	it("materializes the Cloudflare endpoint after extension-style auth resolution", async () => {
		const { modelRuntime, modelRegistry } = await createCloudflareRuntime();
		const model = modelRegistry.find("cloudflare-ai-gateway", pickCompatModelId(modelRuntime));
		expect(model).toBeDefined();

		resetApiProviders();
		const auth = await modelRegistry.getApiKeyAndHeaders(model!);
		expect(auth.ok).toBe(true);
		if (!auth.ok) throw new Error(auth.error);
		expect(auth.headers).toMatchObject({
			"cf-aig-authorization": "Bearer test-token",
			Authorization: null,
			"x-api-key": null,
		});

		await complete(model!, { messages: [] }, auth);

		const clientOptions = openAIState.clientOptions as {
			baseURL?: string;
			defaultHeaders?: Record<string, unknown>;
		};
		expect(clientOptions.baseURL).toBe("https://gateway.ai.cloudflare.com/v1/test-account/test-gateway/compat");
		expect(clientOptions.defaultHeaders?.["cf-aig-authorization"]).toBe("Bearer test-token");
		expect(clientOptions.defaultHeaders?.Authorization).toBeNull();
		expect(clientOptions.defaultHeaders?.["x-api-key"]).toBeNull();
	});
});
