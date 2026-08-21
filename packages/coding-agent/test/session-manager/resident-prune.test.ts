import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	estimateResidentPayloadBytes,
	type FileEntry,
	loadEntriesFromFile,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const tempDirs: string[] = [];

function makeTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function largeText(label: string, size = 32_000): string {
	return `${label}:${"x".repeat(size)}`;
}

function messageEntry(session: SessionManager, id: string): SessionMessageEntry {
	const entry = session.getEntry(id);
	if (!entry || entry.type !== "message") {
		throw new Error(`Expected message entry ${id}`);
	}
	return entry;
}

function entryJson(session: SessionManager, id: string): string {
	return JSON.stringify(messageEntry(session, id));
}

function entryJsonFromEntries(entries: FileEntry[], id: string): string {
	const entry = entries.find((item) => item.type === "message" && item.id === id);
	if (!entry || entry.type !== "message") {
		throw new Error(`Expected message entry ${id}`);
	}
	return JSON.stringify(entry);
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("SessionManager resident compaction pruning", () => {
	it("stubs summarized resident payloads without rewriting durable JSONL or changing active context", () => {
		const tempDir = makeTempDir("resident-prune-durable");
		const session = SessionManager.create(tempDir, tempDir);

		const oldUserId = session.appendMessage(userMsg(largeText("old user")));
		const oldAssistantId = session.appendMessage(assistantMsg(largeText("old assistant")));
		const firstKeptId = session.appendMessage(userMsg("kept user"));
		session.appendMessage(assistantMsg("kept assistant"));
		session.appendModelChange("anthropic", "claude-test");
		session.appendThinkingLevelChange("medium");
		const compactionId = session.appendCompaction("summary", firstKeptId, 100_000);
		session.appendLabelChange(firstKeptId, "kept-label");
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");

		const contextBefore = JSON.stringify(session.buildSessionContext());
		const fileHashBefore = sha256File(sessionFile);
		const payloadBefore = session.estimateResidentPayloadBytes();

		const result = session.pruneResidentHistoryAfterCompaction(compactionId);

		expect(result.jsonlUnchanged).toBe(true);
		expect(result.entriesStubbed).toBe(2);
		expect(result.payloadBytesAfter).toBeLessThan(result.payloadBytesBefore * 0.2);
		expect(session.estimateResidentPayloadBytes()).toBeLessThan(payloadBefore * 0.2);
		expect(JSON.stringify(session.buildSessionContext())).toBe(contextBefore);
		expect(sha256File(sessionFile)).toBe(fileHashBefore);
		expect(entryJson(session, oldUserId)).toContain("Resident session payload pruned");
		expect(entryJson(session, oldAssistantId)).toContain("Resident session payload pruned");

		const resumed = SessionManager.open(sessionFile, tempDir);
		expect(entryJson(resumed, oldUserId)).toContain("old user");
		expect(entryJson(resumed, oldAssistantId)).toContain("old assistant");

		const resumedPruned = SessionManager.open(sessionFile, tempDir, undefined, { residentPrune: true });
		expect(entryJson(resumedPruned, oldUserId)).toContain("Resident session payload pruned");
		expect(entryJson(resumedPruned, oldAssistantId)).toContain("Resident session payload pruned");
		expect(JSON.stringify(resumedPruned.buildSessionContext())).toBe(contextBefore);
		expect(resumedPruned.getLabel(firstKeptId)).toBe("kept-label");
		expect(
			resumedPruned
				.getTree()
				.some((node) => node.entry.id === firstKeptId || JSON.stringify(node).includes(firstKeptId)),
		).toBe(true);
		expect(sha256File(sessionFile)).toBe(fileHashBefore);

		const prunedLoadedEntries = loadEntriesFromFile(sessionFile, { residentPrune: true });
		expect(entryJsonFromEntries(prunedLoadedEntries, oldUserId)).toContain("Resident session payload pruned");
		expect(entryJsonFromEntries(loadEntriesFromFile(sessionFile), oldUserId)).toContain("old user");
		expect(sha256File(sessionFile)).toBe(fileHashBefore);
	});

	it("honors resident-prune hydration for continueRecent without rewriting durable JSONL", () => {
		const tempDir = makeTempDir("resident-prune-continue");
		const session = SessionManager.create(tempDir, tempDir);
		const oldUserId = session.appendMessage(userMsg(largeText("old user for continue")));
		session.appendMessage(assistantMsg(largeText("old assistant for continue")));
		const firstKeptId = session.appendMessage(userMsg("kept user"));
		session.appendMessage(assistantMsg("kept assistant"));
		session.appendCompaction("summary", firstKeptId, 100_000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const fileHashBefore = sha256File(sessionFile);

		const resumed = SessionManager.continueRecent(tempDir, tempDir, { residentPrune: true });

		expect(resumed.getSessionFile()).toBe(sessionFile);
		expect(entryJson(resumed, oldUserId)).toContain("Resident session payload pruned");
		expect(sha256File(sessionFile)).toBe(fileHashBefore);
	});

	it("honors PI_RESIDENT_SESSION_PRUNE during open hydration", () => {
		const tempDir = makeTempDir("resident-prune-env");
		const session = SessionManager.create(tempDir, tempDir);
		const oldUserId = session.appendMessage(userMsg(largeText("old env user")));
		session.appendMessage(assistantMsg(largeText("old env assistant")));
		const firstKeptId = session.appendMessage(userMsg("kept user"));
		session.appendCompaction("summary", firstKeptId, 100_000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const previous = process.env.PI_RESIDENT_SESSION_PRUNE;
		process.env.PI_RESIDENT_SESSION_PRUNE = "1";
		try {
			const resumed = SessionManager.open(sessionFile, tempDir);
			expect(entryJson(resumed, oldUserId)).toContain("Resident session payload pruned");
		} finally {
			if (previous === undefined) {
				delete process.env.PI_RESIDENT_SESSION_PRUNE;
			} else {
				process.env.PI_RESIDENT_SESSION_PRUNE = previous;
			}
		}
	});

	it("keeps forked JSONL complete while pruning fork resident payloads on hydration", () => {
		const tempDir = makeTempDir("resident-prune-fork");
		const source = SessionManager.create(tempDir, tempDir);
		const oldUserId = source.appendMessage(userMsg(largeText("old fork user")));
		source.appendMessage(assistantMsg(largeText("old fork assistant")));
		const firstKeptId = source.appendMessage(userMsg("kept fork user"));
		source.appendCompaction("summary", firstKeptId, 100_000);
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("expected source file");

		const forked = SessionManager.forkFrom(sourceFile, tempDir, tempDir, undefined, { residentPrune: true });
		const forkedFile = forked.getSessionFile();
		if (!forkedFile) throw new Error("expected forked file");

		expect(entryJson(forked, oldUserId)).toContain("Resident session payload pruned");
		expect(readFileSync(forkedFile, "utf8")).toContain("old fork user");
	});

	it("hydrates pruned candidate entries without parsing their payload JSON", () => {
		const tempDir = makeTempDir("resident-prune-raw-line");
		const sessionFile = join(tempDir, "raw-line.jsonl");
		const oldPayload = "DO_NOT_PARSE_OLD_PAYLOAD";
		const oldAssistantPayload = "DO_NOT_PARSE_OLD_ASSISTANT_PAYLOAD";
		const oldToolPayload = "DO_NOT_PARSE_OLD_TOOL_PAYLOAD";
		const header = {
			type: "session",
			version: 3,
			id: "raw-line-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		};
		const oldUser = {
			type: "message",
			id: "old-user",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: largeText(oldPayload) }], timestamp: Date.now() },
		};
		const oldAssistant = {
			type: "message",
			id: "old-assistant",
			parentId: "old-user",
			timestamp: new Date().toISOString(),
			message: {
				...assistantMsg(oldAssistantPayload),
				content: [
					{ type: "text", text: largeText(oldAssistantPayload) },
					{ type: "toolCall", id: "tool-old", name: "old_tool", arguments: { payload: oldAssistantPayload } },
				],
				stopReason: "toolUse",
			},
		};
		const oldToolResult = {
			type: "message",
			id: "old-tool-result",
			parentId: "old-assistant",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "tool-old",
				toolName: "old_tool",
				content: [{ type: "text", text: largeText(oldToolPayload) }],
				isError: true,
				timestamp: Date.now(),
			},
		};
		const firstKept = {
			type: "message",
			id: "first-kept",
			parentId: "old-tool-result",
			timestamp: new Date().toISOString(),
			message: userMsg("kept raw-line session"),
		};
		const compaction = {
			type: "compaction",
			id: "compaction",
			parentId: "first-kept",
			timestamp: new Date().toISOString(),
			summary: "summary",
			firstKeptEntryId: "first-kept",
			tokensBefore: 1000,
		};
		writeFileSync(
			sessionFile,
			`${[header, oldUser, oldAssistant, oldToolResult, firstKept, compaction]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		const originalParse = JSON.parse;
		const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
			if (text.includes("DO_NOT_PARSE_OLD_")) throw new Error("old summarized payload was parsed");
			return originalParse(text);
		});
		try {
			const entries = loadEntriesFromFile(sessionFile, { residentPrune: true });
			const oldEntry = entries.find((entry) => entry.type === "message" && entry.id === "old-user");
			const oldAssistantEntry = entries.find((entry) => entry.type === "message" && entry.id === "old-assistant");
			const oldToolEntry = entries.find((entry) => entry.type === "message" && entry.id === "old-tool-result");
			expect(JSON.stringify(oldEntry)).toContain("Resident session payload pruned");
			expect(oldAssistantEntry?.type).toBe("message");
			if (oldAssistantEntry?.type !== "message" || oldAssistantEntry.message.role !== "assistant") {
				throw new Error("expected assistant stub");
			}
			expect(oldAssistantEntry.message.api).toBe("anthropic-messages");
			expect(oldAssistantEntry.message.usage.totalTokens).toBe(0);
			expect(oldAssistantEntry.message.stopReason).toBe("toolUse");
			expect(oldToolEntry?.type).toBe("message");
			if (oldToolEntry?.type !== "message" || oldToolEntry.message.role !== "toolResult") {
				throw new Error("expected tool result stub");
			}
			expect(oldToolEntry.message.isError).toBe(true);
			expect(parseSpy).not.toHaveBeenCalledWith(expect.stringContaining("DO_NOT_PARSE_OLD_"));
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("writes durable branched sessions from full transcript content after resident pruning", () => {
		const tempDir = makeTempDir("resident-prune-branch-file");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg(largeText("old branch user")));
		const oldAssistantId = session.appendMessage(assistantMsg(largeText("old branch assistant")));
		const firstKeptId = session.appendMessage(userMsg("kept branch user"));
		session.appendMessage(assistantMsg("kept branch assistant"));
		const compactionId = session.appendCompaction("summary", firstKeptId, 100_000);
		session.pruneResidentHistoryAfterCompaction(compactionId);

		const branchedFile = session.createBranchedSession(oldAssistantId);
		if (!branchedFile) throw new Error("expected persisted branched file");
		const durableJsonl = readFileSync(branchedFile, "utf8");

		expect(durableJsonl).toContain("old branch assistant");
		expect(durableJsonl).not.toContain("Resident session payload pruned");
	});

	it("does not crash resident-prune hydration on malformed assistant content", () => {
		const tempDir = makeTempDir("resident-prune-malformed");
		const sessionFile = join(tempDir, "malformed.jsonl");
		const oldAssistant = {
			type: "message",
			id: "old-assistant",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "assistant", content: "malformed assistant content", timestamp: Date.now() },
		};
		const firstKept = {
			type: "message",
			id: "first-kept",
			parentId: "old-assistant",
			timestamp: new Date().toISOString(),
			message: userMsg("kept malformed session"),
		};
		const compaction = {
			type: "compaction",
			id: "compaction",
			parentId: "first-kept",
			timestamp: new Date().toISOString(),
			summary: "summary",
			firstKeptEntryId: "first-kept",
			tokensBefore: 1000,
		};
		const header = {
			type: "session",
			version: 3,
			id: "malformed-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		};
		writeFileSync(
			sessionFile,
			`${[header, oldAssistant, firstKept, compaction].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);

		const resumed = SessionManager.open(sessionFile, tempDir, undefined, { residentPrune: true });

		expect(resumed.getSessionId()).toBe("malformed-session");
		expect(entryJson(resumed, "old-assistant")).toContain("Resident session payload pruned");
	});

	it("keeps tool-use/tool-result pairs intact when a compaction boundary would split them", () => {
		const session = SessionManager.inMemory();
		const userId = session.appendMessage(userMsg(largeText("tool request")));
		const toolCallId = "call_protected";
		const assistantId = session.appendMessage({
			...assistantMsg("assistant before tool"),
			content: [
				{ type: "text", text: largeText("assistant tool preface") },
				{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: largeText("huge arg") } },
			],
		});
		const firstKeptId = session.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName: "read",
			content: [{ type: "text", text: largeText("tool result") }],
			isError: false,
			timestamp: Date.now(),
		});
		const compactionId = session.appendCompaction("summary", firstKeptId, 50_000);

		const result = session.pruneResidentHistoryAfterCompaction(compactionId);

		expect(result.protectedEntries).toBe(1);
		expect(entryJson(session, userId)).toContain("Resident session payload pruned");
		expect(entryJson(session, assistantId)).toContain("huge arg");
		expect(entryJson(session, firstKeptId)).toContain("tool result");
	});

	it("preserves branch and tree traversal after stubbing old active-branch entries", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage(userMsg(largeText("root")));
		const oldAssistantId = session.appendMessage(assistantMsg(largeText("old assistant")));
		const firstKeptId = session.appendMessage(userMsg("kept"));
		session.appendMessage(assistantMsg("kept answer"));
		const compactionId = session.appendCompaction("summary", firstKeptId, 10_000);

		session.pruneResidentHistoryAfterCompaction(compactionId);
		session.branch(oldAssistantId);
		const branchId = session.appendMessage(userMsg("alternate branch"));

		expect(session.getBranch(branchId).map((entry) => entry.id)).toEqual([rootId, oldAssistantId, branchId]);
		const context = session.buildSessionContext();
		expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		expect(JSON.stringify(context.messages)).toContain("Resident session payload pruned");
		const treeJson = JSON.stringify(session.getTree());
		expect(treeJson).toContain(rootId);
		expect(treeJson).toContain(branchId);
	});

	it("rehydrates durable payloads before rewinding into a pruned branch", () => {
		const tempDir = makeTempDir("resident-prune-rewind");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg(largeText("rewind user")));
		const oldAssistantId = session.appendMessage(assistantMsg(largeText("rewind assistant")));
		const firstKeptId = session.appendMessage(userMsg("kept after rewind point"));
		session.appendMessage(assistantMsg("kept response"));
		const compactionId = session.appendCompaction("summary", firstKeptId, 100_000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const fileHashBefore = sha256File(sessionFile);

		session.pruneResidentHistoryAfterCompaction(compactionId);
		expect(entryJson(session, oldAssistantId)).toContain("Resident session payload pruned");

		session.branch(oldAssistantId);
		expect(JSON.stringify(session.buildSessionContext())).toContain("rewind assistant");
		expect(entryJson(session, oldAssistantId)).toContain("rewind assistant");
		expect(sha256File(sessionFile)).toBe(fileHashBefore);
	});

	it("rehydrates a pruned ancestor when rewinding to a retained entry", () => {
		const tempDir = makeTempDir("resident-prune-retained-rewind");
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(userMsg(largeText("retained rewind user")));
		session.appendMessage(assistantMsg(largeText("retained rewind assistant")));
		const firstKeptId = session.appendMessage(userMsg("retained rewind target"));
		session.appendMessage(assistantMsg("kept response"));
		const compactionId = session.appendCompaction("summary", firstKeptId, 100_000);
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("expected persisted session file");
		const fileHashBefore = sha256File(sessionFile);

		session.pruneResidentHistoryAfterCompaction(compactionId);
		expect(JSON.stringify(session.getBranch(firstKeptId))).toContain("Resident session payload pruned");

		session.branch(firstKeptId);
		const context = JSON.stringify(session.buildSessionContext());
		expect(context).toContain("retained rewind assistant");
		expect(context).not.toContain("Resident session payload pruned");
		expect(sha256File(sessionFile)).toBe(fileHashBefore);
	});

	it("handles repeated compaction by stubbing only entries summarized by the latest boundary", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg(largeText("first old user")));
		session.appendMessage(assistantMsg(largeText("first old assistant")));
		const firstKeptId = session.appendMessage(userMsg("first kept"));
		session.appendMessage(assistantMsg("first kept answer"));
		const firstCompactionId = session.appendCompaction("first summary", firstKeptId, 20_000);
		session.pruneResidentHistoryAfterCompaction(firstCompactionId);

		session.appendMessage(userMsg(largeText("second old user")));
		session.appendMessage(assistantMsg(largeText("second old assistant")));
		const secondKeptId = session.appendMessage(userMsg("second kept"));
		session.appendMessage(assistantMsg("second kept answer"));
		const secondCompactionId = session.appendCompaction("second summary", secondKeptId, 40_000);
		const contextBefore = JSON.stringify(session.buildSessionContext());
		const payloadBefore = estimateResidentPayloadBytes(session.getEntries());

		const result = session.pruneResidentHistoryAfterCompaction(secondCompactionId);

		expect(result.compactionId).toBe(secondCompactionId);
		expect(result.entriesStubbed).toBeGreaterThanOrEqual(2);
		expect(result.payloadBytesAfter).toBeLessThan(payloadBefore);
		expect(JSON.stringify(session.buildSessionContext())).toBe(contextBefore);
	});
});
