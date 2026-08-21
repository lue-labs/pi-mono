#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(experimentDir, "../..");
const cliPath = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
const artifactsDir = join(experimentDir, ".artifacts");

function printHelp() {
	console.log(`Usage:
  node experiments/rusty-core-recast/controlled-tui-trace.mjs --prompt <text> [options]
  node experiments/rusty-core-recast/controlled-tui-trace.mjs --dry-run

Launches the existing built Pi CLI in a detached tmux session, submits one prompt,
and preserves a controlled trace under experiments/rusty-core-recast/.artifacts/.

WARNING: --prompt sends a real request to the configured provider. It can consume
provider quota and transmit the prompt. --dry-run never launches Pi or contacts a provider.

Options:
  --prompt <text>  Required for a live run; sent once after the TUI starts
  --provider <id>  Provider passed directly to Pi for a live run
  --model <id>     Model passed directly to Pi for a live run
  --wait-ms <n>    Time to leave the TUI running after submission (default: 30000)
  --dry-run        Validate tmux, built dist, and artifact setup without launching Pi
  --help, -h       Show this help

Artifacts:
  prompt.txt              Exact submitted prompt
  tui-write.log           PI_TUI_WRITE_LOG output
  node.cpuprofile         Node CPU profile
  pane-transcript.txt     tmux pane capture after the measurement window
  resource.txt            macOS /usr/bin/time -l child resource report
  metadata.json           Elapsed time and artifact sizes

Limitations:
  - The fixed wait window does not prove that a provider response completed.
  - Pane capture records tmux's visible scrollback, not all TUI writes; use tui-write.log
    for terminal output volume.
  - /usr/bin/time reports the Pi child as a whole; CPU profiles include startup and shutdown.
  - The trace uses a fresh session directory but the normal Pi configuration so configured
    providers and extensions remain available.
`);
}

function parsePositiveInteger(value, flag) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${flag}: ${value}`);
	return parsed;
}

function parseArgs(argv) {
	const options = { dryRun: false, prompt: undefined, provider: undefined, model: undefined, waitMs: 30_000 };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--prompt" || arg === "--provider" || arg === "--model" || arg === "--wait-ms") {
			const value = argv[++index];
			if (value === undefined) throw new Error(`Missing value for ${arg}`);
			if (arg === "--prompt") options.prompt = value;
			else if (arg === "--provider") options.provider = value;
			else if (arg === "--model") options.model = value;
			else options.waitMs = parsePositiveInteger(value, arg);
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function run(command, args, options = {}) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(command, args, { cwd: repoRoot, ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
	});
}

async function requireCommand(command, args = ["-V"]) {
	const result = await run(command, args);
	if (result.code !== 0 || result.signal) throw new Error(`${command} is unavailable: ${result.stderr.trim() || result.signal || result.code}`);
	return result.stdout.trim();
}

function makeArtifactDir() {
	mkdirSync(artifactsDir, { recursive: true });
	return mkdtempSync(join(artifactsDir, "controlled-tui-trace-"));
}

function delay(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForInitialRender(logPath, timeoutMs) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (existsSync(logPath) && statSync(logPath).size >= 1_024) return;
		await delay(100);
	}
	const output = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
	throw new Error(`Pi did not render an initial TUI frame: ${output.slice(-500)}`);
}

async function waitForSessionExit(sessionName, timeoutMs) {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		const result = await run("tmux", ["has-session", "-t", sessionName]);
		if (result.code !== 0) return;
		await delay(100);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return printHelp();
	if (!existsSync(cliPath)) throw new Error(`Missing built Pi CLI: ${cliPath}`);
	const tmuxVersion = await requireCommand("tmux");
	const probeDir = makeArtifactDir();

	if (options.dryRun) {
		rmSync(probeDir, { recursive: true, force: true });
		console.log(`dry-run: built CLI found: ${cliPath}`);
		console.log(`dry-run: ${tmuxVersion}`);
		console.log(`dry-run: artifact root is writable: ${artifactsDir}`);
		console.log("dry-run: Pi was not launched; no provider request was sent.");
		return;
	}
	if (options.prompt === undefined || options.prompt.length === 0) {
		rmSync(probeDir, { recursive: true, force: true });
		throw new Error("A non-empty --prompt is required for a live run because it sends a provider request.");
	}

	const traceDir = probeDir;
	const promptPath = join(traceDir, "prompt.txt");
	const tuiWriteLog = join(traceDir, "tui-write.log");
	const cpuProfile = join(traceDir, "node.cpuprofile");
	const resourcePath = join(traceDir, "resource.txt");
	const transcriptPath = join(traceDir, "pane-transcript.txt");
	const metadataPath = join(traceDir, "metadata.json");
	const sessionRoot = mkdtempSync(join(tmpdir(), "pi-controlled-tui-session-"));
	const sessionDir = join(sessionRoot, "sessions");
	mkdirSync(sessionDir);
	writeFileSync(promptPath, options.prompt);

	const sessionName = `pi-trace-${process.pid}-${Date.now()}`;
	const bufferName = `${sessionName}-prompt`;
	const traceEnv = [
		"-u", "PI_SESSION_FILE",
		"-u", "PI_SESSION_ID",
		"-u", "PI_SESSION_WORKTREE_ACTIVE",
		"-u", "PI_SESSION_WORKTREE_BASE",
		"-u", "PI_SESSION_WORKTREE_BRANCH",
		`PI_TUI_WRITE_LOG=${tuiWriteLog}`,
		"PI_SKIP_VERSION_CHECK=1",
		"COLUMNS=120",
		"LINES=40",
	];
	const startedAt = performance.now();
	let sessionStarted = false;

	try {
		const start = await run("tmux", [
			"new-session", "-d", "-s", sessionName, "-x", "120", "-y", "40", "-c", repoRoot, "--",
			"/usr/bin/env", ...traceEnv,
			"/usr/bin/time", "-l", "-o", resourcePath, process.execPath,
			"--cpu-prof", `--cpu-prof-dir=${traceDir}`, `--cpu-prof-name=${basename(cpuProfile)}`, cliPath,
			"--approve", "--session-dir", sessionDir,
			...(options.provider ? ["--provider", options.provider] : []),
			...(options.model ? ["--model", options.model] : []),
		]);
		if (start.code !== 0) throw new Error(`Could not start detached tmux session: ${start.stderr.trim()}`);
		sessionStarted = true;
		const remainOnExit = await run("tmux", ["set-option", "-t", `${sessionName}:0`, "remain-on-exit", "on"]);
		if (remainOnExit.code !== 0) throw new Error(`Could not preserve an exited trace pane: ${remainOnExit.stderr.trim()}`);
		await waitForInitialRender(tuiWriteLog, 20_000);

		const load = await run("tmux", ["load-buffer", "-b", bufferName, promptPath]);
		if (load.code !== 0) throw new Error(`Could not load prompt into tmux: ${load.stderr.trim()}`);
		const paste = await run("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", `${sessionName}:0.0`]);
		if (paste.code !== 0) throw new Error(`Could not submit prompt to tmux: ${paste.stderr.trim()}`);
		const enter = await run("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "Enter"]);
		if (enter.code !== 0) throw new Error(`Could not confirm prompt in tmux: ${enter.stderr.trim()}`);

		await delay(options.waitMs);
		const capture = await run("tmux", ["capture-pane", "-p", "-e", "-S", "-", "-t", `${sessionName}:0.0`]);
		if (capture.code !== 0) throw new Error(`Could not capture tmux pane: ${capture.stderr.trim()}`);
		writeFileSync(transcriptPath, capture.stdout);
	} finally {
		if (sessionStarted) {
			await run("tmux", ["send-keys", "-t", `${sessionName}:0.0`, "C-c"]);
			await waitForSessionExit(sessionName, 1_000);
			await run("tmux", ["kill-session", "-t", sessionName]);
		}
		rmSync(sessionRoot, { recursive: true, force: true });
	}

	const elapsedMs = performance.now() - startedAt;
	const metadata = {
		elapsedMs,
		waitMs: options.waitMs,
		provider: options.provider ?? null,
		model: options.model ?? null,
		tmuxVersion,
		artifacts: Object.fromEntries([promptPath, tuiWriteLog, cpuProfile, transcriptPath, resourcePath].map((path) => [basename(path), existsSync(path) ? statSync(path).size : null])),
	};
	writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

	console.log(`artifacts: ${traceDir}`);
	console.log(`  TUI writes: ${tuiWriteLog}`);
	console.log(`  CPU profile: ${cpuProfile}`);
	console.log(`  pane transcript: ${transcriptPath}`);
	console.log(`  resource report: ${resourcePath}`);
	console.log(`  metadata: ${metadataPath}`);
	console.log(`METRIC elapsed_ms=${elapsedMs.toFixed(1)}`);
	console.log("limitations: fixed wait window; pane capture is not a complete write trace; CPU profile includes startup/shutdown.");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
