import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildResidentLoadPrunePlan,
	metadataForSessionLine,
	readSessionFileLines,
} from "../../packages/coding-agent/dist/core/session-resident-prune.js";

const experimentDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const rustBinary = join(experimentDir, "target", "release", "rusty-core-recast");
const fixtureDir = mkdtempSync(join(tmpdir(), "rusty-core-recast-parity-"));
const timestamp = "2026-07-30T00:00:00.000Z";

function entry(type, id, parentId, extra = {}) {
	return { type, id, parentId, timestamp, ...extra };
}

function header(id) {
	return { type: "session", version: 3, id, timestamp, cwd: "/captain" };
}

function assistant(id, parentId, toolCallId = undefined) {
	return entry("message", id, parentId, {
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			stopReason: toolCallId ? "toolUse" : "stop",
			content: toolCallId
				? [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "echo escaped \\\"value\\\"" } }]
				: [{ type: "text", text: "answer" }],
		},
	});
}

function user(id, parentId, content = "request") {
	return entry("message", id, parentId, { message: { role: "user", content } });
}

function toolResult(id, parentId, toolCallId) {
	return entry("message", id, parentId, {
		message: { role: "toolResult", toolCallId, toolName: "bash", content: "result", isError: false },
	});
}

function compaction(id, parentId, firstKeptEntryId) {
	return entry("compaction", id, parentId, { summary: "summary", firstKeptEntryId, tokensBefore: 1000 });
}

const corpus = [
	{
		name: "paired-basic",
		expectedDefault: { candidateIds: ["old-user", "old-assistant", "old-result"], protectedIds: [] },
		entries: [
			header("paired-basic"),
			user("old-user", null),
			assistant("old-assistant", "old-user", "old-call"),
			toolResult("old-result", "old-assistant", "old-call"),
			user("kept", "old-result"),
			compaction("compact", "kept", "kept"),
		],
	},
	{
		name: "escaped-whitespace",
			space: 2,
		entries: [
			header("escaped-whitespace"),
			user("old-user", null, "quotes: \\\" and newline: \\n"),
			assistant("old-assistant", "old-user"),
			user("kept", "old-assistant"),
			compaction("compact", "kept", "kept"),
		],
	},
	{
		name: "branch-and-protected-pair",
		expectedDefault: { candidateIds: ["old-user", "old-assistant"], protectedIds: ["old-assistant"] },
		entries: [
			header("branch-and-protected-pair"),
			user("old-user", null),
			assistant("old-assistant", "old-user", "split-call"),
			user("unrelated-branch", "old-user"),
			user("kept", "old-assistant"),
			toolResult("kept-result", "kept", "split-call"),
			compaction("compact", "kept-result", "kept"),
		],
	},
	{
		name: "all-stubbable-kinds",
		entries: [
			header("all-stubbable-kinds"),
			user("old-user", null),
			entry("custom_message", "old-custom-message", "old-user", {
				customType: "captain-note",
				content: "custom",
				display: true,
			}),
			entry("branch_summary", "old-branch-summary", "old-custom-message", { fromId: "old-user", summary: "branch" }),
			entry("compaction", "old-compaction", "old-branch-summary", {
				firstKeptEntryId: "old-branch-summary",
				tokensBefore: 10,
				summary: "older",
			}),
			entry("message", "old-bash", "old-compaction", {
				message: { role: "bashExecution", command: "echo hi", output: "output", exitCode: 0, cancelled: false, truncated: false },
			}),
			entry("message", "old-custom", "old-bash", {
				message: { role: "custom", customType: "captain-card", content: "card", display: true },
			}),
			entry("custom", "old-custom-entry", "old-custom", { customType: "captain-state", data: { state: "old" } }),
			entry("model_change", "old-model", "old-custom-entry", { provider: "anthropic", modelId: "claude" }),
			entry("thinking_level_change", "old-thinking", "old-model", { thinkingLevel: "high" }),
			entry("label", "old-label", "old-thinking", { label: "old" }),
			entry("session_info", "old-session-info", "old-label", { name: "captain session" }),
			user("kept", "old-session-info"),
			compaction("compact", "kept", "kept"),
		],
	},
	{
		name: "invalid-line-falls-back",
		expectedDefault: null,
		invalidLine: "{ malformed json",
		entries: [header("invalid-line-falls-back"), user("old-user", null), user("kept", "old-user"), compaction("compact", "kept", "kept")],
	},
];

function runRust(path, options) {
	const args = [path];
	if (!options.stubSummarizedEntries) args.push("--no-stub-summarized-entries");
	if (!options.stubToolResults) args.push("--no-stub-tool-results");
	const output = execFileSync(rustBinary, args, { encoding: "utf8" });
	return JSON.parse(output);
}

function compactMetadata(metadata) {
	const entryType = metadata.entryType ?? metadata.type;
	const compact = {
		id: metadata.id,
		parentId: metadata.parentId,
		entryType,
		timestamp: metadata.timestamp,
	};
	if (entryType === "message") {
		compact.messageRole = metadata.messageRole;
		if (metadata.messageRole === "assistant") {
			Object.assign(compact, {
				api: metadata.api,
				provider: metadata.provider,
				model: metadata.model,
				stopReason: metadata.stopReason,
				toolCallIds: metadata.toolCallIds,
			});
		} else if (metadata.messageRole === "toolResult") {
			Object.assign(compact, {
				isError: metadata.isError,
				toolResultCallId: metadata.toolResultCallId,
				toolName: metadata.toolName,
			});
		} else if (metadata.messageRole === "bashExecution") {
			compact.command = metadata.command;
		} else if (metadata.messageRole === "custom") {
			Object.assign(compact, { customType: metadata.customType, display: metadata.display });
		}
	} else if (entryType === "custom_message") {
		Object.assign(compact, { customType: metadata.customType, display: metadata.display });
	} else if (entryType === "branch_summary") {
		compact.fromId = metadata.fromId;
	} else if (entryType === "compaction") {
		Object.assign(compact, { firstKeptEntryId: metadata.firstKeptEntryId, tokensBefore: metadata.tokensBefore });
	}
	return compact;
}

function typeScriptPlan(path, options) {
	const metadataById = new Map();
	readSessionFileLines(path, (line) => {
		const metadata = metadataForSessionLine(line);
		if (metadata && metadata !== "session") metadataById.set(metadata.id, metadata);
	});
	const plan = buildResidentLoadPrunePlan(path, options);
	if (!plan) return null;
	return {
		candidateIds: [...plan.candidateIds],
		protectedIds: [...plan.protectedIds],
		stubMetadata: [...plan.rawStubs.keys()].map((id) => compactMetadata(metadataById.get(id))),
	};
}

function writeCase(testCase) {
	const path = join(fixtureDir, `${testCase.name}.jsonl`);
	const lines = testCase.entries.map((value) => JSON.stringify(value, null, testCase.space));
	if (testCase.invalidLine) lines.splice(2, 0, testCase.invalidLine);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

function assertEqual(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${label}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`);
	}
}

function main() {
	execFileSync("cargo", ["build", "--release", "--locked", "--offline", "--quiet"], { cwd: experimentDir, stdio: "inherit" });
	const optionsList = [
		{ stubSummarizedEntries: true, stubToolResults: true },
		{ stubSummarizedEntries: true, stubToolResults: false },
		{ stubSummarizedEntries: false, stubToolResults: true },
	];
	let checks = 0;
	for (const testCase of corpus) {
		const path = writeCase(testCase);
		for (const options of optionsList) {
			const expected = typeScriptPlan(path, options);
			const actual = runRust(path, options);
			if (options.stubSummarizedEntries && options.stubToolResults && "expectedDefault" in testCase) {
				if (testCase.expectedDefault === null) {
					assertEqual(expected, null, `${testCase.name} TypeScript fallback expectation`);
				} else {
					assertEqual(
						{ candidateIds: expected?.candidateIds, protectedIds: expected?.protectedIds },
						testCase.expectedDefault,
						`${testCase.name} TypeScript contract expectation`,
					);
				}
			}
			if (expected === null) {
				assertEqual(actual, null, `${testCase.name} ${JSON.stringify(options)}`);
			} else {
				assertEqual(
					{
						candidateIds: actual.candidateIds,
						protectedIds: actual.protectedIds,
						stubMetadata: actual.stubMetadata.map(compactMetadata),
					},
					expected,
					`${testCase.name} ${JSON.stringify(options)}`,
				);
				if (actual.fileFingerprint.sizeBytes !== statSync(path).size) {
					throw new Error(`${testCase.name} fingerprint size mismatch`);
				}
			}
			checks++;
		}
	}
	console.log(`resident-prune parity: ${checks} deterministic checks passed across ${corpus.length} corpus cases`);
}

try {
	main();
} finally {
	rmSync(fixtureDir, { recursive: true, force: true });
}
