#!/usr/bin/env node
/**
 * Synthetic retained-transcript probe.
 *
 * Run after `npm run build:ts`:
 *   node --inspect=0 --expose-gc scripts/pi-transcript-memory-inspect.mjs
 *
 * It runs fresh pre- and post-prune processes for unperturbed RSS/heap samples,
 * while each child also writes a V8 heap snapshot for retention attribution. No
 * user session, provider, or project files are read.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { SessionManager } from "../dist/index.js";

const CYCLES = 3;
const TURNS_PER_CYCLE = 20;
const TOOL_RESULT_BYTES = 256 * 1024;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function forceGc() {
	globalThis.gc?.();
	globalThis.gc?.();
}

function memory() {
	const { rss, heapUsed, heapTotal, external } = process.memoryUsage();
	return {
		rssMiB: Number((rss / 2 ** 20).toFixed(1)),
		heapUsedMiB: Number((heapUsed / 2 ** 20).toFixed(1)),
		heapTotalMiB: Number((heapTotal / 2 ** 20).toFixed(1)),
		externalMiB: Number((external / 2 ** 20).toFixed(1)),
	};
}

function payload(cycle, turn) {
	const prefix = `TRANSCRIPT_MEMORY_MARKER/${cycle}/${turn}/tool-result/`;
	return prefix + `${cycle}-${turn}-result-`.repeat(Math.ceil(TOOL_RESULT_BYTES / 16)).slice(0, TOOL_RESULT_BYTES);
}

function createWorkload() {
	const root = mkdtempSync(join(tmpdir(), "pi-transcript-memory-inspect-"));
	const cwd = join(root, "cwd");
	const sessionDir = join(root, "sessions");
	const session = SessionManager.create(cwd, sessionDir);

	for (let cycle = 0; cycle < CYCLES; cycle++) {
		let firstKeptEntryId;
		for (let turn = 0; turn < TURNS_PER_CYCLE; turn++) {
			const toolCallId = `synthetic-tool-${cycle}-${turn}`;
			const userEntryId = session.appendMessage({
				role: "user",
				content: `synthetic user ${cycle}/${turn}`,
				timestamp: Date.now(),
			});
			if (turn === TURNS_PER_CYCLE - 2) firstKeptEntryId = userEntryId;
			session.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "synthetic_memory_tool", arguments: { cycle, turn } }],
				api: "anthropic-messages",
				provider: "synthetic",
				model: "synthetic",
				usage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			session.appendMessage({
				role: "toolResult",
				toolCallId,
				toolName: "synthetic_memory_tool",
				content: [{ type: "text", text: payload(cycle, turn) }],
				isError: false,
				timestamp: Date.now(),
			});
		}
		if (!firstKeptEntryId) throw new Error("Synthetic workload has no retained tail.");
		session.appendCompaction(`Synthetic compaction ${cycle}`, firstKeptEntryId, 100_000);
		if (session.buildSessionContext().messages.length > 8) {
			throw new Error("Compaction did not reduce the model-facing context.");
		}
	}
	return { root, session, sessionFile: session.getSessionFile() };
}

function runInternal(phase) {
	if (!globalThis.gc) throw new Error("Run with --expose-gc so samples compare post-GC heap usage.");
	const { root, session, sessionFile } = createWorkload();
	if (!sessionFile) throw new Error("Expected a persisted synthetic session.");
	const jsonlHashBefore = createHash("sha256").update(readFileSync(sessionFile)).digest("hex");
	const prune = phase === "after-prune" ? session.pruneResidentHistoryAfterCompaction() : undefined;
	forceGc();
	const sample = memory();
	const snapshot = writeHeapSnapshot(join(root, `${phase}.heapsnapshot`));
	const jsonlHashAfter = createHash("sha256").update(readFileSync(sessionFile)).digest("hex");
	return {
		phase,
		root,
		sample,
		prune,
		durableJsonlUnchanged: jsonlHashBefore === jsonlHashAfter,
		jsonlMiB: Number((statSync(sessionFile).size / 2 ** 20).toFixed(1)),
		snapshot,
	};
}

function runChild(phase) {
	const scriptPath = fileURLToPath(import.meta.url);
	const result = spawnSync(process.execPath, ["--inspect=0", "--expose-gc", scriptPath, "--internal", phase], {
		encoding: "utf8",
		timeout: 120_000,
	});
	if (result.status !== 0) throw new Error(result.stderr.trim() || `Probe child exited ${result.status}`);
	return JSON.parse(result.stdout);
}

if (process.argv[2] === "--internal") {
	console.log(JSON.stringify(runInternal(process.argv[3])));
} else {
	if (!process.execArgv.some((arg) => arg.startsWith("--inspect"))) {
		throw new Error("Run with --inspect so the written snapshots are debugger-compatible.");
	}
	const beforePrune = runChild("before-prune");
	const afterPrune = runChild("after-prune");
	console.log(
		JSON.stringify(
			{
				workload: { cycles: CYCLES, turnsPerCycle: TURNS_PER_CYCLE, toolResultBytes: TOOL_RESULT_BYTES },
				beforePrune,
				afterPrune,
			},
			null,
			2,
		),
	);
}
