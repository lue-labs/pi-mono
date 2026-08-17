import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	boundModelFacingContextImages,
	capMidRunCompactionToolResultText,
	capModelFacingToolResultText,
	MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS,
	retireOutOfBudgetContextImages,
} from "../src/core/tool-artifacts.ts";

type TestMessage = { role: string; content: unknown };

const MB = 1024 * 1024;

function imageMessage(chars: number, marker: string): TestMessage {
	return {
		role: "toolResult",
		content: [
			{ type: "text", text: `before ${marker}` },
			{ type: "image", data: marker[0].repeat(chars), mimeType: "image/png" },
		],
	};
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("capModelFacingToolResultText", () => {
	it("preserves the original artifact when mid-run compaction further caps its preview", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tool-result-cap-"));
		const fullText = "x".repeat(120_000);
		try {
			const firstPreview = capModelFacingToolResultText(
				[{ type: "text", text: fullText }],
				dir,
				"call",
				"large_result",
			);
			expect(firstPreview).toBeDefined();

			const midRunPreview = capMidRunCompactionToolResultText(firstPreview!, dir, "call", "large_result");
			expect(midRunPreview).toBeDefined();
			expect(readFileSync(join(dir, ".pi/tool-results/call-large_result.txt"), "utf8")).toBe(fullText);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("retireOutOfBudgetContextImages", () => {
	it("retires nothing when images fit the budget", () => {
		const messages = [imageMessage(1 * MB, "a"), imageMessage(1 * MB, "b")];
		const snapshot = clone(messages);
		expect(retireOutOfBudgetContextImages(messages)).toBe(0);
		expect(messages).toEqual(snapshot);
	});

	it("retires oldest images beyond the newest-first budget, in place", () => {
		expect(MAX_MODEL_FACING_CONTEXT_IMAGE_BASE64_CHARS).toBe(3 * MB);
		const oldest = imageMessage(2 * MB, "a");
		const newest = imageMessage(2 * MB, "b");
		const messages = [oldest, newest];

		expect(retireOutOfBudgetContextImages(messages)).toBe(1);

		// Same message objects (in-place): every holder observes the stub.
		expect(messages[0]).toBe(oldest);
		const oldContent = oldest.content as Array<{ type: string; text?: string }>;
		expect(oldContent[0]).toEqual({ type: "text", text: "before a" });
		expect(oldContent[1].type).toBe("text");
		expect(oldContent[1].text).toMatch(/Image omitted/);

		// Newest image untouched.
		const newContent = newest.content as Array<{ type: string; data?: string }>;
		expect(newContent[1].type).toBe("image");
		expect(newContent[1].data?.length).toBe(2 * MB);
	});

	it("is cache-neutral: provider view is byte-identical before and after retirement", () => {
		const makeMessages = () => [
			imageMessage(2 * MB, "a"),
			{ role: "user", content: "hello" },
			imageMessage(2 * MB, "b"),
			imageMessage(2 * MB, "c"),
		];

		// Provider view without retirement (today's behavior).
		const untouched = makeMessages();
		const viewBefore = boundModelFacingContextImages(untouched);

		// Provider view after stored-history retirement.
		const retired = makeMessages();
		retireOutOfBudgetContextImages(retired);
		const viewAfter = boundModelFacingContextImages(retired);

		expect(JSON.stringify(viewAfter)).toBe(JSON.stringify(viewBefore));
	});

	it("stays cache-neutral under image-mutating extension context transforms", () => {
		// The provider pipeline is bound → extension transforms → bound (sdk.ts
		// transformContext). An extension that drops the newest image would shift
		// the budget of a raw post-transform walk toward older images — the
		// pre-transform bound pins the replaced set to the same walk retirement
		// uses, so provider bytes cannot change.
		const makeMessages = () => [imageMessage(2 * MB, "a"), imageMessage(2 * MB, "b")];
		const dropNewestImage = (messages: TestMessage[]) =>
			messages.map((message, index) =>
				index === messages.length - 1
					? {
							...message,
							content: (message.content as unknown[]).filter((b) => (b as { type: string }).type !== "image"),
						}
					: message,
			);
		const providerView = (messages: TestMessage[]) =>
			boundModelFacingContextImages(dropNewestImage(boundModelFacingContextImages(messages)));

		const untouched = makeMessages();
		const viewBefore = providerView(untouched);

		const retired = makeMessages();
		retireOutOfBudgetContextImages(retired);
		const viewAfter = providerView(retired);

		expect(JSON.stringify(viewAfter)).toBe(JSON.stringify(viewBefore));
		// Sanity: with only a post-transform bound this scenario WOULD diverge —
		// dropping the newest image frees budget for the older (already-retired) one.
		const rawPostTransformOnly = (messages: TestMessage[]) =>
			boundModelFacingContextImages(dropNewestImage(messages));
		expect(JSON.stringify(rawPostTransformOnly(makeMessages()))).not.toBe(
			JSON.stringify(rawPostTransformOnly(clone(retired))),
		);
	});

	it("counts multiple retired blocks across messages", () => {
		const messages = [imageMessage(2 * MB, "a"), imageMessage(2 * MB, "b"), imageMessage(2 * MB, "c")];
		expect(retireOutOfBudgetContextImages(messages)).toBe(2);
		// Second pass is a no-op: already-retired blocks are text.
		expect(retireOutOfBudgetContextImages(messages)).toBe(0);
	});

	it("ignores messages without array content", () => {
		const messages = [{ role: "user", content: "plain string" }, { role: "assistant" } as unknown as TestMessage];
		expect(retireOutOfBudgetContextImages(messages)).toBe(0);
	});

	it("hasPendingDurableEntries guards the deferred first flush (durable-safety gate)", () => {
		// File-backed sessions buffer entries (sharing object references with
		// resident state) until the first assistant message triggers the flush.
		// agent_end retirement must skip while entries are buffered, or the
		// eventual flush would serialize placeholders into the durable JSONL.
		const dir = mkdtempSync(join(tmpdir(), "pi-retire-flush-"));
		try {
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			// Even the session header is buffered until the first assistant message.
			expect(manager.hasPendingDurableEntries()).toBe(true);

			const userMessage = imageMessage(2 * MB, "a");
			manager.appendMessage({ role: "user", content: userMessage.content, timestamp: Date.now() } as never);
			// Buffered, not yet on disk: retirement must be skipped here.
			expect(manager.hasPendingDurableEntries()).toBe(true);

			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				timestamp: Date.now(),
			} as never);
			// Flush happened: retirement is durable-safe again, and the flushed
			// JSONL carries the full image payload.
			expect(manager.hasPendingDurableEntries()).toBe(false);
			const sessionFile = manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(readFileSync(sessionFile as string, "utf8")).toContain('"type":"image"');

			// In-memory sessions never persist — the gate must not block retirement.
			expect(SessionManager.inMemory(dir).hasPendingDurableEntries()).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
