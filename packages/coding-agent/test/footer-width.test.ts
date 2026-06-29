import { visibleWidth } from "@valkyriweb/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	clearAgentRecentRunsForTests,
	formatAgentFooterStatus,
	startAgentRecentRun,
} from "../src/core/agents/status.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { FooterComponent, formatCwdForFooter } from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	usage?: AssistantUsage;
	entries?: unknown[];
	branchEntries?: unknown[];
	isStreaming?: boolean;
	contextUsage?: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
		details?: {
			source?: "provider_usage" | "loaded_estimate";
			loadedContextTokens?: number;
			deferredToolSchemaTokens?: number;
			loadedDeferredToolCount?: number;
			nativeDeferredTools?: boolean;
		};
	};
}): AgentSession {
	const usage = options.usage;
	const entries =
		options.entries ??
		(usage === undefined
			? []
			: [
					{
						type: "message",
						message: {
							role: "assistant",
							usage,
						},
					},
				]);

	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		isStreaming: options.isStreaming ?? false,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => options.branchEntries ?? entries,
			getSessionName: () => options.sessionName,
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => options.contextUsage ?? { tokens: 24_600, contextWindow: 200_000, percent: 12.3 },
		modelRegistry: {
			isUsingOAuth: () => false,
		},
		extensionRunner: {
			// Mirrors the production agents extension hook (core/extensions/agents.ts)
			// which contributes the background-agent status pill.
			getRegisteredFooters: () => {
				const rendered = formatAgentFooterStatus();
				if (rendered === undefined) return [];
				return [
					{
						id: "agents-status",
						extensionPath: "<builtin:hook:agents>",
						spec: {
							render: () => rendered,
							onActivate: () => {},
						},
					},
				];
			},
		},
	};

	return session as unknown as AgentSession;
}

function createFooterData(providerCount: number): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};

	return provider;
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	beforeEach(() => clearAgentRecentRunsForTests());

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = createSession({ sessionName: "한글".repeat(30) });
		const footer = new FooterComponent(session, createFooterData(1));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows unloaded provider-deferred tool schema tokens separately from loaded estimates", () => {
		const session = createSession({
			sessionName: "",
			contextUsage: {
				tokens: 24_600,
				contextWindow: 200_000,
				percent: 12.3,
				details: { source: "loaded_estimate", loadedContextTokens: 24_600, deferredToolSchemaTokens: 11_100 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = stripAnsi(footer.render(120).join("\n"));

		expect(rendered).toContain("25k+d11k/200k");
	});

	it("keeps provider-backed tokens primary while still showing deferred schema budget", () => {
		const session = createSession({
			sessionName: "",
			contextUsage: {
				tokens: 35_700,
				contextWindow: 200_000,
				percent: 17.85,
				details: {
					source: "provider_usage",
					loadedContextTokens: 24_600,
					deferredToolSchemaTokens: 11_100,
					nativeDeferredTools: true,
				},
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = stripAnsi(footer.render(120).join("\n"));

		expect(rendered).toContain("36k+d11k/200k");
		expect(rendered).not.toContain("25k+d11k/200k");
	});

	it("uses loaded context as a floor when the last native-deferred schema has just loaded", () => {
		const session = createSession({
			sessionName: "",
			contextUsage: {
				tokens: 35_700,
				contextWindow: 200_000,
				percent: 17.85,
				details: {
					source: "provider_usage",
					loadedContextTokens: 48_200,
					deferredToolSchemaTokens: 0,
					loadedDeferredToolCount: 1,
					nativeDeferredTools: true,
				},
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = stripAnsi(footer.render(120).join("\n"));

		expect(rendered).toContain("48k/200k");
		expect(rendered).not.toContain("36k/200k");
	});

	it("does not turn unknown post-compaction context usage into a concrete percent", () => {
		const session = createSession({
			sessionName: "",
			contextUsage: {
				tokens: null,
				contextWindow: 200_000,
				percent: null,
				details: { source: "loaded_estimate", loadedContextTokens: 24_600, deferredToolSchemaTokens: 11_100 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = stripAnsi(footer.render(120).join("\n"));

		expect(rendered).toContain("?% ?+d11k/200k");
		expect(rendered).not.toContain("25k+d11k/200k");
	});

	it("uses provider-backed context usage when there is no deferred schema budget to split", () => {
		const session = createSession({
			sessionName: "",
			contextUsage: {
				tokens: 50_000,
				contextWindow: 200_000,
				percent: 25,
				details: { loadedContextTokens: 24_600, deferredToolSchemaTokens: 0 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(1));

		const rendered = stripAnsi(footer.render(120).join("\n"));

		expect(rendered).toContain("50k/200k");
		expect(rendered).not.toContain("25k/200k");
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = createSession({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = new FooterComponent(session, createFooterData(2));

		const lines = footer.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("resets token and cache totals after the latest compaction entry", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				entries: [
					{
						id: "before",
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input: 100_000,
								output: 1,
								cacheRead: 300_000,
								cacheWrite: 100_000,
								cost: { total: 9 },
							},
						},
					},
					{
						id: "compact",
						type: "compaction",
						timestamp: "2026-05-31T08:00:00.000Z",
						summary: "summary",
						firstKeptEntryId: "after",
						tokensBefore: 100_000,
					},
					{
						id: "after",
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input: 2_000,
								output: 1,
								cacheRead: 8_000,
								cacheWrite: 2_000,
								cost: { total: 1 },
							},
						},
					},
				],
			}),
			createFooterData(1),
		);

		const rendered = footer.render(140).join("\n");

		expect(rendered).toContain("↑2.0k");
		expect(rendered).toContain("R8.0k");
		expect(rendered).toContain("W2.0k");
		// First assistant turn after a compaction: the cold full-prefix write is
		// expected, so the cache label is informational, not drift-colored.
		expect(rendered).toContain("cache 80% avg 80% ⟳compact");
		expect(rendered).toContain("t1");
		expect(rendered).not.toContain("↑102k");
		expect(rendered).not.toContain("t2");
	});

	it("drops the post-compaction marker from the second turn onward", () => {
		const usage = (cacheRead: number, cacheWrite: number) => ({
			role: "assistant" as const,
			usage: { input: 0, output: 1, cacheRead, cacheWrite, cost: { total: 1 } },
		});
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				entries: [
					{
						id: "compact",
						type: "compaction",
						timestamp: "2026-05-31T08:00:00.000Z",
						summary: "summary",
						firstKeptEntryId: "after",
						tokensBefore: 100_000,
					},
					{ id: "after", type: "message", message: usage(8_000, 2_000) },
					{ id: "warm", type: "message", message: usage(10_000, 0) },
				],
			}),
			createFooterData(1),
		);

		const rendered = footer.render(140).join("\n");
		expect(rendered).toContain("cache 100% avg 100%");
		expect(rendered).not.toContain("⟳compact");
	});

	it("computes token and cache totals from the active branch only", () => {
		const shared = {
			id: "shared",
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 1_000,
					output: 1,
					cacheRead: 9_000,
					cacheWrite: 0,
					cost: { total: 1 },
				},
			},
		};
		const abandoned = {
			id: "abandoned",
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 100_000,
					output: 1,
					cacheRead: 0,
					cacheWrite: 100_000,
					cost: { total: 9 },
				},
			},
		};
		const active = {
			id: "active",
			type: "message",
			message: {
				role: "assistant",
				usage: {
					input: 2_000,
					output: 1,
					cacheRead: 8_000,
					cacheWrite: 0,
					cost: { total: 1 },
				},
			},
		};
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				entries: [shared, abandoned, active],
				branchEntries: [shared, active],
			}),
			createFooterData(1),
		);

		const rendered = footer.render(140).join("\n");

		expect(rendered).toContain("↑3.0k");
		expect(rendered).toContain("R17k");
		expect(rendered).toContain("cache 80% avg 85%");
		expect(rendered).not.toContain("↑103k");
		expect(rendered).not.toContain("W100k");
	});

	it("shows cold first-turn cache status", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				provider: "test",
				modelId: "test-model",
				usage: {
					input: 37_196,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { total: 1 },
				},
			}),
			createFooterData(1),
		);

		const rendered = footer.render(140).join("\n");

		expect(rendered).toContain("↑37k");
		expect(rendered).toContain("cache 0% avg 0%");
		expect(rendered).toContain("t1");
	});

	it("shows warm first-turn cache status", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				provider: "test",
				modelId: "test-model",
				usage: {
					input: 300,
					output: 1,
					cacheRead: 36_864,
					cacheWrite: 0,
					cost: { total: 1 },
				},
			}),
			createFooterData(1),
		);

		const rendered = footer.render(140).join("\n");

		expect(rendered).toContain("R37k");
		expect(rendered).toContain("cache 99% avg 99%");
		expect(rendered).toContain("t1");
	});

	it("shows latest-turn cache cache ratio plus the weighted average", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				provider: "openai-codex",
				entries: [
					{
						id: "cold",
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input: 34_000,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								cost: { total: 1 },
							},
						},
					},
					{
						id: "warm",
						type: "message",
						message: {
							role: "assistant",
							usage: {
								input: 13,
								output: 1,
								cacheRead: 33_000,
								cacheWrite: 0,
								cost: { total: 1 },
							},
						},
					},
				],
			}),
			createFooterData(1),
		);

		const rendered = footer.render(140).join("\n");

		expect(rendered).toContain("↑34k");
		expect(rendered).toContain("R33k");
		expect(rendered).toContain("cache 100% avg 49%");
	});

	it("flags a large fresh input tail without changing the cache ratio", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				provider: "openai-codex",
				usage: {
					input: 29_033,
					output: 1,
					cacheRead: 35_840,
					cacheWrite: 0,
					cost: { total: 1 },
				},
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 55% avg 55% ⚠fresh");
		expect(rendered).not.toContain("🔥prefix");
	});

	it("does not warn when small fresh input rides a warm prefix", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				usage: { input: 300, output: 1, cacheRead: 36_864, cacheWrite: 0, cost: { total: 1 } },
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 99% avg 99%");
		expect(rendered).not.toContain("⚠fresh");
		expect(rendered).not.toContain("🔥prefix");
	});

	it("flags unexpected large prefix writes after warmup", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				entries: [
					{
						id: "warm",
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 200, output: 1, cacheRead: 20_000, cacheWrite: 0, cost: { total: 1 } },
						},
					},
					{
						id: "cold-write",
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 100, output: 1, cacheRead: 10_000, cacheWrite: 6_000, cost: { total: 1 } },
						},
					},
				],
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 99% avg 99% 🔥prefix");
	});

	it("does not flag first-turn cache writes as prefix drift", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 6_000, cost: { total: 1 } },
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 0% avg 0%");
		expect(rendered).not.toContain("🔥prefix");
	});

	it("flags likely TTL-expiry cold turns", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				modelId: "gpt-5.5",
				entries: [
					{
						id: "warm",
						timestamp: "2026-06-29T08:48:27.000Z",
						type: "message",
						message: {
							role: "assistant",
							model: "gpt-5.5",
							usage: { input: 19_361, output: 1, cacheRead: 87_040, cacheWrite: 0, cost: { total: 1 } },
						},
					},
					{
						id: "cold",
						timestamp: "2026-06-29T08:53:27.000Z",
						type: "message",
						message: {
							role: "assistant",
							model: "gpt-5.5",
							usage: { input: 110_133, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
						},
					},
				],
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 0% avg 40% ⌛ttl");
		expect(rendered).not.toContain("🔥prefix");
	});

	it("does not flag short cold gaps as TTL expiry", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				modelId: "gpt-5.5",
				entries: [
					{
						id: "warm",
						timestamp: "2026-06-29T08:48:27.000Z",
						type: "message",
						message: {
							role: "assistant",
							model: "gpt-5.5",
							usage: { input: 19_361, output: 1, cacheRead: 87_040, cacheWrite: 0, cost: { total: 1 } },
						},
					},
					{
						id: "cold",
						timestamp: "2026-06-29T08:50:00.000Z",
						type: "message",
						message: {
							role: "assistant",
							model: "gpt-5.5",
							usage: { input: 110_133, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } },
						},
					},
				],
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 0% avg 40%");
		expect(rendered).not.toContain("⌛ttl");
	});

	it("marks post-compaction cache writes as expected instead of prefix drift", () => {
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				entries: [
					{
						id: "compact",
						type: "compaction",
						timestamp: "2026-05-31T08:00:00.000Z",
						summary: "summary",
						firstKeptEntryId: "after",
						tokensBefore: 100_000,
					},
					{
						id: "after",
						type: "message",
						message: {
							role: "assistant",
							usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 6_000, cost: { total: 1 } },
						},
					},
				],
			}),
			createFooterData(1),
		);

		const rendered = stripAnsi(footer.render(140).join("\n"));

		expect(rendered).toContain("cache 0% avg 0% ⟳compact");
		expect(rendered).not.toContain("🔥prefix");
	});

	it("never renders the work-bar in the footer (moved to the working loader, #53)", () => {
		// The streaming work-bar + esc-to-interrupt hint + elapsed-timer pulse were
		// moved out of the footer into the interactive-mode working loader (#53), so
		// the footer must not render them in either the idle or streaming state.
		const idle = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		expect(idle.render(120).join("\n")).not.toContain("esc to interrupt");

		const streaming = new FooterComponent(createSession({ sessionName: "", isStreaming: true }), createFooterData(1));
		const rendered = streaming.render(120).join("\n");
		expect(rendered).not.toContain("esc to interrupt");
		expect(rendered).not.toMatch(/[●○] \d+s/);
	});

	it("keeps the stats line within width while streaming on a narrow terminal", () => {
		const width = 50;
		const footer = new FooterComponent(
			createSession({
				sessionName: "",
				modelId: "claude-opus-4-8",
				isStreaming: true,
				usage: { input: 12_345, output: 6_789, cacheRead: 4_000, cacheWrite: 1_000, cost: { total: 1.234 } },
			}),
			createFooterData(2),
		);
		for (const line of footer.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("shows active background agent runs in the footer", () => {
		startAgentRecentRun("single", [{ agent: "worker", task: "Sleep" }], {
			background: true,
		});
		const footer = new FooterComponent(createSession({ sessionName: "" }), createFooterData(1));
		const rendered = footer.render(100).join("\n");

		expect(rendered).toContain("Agents: 1 running");
		expect(rendered).toContain("/agents runs");
	});
});
