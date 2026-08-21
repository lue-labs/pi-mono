#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(experimentDir, "../..");
const tuiDistDir = join(repoRoot, "packages", "tui", "dist");

function printHelp() {
	console.log(`Usage:
  node experiments/rusty-core-recast/tui-write-volume.mjs [--runs <n>]

Runs a fixed, offline ProcessTerminal/TUI transcript in a temporary pseudo-terminal.
It sets PI_TUI_WRITE_LOG for each run and reports raw ANSI-write volume plus child
CPU and memory metadata. No provider, model, network, or user configuration is used.

Options:
  --runs <n>  Measured repetitions; positive integer (default: 3)
  --help, -h  Show this help

Measurement contract:
  - ansi_bytes is the byte size of PI_TUI_WRITE_LOG for one fixed 80x24 transcript.
  - plain_bytes is the same log after ANSI/OSC control sequences are removed.
  - control_sequences counts CSI and OSC sequences in that log.
  - wall_ms, user_cpu_ms, system_cpu_ms, and peak_rss_bytes come from the child run.
  - Reported medians are over the requested runs; each run uses a fresh temp directory.

Limitations:
  - This measures deterministic rendering and terminal-write overhead only.
  - It is not an interactive provider session, terminal emulator benchmark, or a
    substitute for a 30-minute captain session. CPU samples include Node/tsx startup.
  - macOS's built-in script(1) provides the pseudo-terminal required by ProcessTerminal.
`);
}

function parseArgs(argv) {
	let runs = 3;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg !== "--runs") throw new Error(`Unknown option: ${arg}`);
		const value = argv[++index];
		if (value === undefined) throw new Error("Missing value for --runs");
		runs = Number.parseInt(value, 10);
		if (!Number.isSafeInteger(runs) || runs < 1) throw new Error(`Invalid --runs: ${value}`);
	}
	return { runs };
}

function median(values) {
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fixtureSource() {
	return `import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { ProcessTerminal } from ${JSON.stringify(join(tuiDistDir, "terminal.js"))};
import { Text } from ${JSON.stringify(join(tuiDistDir, "components/text.js"))};
import { TUI } from ${JSON.stringify(join(tuiDistDir, "tui.js"))};

const resultPath = process.argv[2];
const waitForRender = () => new Promise((resolve) => setTimeout(resolve, 30));
const beforeCpu = process.cpuUsage();
const beforeResources = process.resourceUsage();
const startedAt = performance.now();
const tui = new TUI(new ProcessTerminal());
const transcript = new Text("Captain transcript: deterministic TUI write-volume fixture", 1, 0);
tui.addChild(transcript);
tui.start();
await waitForRender();
for (let step = 1; step <= 8; step++) {
	transcript.setText("Captain transcript: deterministic step " + step + "/8");
	tui.requestRender();
	await waitForRender();
}
tui.stop();
const cpu = process.cpuUsage(beforeCpu);
const resources = process.resourceUsage();
writeFileSync(resultPath, JSON.stringify({
	wallMs: performance.now() - startedAt,
	userCpuMs: cpu.user / 1000,
	systemCpuMs: cpu.system / 1000,
	peakRssBytes: resources.maxRSS * 1024,
	minorPageFaults: resources.minorPageFault - beforeResources.minorPageFault,
}));
`;
}

function stripAnsi(value) {
	return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function countControlSequences(value) {
	return (value.match(/\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g) ?? []).length;
}

async function runFixture(run) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-tui-write-volume-"));
	const fixturePath = join(tempDir, "fixture.mjs");
	const logPath = join(tempDir, "ansi.log");
	const resultPath = join(tempDir, "result.json");
	writeFileSync(fixturePath, fixtureSource());

	try {
		const exitCode = await new Promise((resolve, reject) => {
			const child = spawn("script", ["-q", "/dev/null", process.execPath, fixturePath, resultPath], {
				cwd: repoRoot,
				env: { ...process.env, COLUMNS: "80", LINES: "24", PI_TUI_WRITE_LOG: logPath },
				stdio: ["ignore", "ignore", "pipe"],
			});
			let stderr = "";
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.once("error", reject);
			child.once("exit", (code, signal) => {
				if (signal) reject(new Error(`Run ${run} exited from signal ${signal}: ${stderr.trim()}`));
				else if (code !== 0) reject(new Error(`Run ${run} failed with exit code ${code}: ${stderr.trim()}`));
				else resolve(code);
			});
		});
		if (exitCode !== 0 || !existsSync(logPath) || !existsSync(resultPath)) {
			throw new Error(`Run ${run} did not produce both PI_TUI_WRITE_LOG and metadata.`);
		}
		const ansi = readFileSync(logPath, "utf8");
		const metadata = JSON.parse(readFileSync(resultPath, "utf8"));
		return {
			ansiBytes: statSync(logPath).size,
			plainBytes: Buffer.byteLength(stripAnsi(ansi)),
			controlSequences: countControlSequences(ansi),
			...metadata,
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return printHelp();
	if (!existsSync(join(tuiDistDir, "terminal.js"))) throw new Error(`Missing built TUI entrypoint: ${tuiDistDir}`);

	const results = [];
	for (let run = 1; run <= options.runs; run++) {
		const result = await runFixture(run);
		results.push(result);
		console.log(`run=${run} ansi_bytes=${result.ansiBytes} wall_ms=${result.wallMs.toFixed(1)} user_cpu_ms=${result.userCpuMs.toFixed(1)}`);
	}

	for (const metric of ["ansiBytes", "plainBytes", "controlSequences", "wallMs", "userCpuMs", "systemCpuMs", "peakRssBytes", "minorPageFaults"]) {
		const value = median(results.map((result) => result[metric]));
		const name = metric.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
		console.log(`METRIC ${name}=${Number.isInteger(value) ? value : value.toFixed(1)}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
