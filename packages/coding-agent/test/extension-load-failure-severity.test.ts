/**
 * A repo-local extension that fails to load must not stop pi from starting.
 *
 * Regression cover for the incident where two dev conveniences in
 * `.pi/extensions/` (importing a workspace package that was not built yet) made
 * the repo unhostable: pi exited 1 before reaching a prompt. See
 * docs/worktree-bootstrap.md.
 *
 * The correctness answer being pinned here is the *split*: auto-discovered
 * failures are skipped, explicitly requested ones stay fatal.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extensionLoadDiagnostic,
	STRICT_EXTENSIONS_ENV,
	strictExtensionsEnabled,
} from "../src/core/extensions/load-diagnostics.ts";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

// Imports a module that does not exist, reproducing the original failure shape
// ("Cannot find module ...") without needing an unbuilt workspace.
const BROKEN_EXTENSION = `
	import { nothing } from "@valkyriweb/pi-module-that-does-not-exist";
	export default function (pi) {
		void nothing;
	}
`;

const WORKING_EXTENSION = `
	export default function (pi) {
		pi.registerCommand("ok", { handler: async () => {} });
	}
`;

describe("extension load failure severity", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `ext-sev-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("loader marks where the extension came from", () => {
		it("marks a failure from a scanned extensions dir as discovered", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "broken.ts"), BROKEN_EXTENSION);

			const result = await discoverAndLoadExtensions([], cwd, agentDir);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].discovered).toBe(true);
			// Message quality is preserved: the underlying resolution error survives.
			expect(result.errors[0].error).toContain("Cannot find module");
		});

		it("does not mark a failure from an explicitly named file as discovered", async () => {
			const explicitDir = join(tempDir, "explicit");
			mkdirSync(explicitDir, { recursive: true });
			const explicitPath = join(explicitDir, "broken.ts");
			writeFileSync(explicitPath, BROKEN_EXTENSION);

			const result = await discoverAndLoadExtensions([explicitPath], cwd, agentDir);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].discovered).toBeFalsy();
		});

		it("keeps loading the remaining discovered extensions after one fails", async () => {
			const extDir = join(agentDir, "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "broken.ts"), BROKEN_EXTENSION);
			writeFileSync(join(extDir, "working.ts"), WORKING_EXTENSION);

			const result = await discoverAndLoadExtensions([], cwd, agentDir);

			expect(result.errors).toHaveLength(1);
			expect(result.extensions).toHaveLength(1);
		});
	});

	describe("resource loader (the path the CLI actually uses)", () => {
		it("marks a broken repo-local .pi/extensions file as discovered", async () => {
			const extDir = join(cwd, ".pi", "extensions");
			mkdirSync(extDir, { recursive: true });
			writeFileSync(join(extDir, "broken.ts"), BROKEN_EXTENSION);

			const loader = new DefaultResourceLoader({ cwd, agentDir });
			await loader.reload();

			const errors = loader.getExtensions().errors;
			expect(errors).toHaveLength(1);
			expect(errors[0].discovered).toBe(true);
		});

		it("keeps a `-e <path>` extension fatal", async () => {
			const explicitDir = join(tempDir, "explicit");
			mkdirSync(explicitDir, { recursive: true });
			const explicitPath = join(explicitDir, "broken.ts");
			writeFileSync(explicitPath, BROKEN_EXTENSION);

			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [explicitPath] });
			await loader.reload();

			const errors = loader.getExtensions().errors;
			expect(errors).toHaveLength(1);
			expect(errors[0].discovered).toBeFalsy();
		});

		it("stays explicit when the same file is both discovered and named with -e", async () => {
			const extDir = join(cwd, ".pi", "extensions");
			mkdirSync(extDir, { recursive: true });
			const extPath = join(extDir, "broken.ts");
			writeFileSync(extPath, BROKEN_EXTENSION);

			const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: [extPath] });
			await loader.reload();

			const errors = loader.getExtensions().errors;
			expect(errors).toHaveLength(1);
			expect(errors[0].discovered).toBeFalsy();
		});
	});

	describe("severity mapping", () => {
		const env = {} as NodeJS.ProcessEnv;

		it("downgrades a discovered failure to a visible warning", () => {
			const diagnostic = extensionLoadDiagnostic(
				{
					path: "/repo/.pi/extensions/redraws.ts",
					error: "Cannot find module '@valkyriweb/pi-tui'",
					discovered: true,
				},
				env,
			);

			expect(diagnostic.type).toBe("warning");
			// Non-fatal must not mean invisible: path and cause both survive.
			expect(diagnostic.message).toContain("/repo/.pi/extensions/redraws.ts");
			expect(diagnostic.message).toContain("Cannot find module '@valkyriweb/pi-tui'");
			expect(diagnostic.message).toContain("Skipped extension");
		});

		it("keeps an explicitly requested failure fatal", () => {
			const diagnostic = extensionLoadDiagnostic({ path: "/tmp/thing.ts", error: "Cannot find module 'nope'" }, env);

			expect(diagnostic.type).toBe("error");
			expect(diagnostic.message).toContain("Failed to load extension");
		});

		it("makes discovered failures fatal again under the strict opt-in", () => {
			const strictEnv = { [STRICT_EXTENSIONS_ENV]: "1" } as NodeJS.ProcessEnv;

			expect(strictExtensionsEnabled(strictEnv)).toBe(true);
			expect(
				extensionLoadDiagnostic({ path: "/repo/.pi/extensions/x.ts", error: "boom", discovered: true }, strictEnv)
					.type,
			).toBe("error");
		});

		it("treats an unset or falsy strict flag as non-strict", () => {
			expect(strictExtensionsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
			expect(strictExtensionsEnabled({ [STRICT_EXTENSIONS_ENV]: "0" } as NodeJS.ProcessEnv)).toBe(false);
			expect(strictExtensionsEnabled({ [STRICT_EXTENSIONS_ENV]: "" } as NodeJS.ProcessEnv)).toBe(false);
		});
	});
});
