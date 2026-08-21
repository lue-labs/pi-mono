import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	clearConfigValueCache,
	resolveConfigValue,
	resolveConfigValueUncached,
} from "../src/core/resolve-config-value.ts";
import * as shellModule from "../src/utils/shell.ts";

// Override execSync per-test to simulate transient spawn failures. Defaults to
// the real implementation so unrelated command tests keep working.
const { execSyncMock } = vi.hoisted(() => ({ execSyncMock: { impl: null as ((cmd: string) => string) | null } }));
vi.mock("child_process", async (importActual) => {
	const actual = await importActual<typeof import("child_process")>();
	return {
		...actual,
		execSync: (command: string, options?: unknown) =>
			execSyncMock.impl ? execSyncMock.impl(command) : actual.execSync(command, options as never),
	};
});

describe("resolveConfigValue", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-config-value-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
		execSyncMock.impl = null;
		vi.restoreAllMocks();
	});

	test("resolves literals, environment templates, and escapes", () => {
		process.env.TEST_CONFIG_LEFT = "left";
		process.env.TEST_CONFIG_RIGHT = "right";
		try {
			expect(resolveConfigValue("literal-key")).toBe("literal-key");
			expect(resolveConfigValue("$TEST_CONFIG_LEFT")).toBe("left");
			expect(resolveConfigValue("$" + "{TEST_CONFIG_LEFT}_$TEST_CONFIG_RIGHT")).toBe("left_right");
			expect(resolveConfigValue("$$TEST_CONFIG_LEFT")).toBe("$TEST_CONFIG_LEFT");
			expect(resolveConfigValue("$!literal-$TEST_CONFIG_RIGHT")).toBe("!literal-right");
		} finally {
			delete process.env.TEST_CONFIG_LEFT;
			delete process.env.TEST_CONFIG_RIGHT;
		}
	});

	test("uses credential-scoped environment before process.env", () => {
		process.env.TEST_CONFIG_SCOPED = "process";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_SCOPED", { TEST_CONFIG_SCOPED: "credential" })).toBe("credential");
		} finally {
			delete process.env.TEST_CONFIG_SCOPED;
		}
	});

	test("executes shell commands and trims their output", () => {
		expect(resolveConfigValue("!echo '  spaced-key  '")).toBe("spaced-key");
		expect(resolveConfigValue("!printf 'line1\\nline2'")).toBe("line1\nline2");
		expect(resolveConfigValue("!echo 'hello world' | tr ' ' '-'")).toBe("hello-world");
	});

	test.each(["!exit 1", "!nonexistent-command-12345", "!printf ''"])(
		"returns undefined when command resolution fails: %s",
		(command) => {
			expect(resolveConfigValue(command)).toBeUndefined();
		},
	);

	test("caches successful and failed commands until explicitly cleared", () => {
		const counterFile = join(tempDir, "counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const success = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;

		expect(resolveConfigValue(success)).toBe("value");
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");

		clearConfigValueCache();
		expect(resolveConfigValue(success)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");

		const failure = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; exit 1'`;
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(resolveConfigValue(failure)).toBeUndefined();
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("3");
	});

	test("does not cache environment values", () => {
		process.env.TEST_CONFIG_DYNAMIC = "first";
		try {
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("first");
			process.env.TEST_CONFIG_DYNAMIC = "second";
			expect(resolveConfigValue("$TEST_CONFIG_DYNAMIC")).toBe("second");
		} finally {
			delete process.env.TEST_CONFIG_DYNAMIC;
		}
	});

	test("uncached resolution executes a command on every call", () => {
		const counterFile = join(tempDir, "uncached-counter");
		writeFileSync(counterFile, "0");
		const escapedPath = counterFile.replace(/\\/g, "/").replace(/"/g, '\\"');
		const command = `!sh -c 'count=$(cat "${escapedPath}"); echo $((count + 1)) > "${escapedPath}"; echo value'`;
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(resolveConfigValueUncached(command)).toBe("value");
		expect(readFileSync(counterFile, "utf-8").trim()).toBe("2");
	});

	test("recovers from a one-shot transient spawn failure via retry (#171)", () => {
		if (process.platform === "win32") return;
		let call = 0;
		execSyncMock.impl = () => {
			call++;
			if (call === 1) {
				const error = new Error("spawn /bin/sh EAGAIN") as NodeJS.ErrnoException;
				error.code = "EAGAIN"; // spawn-level failure: process never ran, no status/signal
				throw error;
			}
			return "recovered-key\n";
		};
		expect(resolveConfigValueUncached("!cat /some/api.key")).toBe("recovered-key");
		expect(call).toBe(2);
	});

	test("falls back to last-known-good cache on persistent transient failure (#171)", () => {
		if (process.platform === "win32") return;
		expect(resolveConfigValueUncached("!echo good-key")).toBe("good-key"); // seeds last-known-good
		let call = 0;
		execSyncMock.impl = () => {
			call++;
			const error = new Error("spawn /bin/sh EAGAIN") as NodeJS.ErrnoException;
			error.code = "EAGAIN";
			throw error;
		};
		expect(resolveConfigValueUncached("!echo good-key")).toBe("good-key"); // served from cache
		expect(call).toBe(2); // one attempt + one retry
	});

	test("does not retry or serve cache when the command definitively fails (#171)", () => {
		if (process.platform === "win32") return;
		expect(resolveConfigValueUncached("!echo seeded")).toBe("seeded");
		let call = 0;
		execSyncMock.impl = () => {
			call++;
			const error = new Error("Command failed: exit 1") as NodeJS.ErrnoException & { status: number };
			error.status = 1; // process ran and exited non-zero: definitive failure
			throw error;
		};
		expect(resolveConfigValueUncached("!echo seeded")).toBeUndefined();
		expect(call).toBe(1); // no retry on a definitive failure
	});

	test("uses stdin when the configured Windows shell requires it", () => {
		if (process.platform === "win32") return;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-s"],
			commandTransport: "stdin",
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			const expansion = "$" + "{name}";
			expect(resolveConfigValueUncached(`!name='World'; echo "Hello, ${expansion}!"`)).toBe("Hello, World!");
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});
});
