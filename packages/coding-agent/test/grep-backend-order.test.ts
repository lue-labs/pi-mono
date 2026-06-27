import { beforeEach, describe, expect, it, vi } from "vitest";

const toolMocks = vi.hoisted(() => ({
	ensureTool: vi.fn(),
	getOptionalSearchToolPath: vi.fn(),
}));

vi.mock("../src/utils/tools-manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/tools-manager.ts")>();
	return {
		...actual,
		ensureTool: toolMocks.ensureTool,
		getOptionalSearchToolPath: toolMocks.getOptionalSearchToolPath,
	};
});

const { resolveGrepBackend } = await import("../src/core/tools/grep.ts");

describe("grep backend selection", () => {
	beforeEach(() => {
		toolMocks.ensureTool.mockReset();
		toolMocks.getOptionalSearchToolPath.mockReset();
	});

	it("prefers managed ripgrep over optional ugrep", async () => {
		toolMocks.ensureTool.mockResolvedValue("/managed/rg");
		toolMocks.getOptionalSearchToolPath.mockReturnValue("/managed/ugrep");

		const backend = await resolveGrepBackend({ pattern: "needle", searchPath: "/repo" });

		expect(backend?.backend).toBe("rg");
		expect(backend?.command).toBe("/managed/rg");
		expect(backend?.args).toEqual(expect.arrayContaining(["--json", "needle", "/repo"]));
		expect(toolMocks.ensureTool).toHaveBeenCalledWith("rg", true);
		expect(toolMocks.getOptionalSearchToolPath).not.toHaveBeenCalled();
	});

	it("falls back to ugrep when ripgrep is unavailable", async () => {
		toolMocks.ensureTool.mockResolvedValue(null);
		toolMocks.getOptionalSearchToolPath.mockReturnValue("/managed/ugrep");

		const backend = await resolveGrepBackend({ pattern: "needle", searchPath: "/repo" });

		expect(backend?.backend).toBe("ugrep");
		expect(backend?.command).toBe("/managed/ugrep");
		expect(backend?.args).toEqual(expect.arrayContaining(["--no-config", "needle", "/repo"]));
		expect(toolMocks.getOptionalSearchToolPath).toHaveBeenCalledWith("ugrep");
	});

	it("does not use ugrep for type-filtered searches", async () => {
		toolMocks.ensureTool.mockResolvedValue(null);
		toolMocks.getOptionalSearchToolPath.mockReturnValue("/managed/ugrep");

		const backend = await resolveGrepBackend({ pattern: "needle", searchPath: "/repo", type: "ts" });

		expect(backend).toBeUndefined();
		expect(toolMocks.getOptionalSearchToolPath).not.toHaveBeenCalled();
	});
});
