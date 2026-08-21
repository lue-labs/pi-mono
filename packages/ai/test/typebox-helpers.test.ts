import type { Static } from "typebox";
import { describe, expect, expectTypeOf, it } from "vitest";
import { StringEnum } from "../src/utils/typebox-helpers.ts";

describe("StringEnum", () => {
	it("preserves string literal unions for bare array literals (Static)", () => {
		const s = StringEnum(["add", "subtract", "multiply", "divide"], {
			description: "The operation to perform",
		});
		expectTypeOf<Static<typeof s>>().toEqualTypeOf<"add" | "subtract" | "multiply" | "divide">();
	});

	it("preserves string literal unions for `as const` arrays (Static)", () => {
		const s = StringEnum(["tail", "head", "all"] as const);
		expectTypeOf<Static<typeof s>>().toEqualTypeOf<"tail" | "head" | "all">();
	});

	it("keeps `string` for non-literal string[] values (backward compatible)", () => {
		const values: string[] = ["a", "b"];
		const s = StringEnum(values);
		expectTypeOf<Static<typeof s>>().toEqualTypeOf<string>();
	});

	it("serializes to { type: 'string', enum } with optional description", () => {
		expect(StringEnum(["a", "b"])).toEqual({ type: "string", enum: ["a", "b"] });
		expect(StringEnum(["a", "b"], { description: "Pick one", default: "a" })).toEqual({
			type: "string",
			enum: ["a", "b"],
			description: "Pick one",
			default: "a",
		});
	});
});
