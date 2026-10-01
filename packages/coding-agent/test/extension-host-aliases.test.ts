import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { VIRTUAL_MODULES } from "../src/core/extensions/virtual-modules.ts";

const suffixes = ["coding-agent", "agent-core", "tui", "ai", "ai/compat", "ai/oauth", "ai/providers/all"];

describe("upstream-scoped host aliases", () => {
	it.skipIf(process.platform === "win32")("resolves a linked entry’s relative imports beside its target", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-linked-entry-"));
		try {
			const target = path.join(dir, "package");
			fs.mkdirSync(target);
			fs.writeFileSync(path.join(target, "policy.js"), 'export const label = "policy wrapper";');
			fs.writeFileSync(
				path.join(target, "index.js"),
				'import {label} from "./policy.js"; export default (pi) => pi.registerCommand("linked-policy", {description: label, handler: async () => {}});',
			);
			const link = path.join(dir, "linked.js");
			fs.symlinkSync(path.join(target, "index.js"), link);
			const loaded = await loadExtensions([link], dir);
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions[0].commands.get("linked-policy")?.description).toBe("policy wrapper");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	it("uses the exact fork host module objects instead of a second runtime", () => {
		for (const suffix of suffixes) {
			const fork = VIRTUAL_MODULES[`@lue-labs/pi-${suffix}`];
			expect(fork).toBeDefined();
			expect(VIRTUAL_MODULES[`@earendil-works/pi-${suffix}`]).toBe(fork);
		}
	});

	it("loads an external extension importing upstream and fork host namespaces", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-host-aliases-"));
		try {
			const imports = suffixes.map(
				(suffix, i) =>
					`import * as upstream${i} from "@earendil-works/pi-${suffix}";\nimport * as fork${i} from "@lue-labs/pi-${suffix}";`,
			);
			const checks = suffixes.map(
				(_suffix, i) =>
					`for (const key of Object.keys(fork${i})) if (fork${i}[key] !== upstream${i}[key]) throw new Error("split host module: " + key);`,
			);
			const file = path.join(dir, "index.ts");
			fs.writeFileSync(file, `${imports.join("\n")}\nexport default function () {\n${checks.join("\n")}\n}`);
			const loaded = await loadExtensions([file], dir);
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
