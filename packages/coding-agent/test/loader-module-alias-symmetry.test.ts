import { describe, expect, it } from "vitest";
import { getExtensionModuleSpecifiersForTests } from "../src/core/extensions/loader.ts";

// The extension module resolver registers the same packages twice: once in
// `VIRTUAL_MODULES` (used by the compiled Bun binary) and once in `getAliases()`
// (used by Node/dev via jiti). The two paths MUST register an identical specifier
// set — if a package or subpath is present in one but missing from the other, an
// extension that imports it resolves in one runtime and throws `Cannot find
// module` in the other.
//
// Regression guard: the 0.80.x model-runtime migration split the deprecated
// global-dispatch surface into a `/compat` subpath and registered it for the
// upstream scopes, but omitted `@lue-labs/pi-ai/compat` from the fork scope in
// BOTH maps. That broke advisor / session-title / idle-return /
// native-tool-overrides in the compiled daily-driver binary (twice) while every
// static check (tsgo, build-gate) stayed green — only a compiled-binary boot
// reproduced it. This test makes the map drift itself fail fast.

const { virtualModules, aliases } = getExtensionModuleSpecifiersForTests();

// Current fork scope, legacy fork scope, and the two upstream scopes bridged
// for third-party extensions.
const SCOPES = ["@lue-labs", "@valkyriweb", "@earendil-works", "@mariozechner"] as const;

// Every scope must expose the pi-ai root, its /compat + /oauth subpaths, and the
// sibling fork packages.
const PER_SCOPE_PACKAGES = [
	"pi-ai",
	"pi-ai/compat",
	"pi-ai/oauth",
	"pi-agent-core",
	"pi-tui",
	"pi-coding-agent",
] as const;

describe("extension module resolver alias symmetry", () => {
	it("registers an identical specifier set in both resolution paths", () => {
		// Sorted, de-duplicated comparison: order-independent and dedup-safe. A
		// specifier added to (or removed from) only one map fails here.
		const fromBinary = [...new Set(virtualModules)].sort();
		const fromNode = [...new Set(aliases)].sort();
		expect(fromBinary).toEqual(fromNode);
	});

	const binarySpecs = new Set(virtualModules);
	const nodeSpecs = new Set(aliases);

	for (const scope of SCOPES) {
		for (const pkg of PER_SCOPE_PACKAGES) {
			const spec = `${scope}/${pkg}`;
			it(`exposes ${spec} to the compiled binary (VIRTUAL_MODULES)`, () => {
				expect(binarySpecs.has(spec)).toBe(true);
			});
			it(`exposes ${spec} to Node/dev (jiti aliases)`, () => {
				expect(nodeSpecs.has(spec)).toBe(true);
			});
		}
	}

	it("guards the fork-scope /compat subpath that broke the 0.80.x binary", () => {
		// The exact specifier whose absence from VIRTUAL_MODULES broke the daily driver.
		expect(binarySpecs.has("@lue-labs/pi-ai/compat")).toBe(true);
		expect(nodeSpecs.has("@lue-labs/pi-ai/compat")).toBe(true);
	});
});
