#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_PROMPT =
	"Synthetic memory audit. Do not use private data. Reply with one short sentence, then stop.";

function parseArgs(argv) {
	const args = {
		pi: join(process.cwd(), "dist", "cli.js"),
		claude: "/Users/luke/.local/bin/claude",
		phaseMs: 2500,
		settleMs: 2500,
		prompt: undefined,
		skipVmmaps: false,
		piArgs: [],
		claudeArgs: [],
		outPrefix: undefined,
		residentProbeIterations: 3,
		skipResidentProbe: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) throw new Error(`Missing value for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--pi":
				args.pi = next();
				break;
			case "--claude":
				args.claude = next();
				break;
			case "--phase-ms":
				args.phaseMs = Number(next());
				break;
			case "--settle-ms":
				args.settleMs = Number(next());
				break;
			case "--prompt":
				args.prompt = next();
				break;
			case "--out-prefix":
				args.outPrefix = next();
				break;
			case "--skip-vmmap":
				args.skipVmmaps = true;
				break;
			case "--resident-probe-iterations":
				args.residentProbeIterations = Number(next());
				break;
			case "--skip-resident-probe":
				args.skipResidentProbe = true;
				break;
			case "--pi-arg":
				args.piArgs.push(next());
				break;
			case "--claude-arg":
				args.claudeArgs.push(next());
				break;
			case "--help":
				printHelp();
				process.exit(0);
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function printHelp() {
	console.log(`Usage: node scripts/pi-claude-rss-audit.mjs [options]

Runs Pi and Claude Code in isolated child processes and samples memory at common phases.
No private transcripts are read. By default no prompt is sent; pass --prompt to exercise a real turn.

Options:
  --pi <path>          Pi executable or dist/cli.js path (default: ./dist/cli.js)
  --claude <path>      Claude CLI path (default: /Users/luke/.local/bin/claude)
  --prompt <text>      Send a controlled synthetic prompt after idle startup
  --phase-ms <ms>      Delay between phase samples (default: 2500)
  --settle-ms <ms>     Post-prompt settle delay (default: 2500)
  --pi-arg <arg>       Extra arg for Pi child; repeatable
  --claude-arg <arg>   Extra arg for Claude child; repeatable
  --out-prefix <path>  Output prefix (default: /tmp/pi-claude-rss-audit-<timestamp>)
  --skip-vmmap         Do not collect vmmap -summary for large macOS processes
  --resident-probe-iterations <n>
                       Run n isolated Pi core prune probes for median heap/RSS deltas (default: 3)
  --skip-resident-probe
                       Skip the Pi core resident-prune probe
`);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIsoCompact() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function commandForExecutable(executable, extraArgs) {
	const resolved = resolve(executable);
	if (resolved.endsWith(".js")) {
		return { command: process.execPath, args: [resolved, ...extraArgs] };
	}
	return { command: resolved, args: extraArgs };
}

function psMemory(pid) {
	const result = spawnSync("ps", ["-o", "rss=", "-o", "vsz=", "-p", String(pid)], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		return { rssMb: null, vszMb: null, error: result.stderr.trim() || result.error?.message };
	}
	const [rssKb, vszKb] = result.stdout.trim().split(/\s+/).map((value) => Number(value));
	return {
		rssMb: Number.isFinite(rssKb) && rssKb >= 1024 ? rssKb / 1024 : null,
		vszMb: Number.isFinite(vszKb) && vszKb > 0 ? vszKb / 1024 : null,
		error: undefined,
	};
}

function vmmapSummary(pid, skip) {
	if (skip || process.platform !== "darwin") return undefined;
	const memory = psMemory(pid);
	if (!memory.rssMb || memory.rssMb < 750) return undefined;
	const result = spawnSync("vmmap", ["-summary", String(pid)], { encoding: "utf8", timeout: 15_000 });
	if (result.status !== 0) {
		return { error: result.stderr.trim() || result.error?.message || `vmmap exited ${result.status}` };
	}
	return { sha256: createHash("sha256").update(result.stdout).digest("hex"), text: result.stdout };
}

function safeWrite(child, text) {
	if (child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) return false;
	try {
		return child.stdin.write(text);
	} catch (error) {
		if (error?.code === "EPIPE") return false;
		throw error;
	}
}

function syntheticSessionStats() {
	const dir = join(tmpdir(), `pi-claude-rss-audit-synthetic-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "synthetic-session.jsonl");
	const header = { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: dir };
	const lines = [JSON.stringify(header)];
	let parentId = null;
	for (let i = 0; i < 160; i++) {
		const userId = randomUUID().slice(0, 8);
		lines.push(
			JSON.stringify({
				type: "message",
				id: userId,
				parentId,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: `synthetic user ${i} ${"u".repeat(2048)}`, timestamp: Date.now() },
			}),
		);
		parentId = userId;
		const assistantId = randomUUID().slice(0, 8);
		lines.push(
			JSON.stringify({
				type: "message",
				id: assistantId,
				parentId,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: `synthetic assistant ${i} ${"a".repeat(4096)}` }],
					api: "anthropic-messages",
					provider: "synthetic",
					model: "synthetic",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			}),
		);
		parentId = assistantId;
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	const stats = statSync(file);
	return { path: file, jsonlBytes: stats.size, entryCount: lines.length };
}

function shaFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function median(values) {
	const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	if (sorted.length === 0) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mb(bytes) {
	return bytes / 1024 / 1024;
}

function ownMemory() {
	const usage = process.memoryUsage();
	return {
		rssMb: mb(usage.rss),
		heapUsedMb: mb(usage.heapUsed),
		heapTotalMb: mb(usage.heapTotal),
		externalMb: mb(usage.external),
	};
}

function forceGc() {
	globalThis.gc?.();
	globalThis.gc?.();
}

function syntheticUsage() {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function payload(label, iteration, index, size) {
	return `${label}:${iteration}:${index}:` + "x".repeat(size);
}

function appendLargeConversation(sessionManager, iteration, baseTurns) {
	for (let i = 0; i < baseTurns; i++) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: payload("user", iteration, i, 8 * 1024) }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: payload("assistant", iteration, i, 16 * 1024) }],
			api: "anthropic-messages",
			provider: "synthetic",
			model: "synthetic",
			usage: syntheticUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}
}

function appendToolHeavyConversation(sessionManager, iteration, toolTurns) {
	let firstKeptEntryId;
	for (let i = 0; i < toolTurns; i++) {
		const userId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: payload("tool-user", iteration, i, 4 * 1024) }],
			timestamp: Date.now(),
		});
		if (i === toolTurns - 2) firstKeptEntryId = userId;
		const toolCallId = `synthetic-tool-${iteration}-${i}`;
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: payload("tool-assistant", iteration, i, 4 * 1024) },
				{
					type: "toolCall",
					id: toolCallId,
					name: "synthetic_memory_tool",
					arguments: { input: payload("tool-args", iteration, i, 2 * 1024) },
				},
			],
			api: "anthropic-messages",
			provider: "synthetic",
			model: "synthetic",
			usage: syntheticUsage(),
			stopReason: "tool_use",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "synthetic_memory_tool",
			content: [{ type: "text", text: payload("tool-result", iteration, i, 256 * 1024) }],
			isError: false,
			timestamp: Date.now(),
		});
	}
	return firstKeptEntryId;
}

async function runResidentProbeIteration(iteration) {
	const { SessionManager } = await import(new URL("../dist/index.js", import.meta.url).href);
	const root = join(tmpdir(), `pi-resident-prune-probe-${process.pid}-${iteration}`);
	const cwd = join(root, "cwd");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });

	let created = SessionManager.create(cwd, sessionDir, { id: `rss-probe-${iteration}` });
	appendLargeConversation(created, iteration, 80);
	const sessionFile = created.getSessionFile();
	created = undefined;
	forceGc();

	let sessionManager = SessionManager.open(sessionFile, sessionDir);
	forceGc();
	const afterLargeSessionLoad = ownMemory();
	const firstKeptEntryId = appendToolHeavyConversation(sessionManager, iteration, 80);
	forceGc();
	const afterToolHeavyWorkload = ownMemory();
	const compactionEntryId = sessionManager.appendCompaction(
		"Synthetic compaction summary for resident-prune audit.",
		firstKeptEntryId,
		100_000,
		{ source: "pi-claude-rss-audit" },
		false,
	);
	forceGc();
	const afterCompaction = ownMemory();
	const payloadBytesBeforePrune = sessionManager.estimateResidentPayloadBytes();
	const jsonlHashBeforePrune = shaFile(sessionFile);
	const contextBeforePrune = JSON.stringify(sessionManager.buildSessionContext());
	const pruneResult = sessionManager.pruneResidentHistoryAfterCompaction(compactionEntryId);
	forceGc();
	const afterPruneGc = ownMemory();
	const payloadBytesAfterPrune = sessionManager.estimateResidentPayloadBytes();
	const jsonlHashAfterPrune = shaFile(sessionFile);
	const contextAfterPrune = JSON.stringify(sessionManager.buildSessionContext());
	const jsonlHashBeforeHydrationPrune = shaFile(sessionFile);
	sessionManager = undefined;
	forceGc();
	const beforeHydrationPruneOpen = ownMemory();
	const hydratedPrunedSession = SessionManager.open(sessionFile, sessionDir, undefined, { residentPrune: true });
	forceGc();
	const afterHydrationPruneOpenGc = ownMemory();
	const payloadBytesAfterHydrationPrune = hydratedPrunedSession.estimateResidentPayloadBytes();
	const contextAfterHydrationPrune = JSON.stringify(hydratedPrunedSession.buildSessionContext());
	const jsonlHashAfterHydrationPrune = shaFile(sessionFile);
	hydratedPrunedSession.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continue after resident prune" }],
		timestamp: Date.now(),
	});
	const contextAfterContinuation = hydratedPrunedSession.buildSessionContext();
	const contextAfterContinuationJson = JSON.stringify(contextAfterContinuation);
	const jsonlBytes = statSync(sessionFile).size;

	return {
		iteration,
		sessionFile,
		entryCount: hydratedPrunedSession.getEntries().length,
		jsonlBytes,
		phases: {
			afterLargeSessionLoad,
			afterToolHeavyWorkload,
			afterCompaction,
			afterPruneGc,
			beforeHydrationPruneOpen,
			afterHydrationPruneOpenGc,
		},
		residentPayloadBytes: {
			beforePrune: payloadBytesBeforePrune,
			afterPrune: payloadBytesAfterPrune,
			afterHydrationPrune: payloadBytesAfterHydrationPrune,
			freed: payloadBytesBeforePrune - payloadBytesAfterPrune,
			hydrationFreed: payloadBytesBeforePrune - payloadBytesAfterHydrationPrune,
		},
		pruneResult,
		jsonlHashUnchangedAfterPrune: jsonlHashBeforePrune === jsonlHashAfterPrune,
		jsonlHashUnchangedAfterHydrationPrune: jsonlHashBeforeHydrationPrune === jsonlHashAfterHydrationPrune,
		contextEquivalentAfterPrune: contextBeforePrune === contextAfterPrune,
		contextEquivalentAfterHydrationPrune: contextAfterPrune === contextAfterHydrationPrune,
		continuationContextMessageCount: contextAfterContinuation.messages.length,
		continuedAfterPrune: contextAfterContinuationJson.includes("continue after resident prune"),
	};
}

async function runResidentProbeChild() {
	const iterationArg = process.argv[process.argv.indexOf("--iterations") + 1];
	const iterations = Math.max(1, Number(iterationArg || 3));
	const runs = [];
	for (let i = 0; i < iterations; i++) {
		runs.push(await runResidentProbeIteration(i));
	}
	const heapBefore = runs.map((run) => run.phases.afterCompaction.heapUsedMb);
	const heapAfter = runs.map((run) => run.phases.afterPruneGc.heapUsedMb);
	const rssBefore = runs.map((run) => run.phases.afterCompaction.rssMb);
	const rssAfter = runs.map((run) => run.phases.afterPruneGc.rssMb);
	const payloadBefore = runs.map((run) => run.residentPayloadBytes.beforePrune);
	const payloadAfter = runs.map((run) => run.residentPayloadBytes.afterPrune);
	const payloadAfterHydration = runs.map((run) => run.residentPayloadBytes.afterHydrationPrune);
	const phaseMedians = Object.fromEntries(
		[
			"afterLargeSessionLoad",
			"afterToolHeavyWorkload",
			"afterCompaction",
			"afterPruneGc",
			"beforeHydrationPruneOpen",
			"afterHydrationPruneOpenGc",
		].map((phase) => [
			phase,
			{
				rssMb: median(runs.map((run) => run.phases[phase].rssMb)),
				heapUsedMb: median(runs.map((run) => run.phases[phase].heapUsedMb)),
				heapTotalMb: median(runs.map((run) => run.phases[phase].heapTotalMb)),
			},
		]),
	);
	const summary = {
		phaseMedians,
		iterations,
		medianHeapUsedBeforePruneMb: median(heapBefore),
		medianHeapUsedAfterPruneGcMb: median(heapAfter),
		medianHeapUsedDropPercent: percentDrop(median(heapBefore), median(heapAfter)),
		medianRssBeforePruneMb: median(rssBefore),
		medianRssAfterPruneGcMb: median(rssAfter),
		medianRssDropPercent: percentDrop(median(rssBefore), median(rssAfter)),
		medianResidentPayloadBeforeBytes: median(payloadBefore),
		medianResidentPayloadAfterBytes: median(payloadAfter),
		medianResidentPayloadAfterHydrationPruneBytes: median(payloadAfterHydration),
		medianResidentPayloadDropPercent: percentDrop(median(payloadBefore), median(payloadAfter)),
		medianResidentPayloadHydrationDropPercent: percentDrop(median(payloadBefore), median(payloadAfterHydration)),
		allJsonlHashesUnchanged: runs.every(
			(run) => run.jsonlHashUnchangedAfterPrune && run.jsonlHashUnchangedAfterHydrationPrune,
		),
		allContextsEquivalentAfterPrune: runs.every((run) => run.contextEquivalentAfterPrune),
		allContextsEquivalentAfterHydrationPrune: runs.every((run) => run.contextEquivalentAfterHydrationPrune),
		allContinuedAfterPrune: runs.every((run) => run.continuedAfterPrune),
	};
	return { summary, runs };
}

function percentDrop(before, after) {
	if (!Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return null;
	return ((before - after) / before) * 100;
}

function runResidentProbe(iterations) {
	const scriptPath = fileURLToPath(import.meta.url);
	const result = spawnSync(process.execPath, ["--expose-gc", scriptPath, "--internal-resident-probe", "--iterations", String(iterations)], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (result.status !== 0) {
		return {
			error: result.stderr.trim() || result.error?.message || `resident probe exited ${result.status}`,
			stdoutSha256: createHash("sha256").update(result.stdout || "").digest("hex"),
			stderrSha256: createHash("sha256").update(result.stderr || "").digest("hex"),
		};
	}
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		return {
			error: `Failed to parse resident probe output: ${error instanceof Error ? error.message : String(error)}`,
			stdoutSha256: createHash("sha256").update(result.stdout || "").digest("hex"),
		};
	}
}

async function sample(samples, child, cli, phase, startedAt, skipVmmaps) {
	const elapsedMs = Date.now() - startedAt;
	const memory = psMemory(child.pid);
	const vmmap = memory.rssMb && memory.rssMb > 750 ? vmmapSummary(child.pid, skipVmmaps) : undefined;
	samples.push({
		cli,
		phase,
		pid: child.pid,
		elapsedMs,
		rssMb: memory.rssMb,
		vszMb: memory.vszMb,
		processMemoryUsage: null,
		vmmapSummary: vmmap ? { ...vmmap, text: vmmap.text ? undefined : undefined } : undefined,
	});
	return vmmap?.text;
}

async function runCli(name, executable, defaultArgs, extraArgs, prompt, phaseMs, settleMs, skipVmmaps, vmmapDir) {
	const agentDir = join(tmpdir(), `pi-claude-rss-audit-${name}-${process.pid}-${Date.now()}`);
	mkdirSync(agentDir, { recursive: true });
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: join(agentDir, "pi-agent"),
		CLAUDE_CONFIG_DIR: join(agentDir, "claude"),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		NO_COLOR: "1",
	};
	const { command, args } = commandForExecutable(executable, [...defaultArgs, ...extraArgs]);
	const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
	const stdout = [];
	const stderr = [];
	child.stdout.on("data", (chunk) => stdout.push(chunk));
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	child.stdin.on("error", (error) => {
		if (!["EPIPE", "ERR_STREAM_DESTROYED"].includes(error?.code)) {
			stderr.push(Buffer.from(`\nstdin error: ${error?.message || String(error)}\n`));
		}
	});
	const startedAt = Date.now();
	const samples = [];
	const vmmaps = [];

	await sleep(Math.min(1250, phaseMs));
	let vmmapText = await sample(samples, child, name, "cold_start", startedAt, skipVmmaps);
	if (vmmapText) vmmaps.push({ cli: name, phase: "cold_start", text: vmmapText });
	await sleep(phaseMs);
	vmmapText = await sample(samples, child, name, "idle_after_startup", startedAt, skipVmmaps);
	if (vmmapText) vmmaps.push({ cli: name, phase: "idle_after_startup", text: vmmapText });

	if (prompt) {
		safeWrite(child, `${prompt}\n`);
		await sleep(phaseMs);
		vmmapText = await sample(samples, child, name, "after_synthetic_prompt", startedAt, skipVmmaps);
		if (vmmapText) vmmaps.push({ cli: name, phase: "after_synthetic_prompt", text: vmmapText });
	}
	await sleep(settleMs);
	vmmapText = await sample(samples, child, name, "after_idle_settle", startedAt, skipVmmaps);
	if (vmmapText) vmmaps.push({ cli: name, phase: "after_idle_settle", text: vmmapText });

	safeWrite(child, "/exit\n");
	await sleep(500);
	if (child.exitCode === null) {
		child.kill("SIGTERM");
		await new Promise((resolve) => child.once("exit", resolve));
	}

	for (const vmmap of vmmaps) {
		const path = join(vmmapDir, `${name}-${vmmap.phase}.vmmap.txt`);
		writeFileSync(path, vmmap.text);
		const matching = samples.find((item) => item.cli === vmmap.cli && item.phase === vmmap.phase);
		if (matching?.vmmapSummary) matching.vmmapSummary.path = path;
	}

	return {
		name,
		command,
		args,
		agentDir,
		exitCode: child.exitCode,
		samples,
		stdoutBytes: Buffer.concat(stdout).byteLength,
		stderrBytes: Buffer.concat(stderr).byteLength,
		stdoutSha256: createHash("sha256").update(Buffer.concat(stdout)).digest("hex"),
		stderrSha256: createHash("sha256").update(Buffer.concat(stderr)).digest("hex"),
	};
}

function formatNumber(value, digits = 1) {
	return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function markdownReport(report) {
	const rows = [];
	for (const run of report.runs) {
		for (const sample of run.samples) {
			rows.push(
				`| ${sample.cli} | ${sample.phase} | ${sample.pid} | ${sample.elapsedMs} | ${sample.rssMb?.toFixed(1) ?? "n/a"} | ${sample.vszMb?.toFixed(1) ?? "n/a"} |`,
			);
		}
	}
	const resident = report.residentProbe;
	const residentSummary = resident?.summary;
	const phaseRows = residentSummary?.phaseMedians
		? Object.entries(residentSummary.phaseMedians)
				.map(([phase, memory]) => `| ${phase} | ${formatNumber(memory.rssMb)} | ${formatNumber(memory.heapUsedMb)} | ${formatNumber(memory.heapTotalMb)} |`)
				.join("\n")
		: "";
	const residentSection = resident?.error
		? `\n## Pi resident prune probe\n\nProbe failed: ${resident.error}\n`
		: residentSummary
			? `\n## Pi resident prune probe\n\nIsolated Node child process using built Pi core exports, synthetic structural data only.\n\n| Phase | Median RSS MB | Median heapUsed MB | Median heapTotal MB |\n|---|---:|---:|---:|\n${phaseRows}\n\n| Metric | Median before | Median after prune + GC | Drop | Median after hydration prune | Hydration drop |\n|---|---:|---:|---:|---:|---:|\n| heapUsed MB | ${formatNumber(residentSummary.medianHeapUsedBeforePruneMb)} | ${formatNumber(residentSummary.medianHeapUsedAfterPruneGcMb)} | ${formatNumber(residentSummary.medianHeapUsedDropPercent)}% | n/a | n/a |\n| RSS MB | ${formatNumber(residentSummary.medianRssBeforePruneMb)} | ${formatNumber(residentSummary.medianRssAfterPruneGcMb)} | ${formatNumber(residentSummary.medianRssDropPercent)}% | n/a | n/a |\n| resident payload bytes | ${formatNumber(residentSummary.medianResidentPayloadBeforeBytes, 0)} | ${formatNumber(residentSummary.medianResidentPayloadAfterBytes, 0)} | ${formatNumber(residentSummary.medianResidentPayloadDropPercent)}% | ${formatNumber(residentSummary.medianResidentPayloadAfterHydrationPruneBytes, 0)} | ${formatNumber(residentSummary.medianResidentPayloadHydrationDropPercent)}% |\n\nInvariants: JSONL hash unchanged = ${residentSummary.allJsonlHashesUnchanged}; context equivalent after prune = ${residentSummary.allContextsEquivalentAfterPrune}; context equivalent after hydration prune = ${residentSummary.allContextsEquivalentAfterHydrationPrune}; continuation after prune = ${residentSummary.allContinuedAfterPrune}.\n`
			: "";
	return `# Pi / Claude RSS audit

Generated: ${report.generatedAt}

Synthetic session metadata only:

- Path: ${report.syntheticSession.path}
- Entries: ${report.syntheticSession.entryCount}
- JSONL bytes: ${report.syntheticSession.jsonlBytes}

Prompt phase: ${report.promptSent ? "enabled" : "disabled (pass --prompt to exercise a real turn)"}

| CLI | Phase | PID | elapsed ms | RSS MB | VSZ MB |
|---|---:|---:|---:|---:|---:|
${rows.join("\n")}
${residentSection}
Notes:

- Outputs are hashed/byte-counted only; no transcript or model response content is copied into this report.
- vmmap full text, when collected, is written as separate files and referenced from the JSON report.
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const timestamp = nowIsoCompact();
	const outPrefix = args.outPrefix ?? join(tmpdir(), `pi-claude-rss-audit-${timestamp}`);
	mkdirSync(dirname(outPrefix), { recursive: true });
	const vmmapDir = `${outPrefix}-vmmaps`;
	mkdirSync(vmmapDir, { recursive: true });
	const syntheticSession = syntheticSessionStats();
	const prompt = args.prompt === undefined ? undefined : args.prompt || DEFAULT_PROMPT;

	const piDefaultArgs = ["--no-session"];
	const claudeDefaultArgs = ["--bare", "--no-session-persistence"];
	const runs = [];
	for (const [name, executable, defaultArgs, extraArgs] of [
		["pi", args.pi, piDefaultArgs, args.piArgs],
		["claude", args.claude, claudeDefaultArgs, args.claudeArgs],
	]) {
		if (!existsSync(resolve(executable))) {
			runs.push({ name, error: `Executable not found: ${executable}`, samples: [] });
			continue;
		}
		runs.push(await runCli(name, executable, defaultArgs, extraArgs, prompt, args.phaseMs, args.settleMs, args.skipVmmaps, vmmapDir));
	}

	const residentProbe = args.skipResidentProbe ? undefined : runResidentProbe(args.residentProbeIterations);
	const report = {
		generatedAt: new Date().toISOString(),
		promptSent: Boolean(prompt),
		phaseMs: args.phaseMs,
		settleMs: args.settleMs,
		syntheticSession,
		residentProbe,
		runs,
	};
	const jsonPath = `${outPrefix}.json`;
	const mdPath = `${outPrefix}.md`;
	writeFileSync(jsonPath, JSON.stringify(report, null, 2));
	writeFileSync(mdPath, markdownReport(report));
	console.log(JSON.stringify({ jsonPath, mdPath }, null, 2));
}

if (process.argv.includes("--internal-resident-probe")) {
	runResidentProbeChild()
		.then((result) => {
			console.log(JSON.stringify(result));
		})
		.catch((error) => {
			console.error(error instanceof Error ? error.stack || error.message : String(error));
			process.exit(1);
		});
} else {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exit(1);
	});
}
