import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool, ThinkingLevel } from "@lue-labs/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model, type ToolResultMessage, type Usage } from "@lue-labs/pi-ai";
import { registerFauxProvider } from "@lue-labs/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { addFilter } from "../../src/core/extensions/extension-hooks.ts";
import {
	MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS,
	replaceOversizedToolResultImages,
	replaceUnsupportedToolResultImages,
} from "../../src/core/tool-artifacts.ts";
import type { BuildSystemPromptOptions, ExtensionAPI } from "../../src/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

describe("AgentSession model and extension characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("setModel saves the model and emits model_select", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		const nextModel = harness.getModel("faux-2")!;

		await harness.session.setModel(nextModel);

		expect(harness.session.model?.id).toBe("faux-2");
		expect(modelEvents).toEqual(["faux-1->faux-2:set"]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => `${entry.provider}/${entry.modelId}`),
		).toEqual([`${nextModel.provider}/${nextModel.id}`]);
	});

	it("filters Codex-invalid tool names by API for gateway providers", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					for (const name of ["gateway_valid_tool", "gateway.invalid.tool"]) {
						pi.registerTool({
							name,
							label: name,
							description: `${name} description`,
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
						});
					}
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const { compat: _compat, ...currentModel } = harness.session.model!;
		const model: Model<"openai-codex-responses"> = {
			...currentModel,
			api: "openai-codex-responses",
			provider: "arbitrary-codex-gateway",
		};
		harness.session.agent.state.model = model;

		harness.session.setActiveToolsByName(["gateway_valid_tool", "gateway.invalid.tool"]);

		expect(harness.session.getActiveToolNames()).toContain("gateway_valid_tool");
		expect(harness.session.getActiveToolNames()).not.toContain("gateway.invalid.tool");
	});

	it("pending auto routing emits model events even when it keeps the current concrete model", async () => {
		const modelEvents: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
			extensionFactories: [
				(pi) => {
					pi.hooks.addFilter<any>("model:resolve", "test.same-model-route", (value) => ({
						...value,
						model: value.model,
						thinkingLevel: value.thinkingLevel,
						metadata: {
							...(value.metadata ?? {}),
							route: value.requestedModel,
							tier: "medium",
							llmRouterDecision: {
								route: value.requestedModel,
								provider: value.model?.provider,
								modelId: value.model?.id,
								tier: "medium",
								thinkingLevel: value.thinkingLevel,
								reason: ["test"],
							},
						},
					}));
					pi.on("model_select", async (event) => {
						modelEvents.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		harness.session.setPendingAutoModelAlias("clawrouter/auto");
		await harness.session.prompt("route me");

		expect(harness.session.pendingAutoModelAlias).toBeUndefined();
		expect(
			harness
				.eventsOfType("model_changed")
				.map((event) => `${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`),
		).toEqual(["faux-1->faux-1:set"]);
		expect(modelEvents).toEqual(["faux-1->faux-1:set"]);
	});

	it("setModel re-syncs provider-sensitive extension resources before the next request", async () => {
		const discoveredForProviders: string[] = [];
		const harness = await createHarness({
			provider: "claude-bridge",
			models: [{ id: "claude-opus-4-8", name: "Claude", reasoning: true }],
			extensionFactories: [
				(pi) => {
					pi.on("resources_discover", (_event, ctx) => {
						discoveredForProviders.push(ctx.model?.provider ?? "none");
						return {};
					});
				},
			],
		});
		harnesses.push(harness);
		const codex = registerFauxProvider({
			provider: "openai-codex",
			models: [{ id: "gpt-5.5", name: "GPT 5.5", reasoning: true }],
		});
		try {
			const codexModel = codex.getModel();
			await harness.authStorage.modify(codexModel.provider, async () => ({ type: "api_key", key: "faux-key" }));
			harness.session.modelRegistry.registerProvider(codexModel.provider, {
				baseUrl: codexModel.baseUrl,
				apiKey: "faux-key",
				api: codex.api,
				models: codex.models.map((registeredModel) => ({
					id: registeredModel.id,
					name: registeredModel.name,
					api: registeredModel.api,
					reasoning: registeredModel.reasoning,
					input: registeredModel.input,
					cost: registeredModel.cost,
					contextWindow: registeredModel.contextWindow,
					maxTokens: registeredModel.maxTokens,
					baseUrl: registeredModel.baseUrl,
				})),
			});

			await harness.session.setModel(codexModel);

			expect(discoveredForProviders).toContain("openai-codex");
		} finally {
			codex.unregister();
		}
	});

	it("cycles through scoped models and preserves the scoped thinking preference", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: false },
			],
		});
		harnesses.push(harness);
		const modelOne = harness.getModel("faux-1")!;
		const modelTwo = harness.getModel("faux-2")!;
		harness.session.setScopedModels([{ model: modelOne, thinkingLevel: "high" }, { model: modelTwo }] as Array<{
			model: Model<string>;
			thinkingLevel?: ThinkingLevel;
		}>);
		harness.session.setThinkingLevel("high");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.thinkingLevel).toBe("off");

		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.thinkingLevel).toBe("high");
	});

	it("clamps thinking levels to model capabilities and cycles available levels", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: false }] });
		harnesses.push(harness);

		harness.session.setThinkingLevel("high");
		expect(harness.session.thinkingLevel).toBe("off");
		expect(harness.session.cycleThinkingLevel()).toBeUndefined();
	});

	it("cycles xhigh before max when both are supported", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", reasoning: true }] });
		harnesses.push(harness);
		harness.getModel().thinkingLevelMap = { xhigh: "xhigh", max: "max" };

		expect(harness.session.getAvailableThinkingLevels()).toEqual([
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		harness.session.setThinkingLevel("high");
		expect(harness.session.cycleThinkingLevel()).toBe("xhigh");
		expect(harness.session.cycleThinkingLevel()).toBe("max");
		expect(harness.session.cycleThinkingLevel()).toBe("off");
	});

	it("throws when setModel is called without configured auth", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(harness.getModel("faux-2")!)).rejects.toThrow(
			`No API key for ${harness.getModel().provider}/faux-2`,
		);
	});

	it("allows extension tool_call handlers to block tool execution", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => {
				throw new Error("tool should have been blocked");
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", async () => ({ block: true, reason: "Blocked by test" }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const errorText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(errorText);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("Blocked by test");
		expect(
			harness.session.messages.find((message) => message.role === "toolResult" && message.isError),
		).toBeDefined();
	});

	it("allows extension tool_result handlers to modify tool results", async () => {
		const toolUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		};
		const patchedToolUsage: Usage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.5, output: 0.6, cacheRead: 0.7, cacheWrite: 0.8, total: 2.6 },
		};
		let observedToolUsage: Usage | undefined;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text }], details: { text }, usage: toolUsage };
			},
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						observedToolUsage = event.usage;
						return {
							content: [{ type: "text", text: "patched result" }],
							details: { patched: true },
							usage: patchedToolUsage,
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(text);
			},
		]);

		await harness.session.prompt("hi");

		expect(getAssistantTexts(harness)).toContain("patched result");
		const toolResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.details?.patched === true,
		);
		expect(observedToolUsage).toEqual(toolUsage);
		expect(toolResult).toBeDefined();
		expect(toolResult?.role === "toolResult" ? toolResult.usage : undefined).toEqual(patchedToolUsage);
	});

	it("saves unsupported image tool results as artifacts before the next model call", async () => {
		const bmpData = Buffer.from("fake-bmp-data").toString("base64");
		const imageTool: AgentTool = {
			name: "mcp_image",
			label: "MCP Image",
			description: "Returns an unsupported image MIME from an MCP-like tool",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "image", data: bmpData, mimeType: "image/bmp" }],
				details: {},
			}),
		};
		let hookSawRawUnsupportedImage = false;
		const harness = await createHarness({
			tools: [imageTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async (event) => {
						hookSawRawUnsupportedImage = event.content.some(
							(part) => part.type === "image" && part.mimeType === "image/bmp",
						);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp_image", {}, { id: "tool-1" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const hasImageBlock =
					toolResult?.role === "toolResult" && toolResult.content.some((part) => part.type === "image");
				const text =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage(`${hasImageBlock ? "has-image" : "no-image"}\n${text}`);
			},
		]);

		await harness.session.prompt("get image");

		const assistantText = getAssistantTexts(harness).join("\n");
		expect(hookSawRawUnsupportedImage).toBe(true);
		expect(assistantText).toContain("no-image");
		expect(assistantText).toContain("Unsupported image MIME image/bmp");
		expect(assistantText).toContain(".pi/tool-artifacts/");
		const artifactPath = join(harness.tempDir, ".pi", "tool-artifacts", "tool-1-0.bmp");
		expect(existsSync(artifactPath)).toBe(true);
		expect(readFileSync(artifactPath).toString()).toBe("fake-bmp-data");
	});

	it("keeps colliding image artifacts without overwriting durable history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstImage = {
			type: "image" as const,
			data: Buffer.from("first-bmp").toString("base64"),
			mimeType: "image/bmp",
		};
		const secondImage = {
			type: "image" as const,
			data: Buffer.from("second-bmp").toString("base64"),
			mimeType: "image/bmp",
		};

		const first = replaceUnsupportedToolResultImages([firstImage], harness.tempDir, "a/b");
		const second = replaceUnsupportedToolResultImages([secondImage], harness.tempDir, "a_b");

		expect(first?.[0]).toMatchObject({ text: expect.stringContaining(".pi/tool-artifacts/a_b-0.bmp") });
		expect(second?.[0]).toMatchObject({
			text: expect.stringMatching(/\.pi\/tool-artifacts\/a_b-0-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.bmp/),
		});
		expect(readFileSync(join(harness.tempDir, ".pi", "tool-artifacts", "a_b-0.bmp")).toString()).toBe("first-bmp");
		const collisionArtifact = readdirSync(join(harness.tempDir, ".pi", "tool-artifacts")).find((name) =>
			/^a_b-0-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.bmp$/.test(name),
		);
		expect(collisionArtifact).toBeDefined();
		expect(readFileSync(join(harness.tempDir, ".pi", "tool-artifacts", collisionArtifact!)).toString()).toBe(
			"second-bmp",
		);
	});

	it("saves oversized supported tool-result images as artifacts before the next model call", async () => {
		const imageTool: AgentTool = {
			name: "image",
			label: "Image",
			description: "Returns a supported image",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [
					{
						type: "image",
						data: "a".repeat(MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS + 1),
						mimeType: "image/png",
					},
				],
				details: {},
			}),
		};
		const harness = await createHarness({ tools: [imageTool] });
		harnesses.push(harness);
		let providerSawImage = false;
		let providerText = "";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("image", {}, { id: "image-large" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				providerSawImage =
					toolResult?.role === "toolResult" && toolResult.content.some((block) => block.type === "image");
				providerText =
					toolResult?.role === "toolResult"
						? toolResult.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("inspect image");

		expect(providerSawImage).toBe(false);
		expect(providerText).toContain(".pi/tool-artifacts/image-large-0.png");
		expect(existsSync(join(harness.tempDir, ".pi", "tool-artifacts", "image-large-0.png"))).toBe(true);
	});

	it("retains oversized images when artifacts cannot be written", () => {
		const image = {
			type: "image" as const,
			data: "a".repeat(MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS + 1),
			mimeType: "image/png",
		};

		const result = replaceOversizedToolResultImages([image], "/dev/null", "image-large");

		expect(result?.[0]).toEqual(image);
		expect(result?.[1]).toMatchObject({ type: "text" });
		expect(result?.[1]).toMatchObject({ text: expect.stringContaining("image retained in session history") });
	});

	it("caps oversized tool result text after extension handlers and saves the full text as an artifact", async () => {
		const firstLargeText = "x".repeat(60_000);
		const secondLargeText = "y".repeat(60_000);
		const pngData = Buffer.from("fake-png-data").toString("base64");
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "small" }], details: {} }),
		};
		const harness = await createHarness({
			tools: [echoTool],
			extensionFactories: [
				(pi) => {
					pi.on("tool_result", async () => ({
						content: [
							{ type: "text", text: firstLargeText },
							{ type: "tool_reference", name: "native-result" },
							{ type: "image", data: pngData, mimeType: "image/png" },
							{ type: "text", text: secondLargeText },
						],
						details: { patched: true },
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerToolResultText = "";
		let providerToolResultTextChars = 0;
		let providerSawImage = false;
		let providerSawToolReference = false;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", {}, { id: "tool-huge" })], { stopReason: "toolUse" }),
			(context) => {
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const textBlocks =
					toolResult?.role === "toolResult"
						? toolResult.content.filter((part): part is { type: "text"; text: string } => part.type === "text")
						: [];
				providerToolResultText = textBlocks.map((part) => part.text).join("\n");
				providerToolResultTextChars = textBlocks.reduce((sum, part) => sum + part.text.length, 0);
				providerSawImage =
					toolResult?.role === "toolResult" &&
					toolResult.content.some((part) => part.type === "image" && part.mimeType === "image/png");
				providerSawToolReference =
					toolResult?.role === "toolResult" &&
					toolResult.content.some((part) => part.type === "tool_reference" && part.name === "native-result");
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hi");

		expect(providerToolResultTextChars).toBeLessThanOrEqual(100_000);
		expect(providerSawImage).toBe(true);
		expect(providerSawToolReference).toBe(true);
		expect(providerToolResultText).toContain("Tool result truncated");
		expect(providerToolResultText).toContain(".pi/tool-results/tool-huge-echo.txt");
		const artifactPath = join(harness.tempDir, ".pi", "tool-results", "tool-huge-echo.txt");
		expect(existsSync(artifactPath)).toBe(true);
		expect(readFileSync(artifactPath, "utf8")).toBe(`${firstLargeText}\n\n${secondLargeText}`);
	});

	it("bounds aggregate tool-result images in the provider context and retires out-of-budget images from resident history", async () => {
		const imageData = "a".repeat(2 * 1024 * 1024);
		const imageTool: AgentTool = {
			name: "image",
			label: "Image",
			description: "Returns a supported image",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "image", data: imageData, mimeType: "image/png" }],
				details: {},
			}),
		};
		const harness = await createHarness({ tools: [imageTool] });
		harnesses.push(harness);
		let providerImageChars = 0;
		let providerImageToolCallIds: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("image", {}, { id: "image-1" }),
					fauxToolCall("image", {}, { id: "image-2" }),
					fauxToolCall("image", {}, { id: "image-3" }),
					fauxToolCall("image", {}, { id: "image-4" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				providerImageChars = toolResults
					.flatMap((message) => message.content)
					.reduce((total, block) => total + (block.type === "image" ? block.data.length : 0), 0);
				providerImageToolCallIds = toolResults
					.filter((message) => message.content.some((block) => block.type === "image"))
					.map((message) => message.toolCallId);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("inspect images");

		expect(providerImageChars).toBeLessThanOrEqual(3 * 1024 * 1024);
		expect(providerImageToolCallIds).toEqual(["image-4"]);
		// Out-of-budget images are permanently retired from resident history at
		// agent_end with the same placeholder the provider view emits (they can
		// never reach the model again and previously leaked unboundedly —
		// my-pi#1147). Only the in-budget newest image stays resident.
		const storedToolResultBlocks = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.flatMap((message) => message.content);
		expect(storedToolResultBlocks.filter((block) => block.type === "image").length).toBe(1);
		expect(
			storedToolResultBlocks.filter(
				(block) => block.type === "text" && block.text.includes("Image omitted from this provider request"),
			).length,
		).toBe(3);
		// Durable JSONL safety is by ordering, not re-serialization: file-backed
		// sessions persist each message at message_end (appendFileSync), before
		// agent_end retirement mutates the resident objects.
	});

	it("strips images from cache-safe compaction requests", async () => {
		const imageTool: AgentTool = {
			name: "image",
			label: "Image",
			description: "Returns a supported image",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "image", data: "a".repeat(1024), mimeType: "image/png" }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [imageTool],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("image", {}, { id: "image-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("inspect image");

		let compactionImageCount = 0;
		harness.setResponses([
			(context) => {
				compactionImageCount = context.messages
					.flatMap((message) => (message.role === "toolResult" ? (message as ToolResultMessage).content : []))
					.filter((block) => block.type === "image").length;
				return fauxAssistantMessage("summary");
			},
		]);
		await harness.session.compact();

		expect(compactionImageCount).toBe(0);
	});

	it("allows extension context handlers to modify messages before the LLM call", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? { ...message, content: [{ type: "text", text: "rewritten" }], timestamp: message.timestamp }
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerUserText = "";
		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("original");

		expect(providerUserText).toBe("rewritten");
		const storedUserMessage = harness.session.messages.find((message) => message.role === "user");
		expect(storedUserMessage?.role).toBe("user");
		if (storedUserMessage?.role === "user") {
			expect(storedUserMessage.content).toEqual([{ type: "text", text: "original" }]);
		}
	});

	it("allows extension input handlers to transform or handle input", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const transformedHarness = await createHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("input", async (event) => {
						if (event.text === "ping") {
							return { action: "handled" };
						}
						return { action: "transform", text: `transformed:${event.text}` };
					});
				},
			],
		});
		harnesses.push(transformedHarness);
		let providerUserText = "";
		transformedHarness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				providerUserText =
					user && typeof user.content !== "string"
						? user.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "";
				return fauxAssistantMessage("done");
			},
		]);

		await transformedHarness.session.prompt("hello");
		await transformedHarness.session.prompt("ping");

		expect(providerUserText).toBe("transformed:hello");
		expect(transformedHarness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		expect(extensionApi).toBeDefined();
	});

	it("allows extension commands to inspect live system prompt options", async () => {
		const seenOptions: BuildSystemPromptOptions[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("inspect-options", {
						description: "Inspect system prompt options",
						handler: async (_args, ctx) => {
							const options = ctx.getSystemPromptOptions();
							seenOptions.push(options);
							options.selectedTools?.push("mutated_tool");
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/inspect-options");
		await harness.session.prompt("/inspect-options");

		expect(seenOptions).toHaveLength(2);
		expect(seenOptions[0]).toBe(seenOptions[1]);
		expect(seenOptions[0]?.cwd).toBe(harness.tempDir);
		// Fork uses CC-capitalized native tool names (Bash/Read/...) rather than
		// upstream's lowercase ids; assert a stable default tool is present.
		expect(seenOptions[0]?.selectedTools).toContain("Bash");
		expect(seenOptions[1]?.selectedTools).toContain("mutated_tool");
	});

	it("allows before_agent_start handlers to inject custom messages and modify the system prompt", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						message: {
							customType: "before-start",
							content: "injected",
							display: true,
							details: { injected: true },
						},
						systemPrompt: `${event.systemPrompt}\n\nextra instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		let providerSystemPrompt = "";
		let sawInjectedUserMessage = false;
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				sawInjectedUserMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "injected"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(providerSystemPrompt).toContain("extra instructions");
		expect(sawInjectedUserMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "before-start"),
		).toBe(true);
	});

	it("re-applies systemPrompt:build filters after a mid-turn tool change (cache stability)", async () => {
		// Regression: _rebuildSystemPrompt (fired by setActiveTools / skill
		// discovery) returns an UNFILTERED buildSystemPrompt output, so any
		// systemPrompt:build filter (time-context's `Current date:` strip,
		// cache-base-prompt's boundary relocation) is dropped on a mid-turn tool
		// change, mutating the cached prefix and bursting the prompt cache. This
		// idempotent filter rewrites the real `Current working directory:` line that
		// buildSystemPrompt emits; a before_agent_start handler forces a rebuild every
		// turn (setActiveTools is not idempotent). The bug only surfaces from turn 2
		// on, when the already-filtered prompt is fed back in and systemPromptModified
		// is false, so the clobbered unfiltered rebuild would otherwise ship.
		const dispose = addFilter<string>("systemPrompt:build", "test.rewrite-cwd-line", (sp) =>
			typeof sp === "string" ? sp.replace("Current working directory:", "CWD:") : sp,
		);
		// Captured session ref: the handler must clobber the base prompt DURING the
		// before_agent_start window (after this turn's filter pass), which is the only
		// point the bug manifests. setActiveToolsByName is not idempotent and rebuilds
		// the prompt unfiltered on every call.
		const ref: { session?: Harness["session"] } = {};
		try {
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							ref.session?.setActiveToolsByName(ref.session.getActiveToolNames());
						});
					},
				],
			});
			ref.session = harness.session;
			harnesses.push(harness);
			const sentSystemPrompts: string[] = [];
			const capture = (context: { systemPrompt?: string }) => {
				sentSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("done");
			};
			harness.setResponses([capture, capture]);

			await harness.session.prompt("first");
			await harness.session.prompt("second");

			// Turn 2: input is already filtered → systemPromptModified is false → the
			// send path must re-filter the clobbered rebuild so the filter still applies.
			expect(sentSystemPrompts.length).toBe(2);
			expect(sentSystemPrompts[1]).toContain("CWD:");
			expect(sentSystemPrompts[1]).not.toContain("Current working directory:");
		} finally {
			dispose();
		}
	});

	it("bindExtensions emits session_start and reload emits session_shutdown then session_start", async () => {
		const lifecycleEvents: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event) => {
						lifecycleEvents.push(`start:${event.reason}`);
					});
					pi.on("session_shutdown", async (event) => {
						lifecycleEvents.push(`shutdown:${event.reason}`);
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		await harness.session.reload();

		expect(lifecycleEvents).toEqual(["start:startup", "shutdown:reload", "start:reload"]);
	});
});
