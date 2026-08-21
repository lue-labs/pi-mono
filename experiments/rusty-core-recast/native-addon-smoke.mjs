import { copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResidentLoadPrunePlan } from "../../packages/coding-agent/dist/core/session-resident-prune.js";
import { scanResidentTranscript } from "./native-addon.mjs";

const experimentDir = resolve(dirname(fileURLToPath(import.meta.url)));
const artifactDir = join(experimentDir, "target", "release");
const dylibPath = join(artifactDir, "librusty_core_recast_addon.dylib");
const nodePath = join(artifactDir, "rusty-core-recast.node");
const fixtureDir = mkdtempSync(join(tmpdir(), "rusty-core-recast-addon-"));
const timestamp = "2026-07-30T00:00:00.000Z";

function entry(type, id, parentId, extra = {}) {
	return { type, id, parentId, timestamp, ...extra };
}

function compact(plan) {
	if (!plan) return null;
	return {
		candidateIds: [...plan.candidateIds],
		protectedIds: [...plan.protectedIds],
	};
}

function main() {
	copyFileSync(dylibPath, nodePath);
	const fixturePath = join(fixtureDir, "paired.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "addon", timestamp, cwd: "/addon" },
		entry("message", "old-user", null, { message: { role: "user", content: "old" } }),
		entry("message", "old-assistant", "old-user", {
			message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] },
		}),
		entry("message", "old-result", "old-assistant", { message: { role: "toolResult", toolCallId: "call", toolName: "bash", content: "result" } }),
		entry("message", "kept", "old-result", { message: { role: "user", content: "new" } }),
		entry("compaction", "compact", "kept", { firstKeptEntryId: "kept", tokensBefore: 1000, summary: "summary" }),
	];
	writeFileSync(fixturePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

	const expected = compact(buildResidentLoadPrunePlan(fixturePath, { stubSummarizedEntries: true, stubToolResults: true }));
	const actual = scanResidentTranscript(fixturePath);
	if (JSON.stringify(compact(actual)) !== JSON.stringify(expected)) {
		throw new Error(`addon plan mismatch\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(compact(actual))}`);
	}
	if (actual.fileFingerprint.sizeBytes !== statSync(fixturePath).size) {
		throw new Error("addon fingerprint size mismatch");
	}

	const malformedPath = join(fixtureDir, "malformed.jsonl");
	writeFileSync(malformedPath, `${JSON.stringify(lines[0])}\n{ malformed json\n`);
	if (scanResidentTranscript(malformedPath) !== null) {
		throw new Error("addon did not preserve malformed-transcript fallback");
	}

	const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`;
	console.log(`native addon smoke passed on ${runtime}`);
}

try {
	main();
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}
