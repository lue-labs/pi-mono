import { rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { OutputAccumulator } from "../../packages/coding-agent/dist/core/tools/output-accumulator.js";

if (typeof global.gc !== "function") throw new Error("Run with node --expose-gc");

const chunk = Buffer.from(`${"output ".repeat(2048)}\n`);
const chunks = 3_000;
const accumulator = new OutputAccumulator({ tempFilePrefix: "rusty-core-recast" });

global.gc();
const before = process.memoryUsage();
let peakHeapUsed = before.heapUsed;
let peakRss = before.rss;
const startedAt = performance.now();

for (let index = 0; index < chunks; index++) {
	accumulator.append(chunk);
	if (index % 8 === 0) accumulator.snapshot();
	if (index % 64 === 0) {
		const usage = process.memoryUsage();
		peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
		peakRss = Math.max(peakRss, usage.rss);
	}
}

accumulator.finish();
const snapshot = accumulator.snapshot({ persistIfTruncated: true });
await accumulator.closeTempFile();
global.gc();
const after = process.memoryUsage();
if (snapshot.fullOutputPath) rmSync(snapshot.fullOutputPath, { force: true });

function mib(bytes) {
	return (bytes / 1024 / 1024).toFixed(2);
}

console.log(`streamed_mib=${((chunk.length * chunks) / 1024 / 1024).toFixed(2)}`);
console.log(`elapsed_ms=${(performance.now() - startedAt).toFixed(2)}`);
console.log(`snapshot_bytes=${snapshot.truncation.outputBytes}`);
console.log(`peak_heap_growth_mib=${mib(peakHeapUsed - before.heapUsed)}`);
console.log(`peak_rss_growth_mib=${mib(peakRss - before.rss)}`);
console.log(`retained_heap_growth_mib=${mib(after.heapUsed - before.heapUsed)}`);
