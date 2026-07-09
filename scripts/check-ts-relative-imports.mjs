import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// TS7 stable ships no programmatic compiler API until 7.1. This checker parses
// with oxc-parser (the same Rust TS parser oxlint uses) instead of the TS
// compiler API, so the toolchain needs only native `typescript@7` — avoiding
// the TS6-API alias whose transitive `tsc` bin shadows native tsc@7 under npm.
import { parseSync } from "oxc-parser";

const ignoredDirectories = new Set([".git", "coverage", "dist", "node_modules"]);
const files = [];

function collectTypescriptFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) collectTypescriptFiles(join(directory, entry.name));
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			files.push(join(directory, entry.name));
		}
	}
}

function isRelativeJavaScriptSpecifier(specifier) {
	return /^\.\.?\//.test(specifier) && /\.js(?:[?#].*)?$/.test(specifier);
}

// Precompute line-start offsets so a node's start offset maps to line:column
// (both 1-based, matching the previous ts.getLineAndCharacterOfPosition output).
function makeLineLookup(source) {
	const lineStarts = [0];
	for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
	return (offset) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
	};
}

const failures = [];
const parseErrors = [];

collectTypescriptFiles(".");

for (const file of files.sort()) {
	const sourceText = readFileSync(file, "utf8");
	const result = parseSync(file, sourceText);
	if (result.errors && result.errors.length > 0) {
		parseErrors.push(`${file}: ${result.errors[0].message ?? "parse error"}`);
		continue;
	}
	const locate = makeLineLookup(sourceText);

	const check = (literal) => {
		if (!literal || typeof literal.value !== "string") return;
		if (!isRelativeJavaScriptSpecifier(literal.value)) return;
		const { line, column } = locate(literal.start);
		failures.push(`${file}:${line}:${column}: ${literal.value}`);
	};

	// oxc exposes the module specifier under `source` for import/export/dynamic
	// import AND for `import("x")` type nodes (TSImportType), so one branch covers all.
	const specifierBearingTypes = new Set([
		"ImportDeclaration",
		"ExportNamedDeclaration",
		"ExportAllDeclaration",
		"ImportExpression",
		"TSImportType",
	]);

	const visit = (node) => {
		if (!node || typeof node.type !== "string") return;
		if (specifierBearingTypes.has(node.type) && node.source) check(node.source);
		for (const key in node) {
			if (key === "start" || key === "end" || key === "range" || key === "loc" || key === "parent") continue;
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) if (child && typeof child.type === "string") visit(child);
			} else if (value && typeof value.type === "string") {
				visit(value);
			}
		}
	};

	visit(result.program);
}

if (parseErrors.length > 0) {
	console.error("Failed to parse .ts files (oxc-parser):");
	for (const error of parseErrors) console.error(`  ${error}`);
	process.exit(1);
}

if (failures.length > 0) {
	console.error("Relative .js imports are not allowed in non-declaration .ts files:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
