import assert from "node:assert";
import { describe, it } from "node:test";
import { Loader } from "../src/components/loader.ts";

describe("Loader motion", () => {
	it("does not create an animation timer for a static indicator", () => {
		const originalSetInterval = globalThis.setInterval;
		let intervalCount = 0;
		globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
			intervalCount++;
			return originalSetInterval(...args);
		}) as typeof setInterval;
		try {
			const loader = new Loader(
				{ requestRender: () => {} } as never,
				(text) => text,
				(text) => text,
				"Working",
				{ frames: ["•"] },
			);
			assert.strictEqual(intervalCount, 0);
			loader.stop();
		} finally {
			globalThis.setInterval = originalSetInterval;
		}
	});
});
