/**
 * Emits one row per anti-slop finding in fork-added source, with the source
 * line, so dispositions can be argued per finding instead of per rule class.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// oxlint exits non-zero whenever it reports findings, which is the normal
// case here, so read stdout off the thrown result rather than treating a
// non-zero status as a failure.
let stdout = "";
try {
	stdout = execFileSync("node", ["scripts/lint-slop-fork-delta.mjs"], {
		encoding: "utf8",
		maxBuffer: 1024 * 1024 * 256,
		stdio: ["ignore", "pipe", "ignore"],
	});
} catch (error) {
	stdout = typeof error.stdout === "string" ? error.stdout : "";
	if (!stdout) throw error;
}
const raw = stdout.split("\n");

const seen = new Set();
const rows = [];
for (const line of raw) {
	const m = line.match(/^(\S+?):(\d+):(\d+): error anti-slop\(([^)]+)\)/);
	if (!m) continue;
	const [, file, lineNo, , rule] = m;
	const key = `${file}:${lineNo}:${rule}`;
	if (seen.has(key)) continue;
	seen.add(key);
	rows.push({ file, line: Number(lineNo), rule });
}

const cache = new Map();
const srcLine = (file, n) => {
	if (!cache.has(file)) cache.set(file, readFileSync(file, "utf8").split("\n"));
	return (cache.get(file)[n - 1] ?? "").trim();
};

const isTest = (f) => /(^|\/)test\//.test(f) || f.endsWith(".test.ts");
const out = rows.map((r) => ({ ...r, test: isTest(r.file), code: srcLine(r.file, r.line) }));
out.sort((a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);
process.stdout.write(JSON.stringify(out, null, "\t"));
