import { describe, expect, it } from "vitest";
import {
	boundModelFacingContextImages,
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
});
