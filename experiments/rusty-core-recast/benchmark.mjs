import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { metadataForSessionLine, readSessionFileLines } from "../../packages/coding-agent/dist/core/session-resident-prune.js";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const typescriptSourcePath = resolve(experimentDir, "../../packages/coding-agent/src/core/session-resident-prune.ts");
const typescriptBuildPath = resolve(experimentDir, "../../packages/coding-agent/dist/core/session-resident-prune.js");
const fixtureDir = mkdtempSync(join(tmpdir(), "rusty-core-recast-"));
const fixturePath = join(fixtureDir, "captain-session.jsonl");
const rustBinary = join(experimentDir, "target", "release", "rusty-core-recast");
const samples = 9;
const warmups = 3;

function parseArgs(argv) {
	const options = { heapProfile: false, reportPath: undefined };
	for (let index = 0; index < argv.length; index++) {
		if (argv[index] === "--heap-profile") {
			options.heapProfile = true;
			continue;
		}
		if (argv[index] !== "--report") throw new Error(`Unknown argument: ${argv[index]}`);
		options.reportPath = resolve(argv[++index] ?? "");
	}
	return options;
}

function percentile(values, fraction) {
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction));
	return sorted[index];
}

function summary(values) {
	return {
		min: Math.min(...values),
		median: percentile(values, 0.5),
		max: Math.max(...values),
	};
}

function assertTypeScriptBuildIsFresh() {
	if (statSync(typescriptBuildPath).mtimeMs < statSync(typescriptSourcePath).mtimeMs) {
		throw new Error("Build packages/coding-agent before running this benchmark.");
	}
}

function generateFixture() {
	const entries = [{ type: "session", version: 3, id: "captain-session", timestamp: "2026-07-29T20:00:00.000Z", cwd: "/repo" }];
	const output = "result ".repeat(1024);
	for (let turn = 0; turn < 1_200; turn++) {
		entries.push({
			type: "message",
			id: `user-${turn}`,
			parentId: turn === 0 ? null : `tool-${turn - 1}`,
			timestamp: "2026-07-29T20:00:00.000Z",
			message: { role: "user", content: `Captain request ${turn}` },
		});
		entries.push({
			type: "message",
			id: `assistant-${turn}`,
			parentId: `user-${turn}`,
			timestamp: "2026-07-29T20:00:00.000Z",
			message: {
				role: "assistant",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				content: [{ type: "toolCall", id: `call-${turn}`, name: "bash", arguments: { command: "git status" } }],
			},
		});
		entries.push({
			type: "message",
			id: `tool-${turn}`,
			parentId: `assistant-${turn}`,
			timestamp: "2026-07-29T20:00:00.000Z",
			message: { role: "toolResult", toolCallId: `call-${turn}`, toolName: "bash", content: output, isError: false },
		});
		if (turn > 0 && turn % 300 === 0) {
			entries.push({
				type: "compaction",
				id: `compaction-${turn}`,
				parentId: `tool-${turn}`,
				timestamp: "2026-07-29T20:00:00.000Z",
				firstKeptEntryId: `user-${turn - 40}`,
				tokensBefore: 150_000,
				summary: "Compacted captain session.",
			});
		}
	}
	writeFileSync(fixturePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function scanTypeScript(path) {
	const stats = { bytes: statSync(path).size, entries: 0, messages: 0, toolResults: 0, compactions: 0 };
	readSessionFileLines(path, (line) => {
		const metadata = metadataForSessionLine(line);
		if (!metadata || metadata === "session") return;
		stats.entries++;
		if (metadata.type === "message") {
			stats.messages++;
			if (metadata.messageRole === "toolResult") stats.toolResults++;
		} else if (metadata.type === "compaction") {
			stats.compactions++;
		}
	});
	return stats;
}

function scanRust(path) {
	const result = spawnSync(rustBinary, ["--stats", path], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || "Rust scanner failed");
	return JSON.parse(result.stdout);
}

function benchmark(scan) {
	for (let index = 0; index < warmups; index++) scan(fixturePath);
	const elapsed = [];
	let result;
	for (let index = 0; index < samples; index++) {
		const startedAt = performance.now();
		result = scan(fixturePath);
		elapsed.push(performance.now() - startedAt);
	}
	return { result, timings: summary(elapsed), samples: elapsed };
}

function measureTypeScriptHeap() {
	if (typeof global.gc !== "function") throw new Error("--heap-profile requires node --expose-gc");
	global.gc();
	const before = process.memoryUsage();
	let peakHeapUsed = before.heapUsed;
	let peakRss = before.rss;
	for (let index = 0; index < 50; index++) {
		scanTypeScript(fixturePath);
		const usage = process.memoryUsage();
		peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
		peakRss = Math.max(peakRss, usage.rss);
	}
	global.gc();
	const after = process.memoryUsage();
	return {
		peakHeapGrowth: peakHeapUsed - before.heapUsed,
		peakRssGrowth: peakRss - before.rss,
		retainedHeapGrowth: after.heapUsed - before.heapUsed,
	};
}

function formatMiB(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function sameStats(left, right) {
	return Object.keys(left).every((key) => left[key] === right[key]);
}

function formatMs(value) {
	return value.toFixed(2);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	assertTypeScriptBuildIsFresh();
	generateFixture();
	execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: experimentDir, stdio: "inherit" });
	const typescript = benchmark(scanTypeScript);
	const rust = benchmark(scanRust);
	if (!sameStats(typescript.result, rust.result)) {
		throw new Error(`Scanner mismatch: TS=${JSON.stringify(typescript.result)} Rust=${JSON.stringify(rust.result)}`);
	}
	const bytes = statSync(fixturePath).size;
	const heap = options.heapProfile ? measureTypeScriptHeap() : undefined;
	const speedup = typescript.timings.median / rust.timings.median;
	const rustVersion = execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim();
	const report = `# Rusty core recast prototype benchmark

- Fixture: generated captain-style JSONL, ${typescript.result.entries.toLocaleString()} entries, ${(bytes / 1024 / 1024).toFixed(1)} MiB.
- Contract exercised: scan a session JSONL and return entry/message/tool-result/compaction counts.
- Production TypeScript scanner and Rust prototype returned identical counters.
- Environment: ${process.version}; ${rustVersion}; ${process.platform}/${process.arch}.
- Measurement: ${warmups} warmups, ${samples} end-to-end samples. Rust timing includes process startup and JSON output parsing; it is a conservative sidecar comparison.
- Raw samples: TypeScript [${typescript.samples.map(formatMs).join(", ")}]; Rust [${rust.samples.map(formatMs).join(", ")}].
${heap ? `- TypeScript scanner heap over 50 sequential scans: observed heap +${formatMiB(heap.peakHeapGrowth)}, observed RSS +${formatMiB(heap.peakRssGrowth)}, retained heap after forced GC ${formatMiB(heap.retainedHeapGrowth)}.` : ""}

| implementation | min ms | median ms | max ms |
| --- | ---: | ---: | ---: |
| TypeScript \`readSessionFileLines\` + \`metadataForSessionLine\` | ${formatMs(typescript.timings.min)} | ${formatMs(typescript.timings.median)} | ${formatMs(typescript.timings.max)} |
| Rust sidecar scanner | ${formatMs(rust.timings.min)} | ${formatMs(rust.timings.median)} | ${formatMs(rust.timings.max)} |

Rust sidecar median speedup: ${speedup.toFixed(2)}x.

This is a scanner probe, not evidence that \`buildResidentLoadPrunePlan()\` has a native equivalent. The prototype validates JSON with \`serde_json\`, but can allocate one physical JSONL line. The production candidate must preserve the existing session metadata and prune-plan semantics, use an addon or long-lived worker to avoid per-call spawn cost, and pass shared corpus parity tests before any replacement.
`;
	process.stdout.write(report);
	if (options.reportPath) {
		mkdirSync(resolve(options.reportPath, ".."), { recursive: true });
		writeFileSync(options.reportPath, report);
	}
}

try {
	main();
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}
