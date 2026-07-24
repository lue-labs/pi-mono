import { applyPatch } from "diff";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";
import { computeEditsDiff } from "../src/core/tools/edit-diff.ts";
import { buildBfsArgs, buildFdArgs, buildRgFilesArgs } from "../src/core/tools/glob.ts";
import { buildRgArgs, buildUgrepArgs } from "../src/core/tools/grep.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import {
	createEditTool,
	createGlobTool,
	createGlobToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "../src/index.ts";
import * as shellModule from "../src/utils/shell.ts";

const readTool = createReadTool(process.cwd());
const writeTool = createWriteTool(process.cwd());
const editTool = createEditTool(process.cwd());
const bashTool = createBashTool(process.cwd());
const grepTool = createGrepTool(process.cwd());
const globTool = createGlobTool(process.cwd());
const lsTool = createLsTool(process.cwd());

describe("built-in tool names", () => {
	it("registers Claude-style Glob and the remaining built-ins", () => {
		const tools = createAllToolDefinitions(process.cwd());
		for (const name of ["Bash", "Agent", "Task", "Glob"]) {
			expect(tools).toHaveProperty(name);
			expect(tools[name as keyof typeof tools].name).toBe(name);
		}
		for (const name of ["read", "bash", "edit", "write", "grep", "ls", "agent"]) {
			expect(tools).toHaveProperty(name);
			expect(tools[name as keyof typeof tools].name).toBe(name);
		}
		expect(tools).not.toHaveProperty("find");
		expect(tools).not.toHaveProperty("Find");
	});
});

describe("built-in tool execution modes", () => {
	it("marks read-only tools parallel and side-effecting tools sequential", () => {
		const tools = createAllToolDefinitions(process.cwd());

		for (const name of ["read", "grep", "Glob", "ls", "bash_output", "BashOutput", "agent", "Agent", "Task"]) {
			expect(tools[name as keyof typeof tools].executionMode).toBe("parallel");
		}

		for (const name of ["bash", "Bash", "edit", "write", "bash_kill", "KillShell"]) {
			expect(tools[name as keyof typeof tools].executionMode).toBe("sequential");
		}
	});
});

describe("full opt-out param", () => {
	it("exposes an optional boolean `full` on every truncating tool", () => {
		const tools = createAllToolDefinitions(process.cwd());
		for (const name of ["read", "bash", "grep", "Glob", "ls"]) {
			const props = (tools[name as keyof typeof tools].parameters as any)?.properties ?? {};
			expect(props.full, `${name} should expose a full param`).toBeDefined();
			expect(props.full.type).toBe("boolean");
			// must be opt-in: not in the schema's required set
			const required = (tools[name as keyof typeof tools].parameters as any)?.required ?? [];
			expect(required).not.toContain("full");
		}
	});
});

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("read tool", () => {
		it("should read file contents that fit within limits", async () => {
			const testFile = join(testDir, "test.txt");
			const content = "Hello, world!\nLine 2\nLine 3";
			writeFileSync(testFile, content);

			const result = await readTool.execute("test-call-1", { path: testFile });

			expect(getTextOutput(result)).toBe(content);
			// No truncation message since file fits within limits
			expect(getTextOutput(result)).not.toContain("Use offset=");
			expect(result.details).toBeUndefined();
		});

		it("should handle non-existent files", async () => {
			const testFile = join(testDir, "nonexistent.txt");

			await expect(readTool.execute("test-call-2", { path: testFile })).rejects.toThrow(/ENOENT|not found/i);
		});

		it("should truncate files exceeding line limit", async () => {
			const testFile = join(testDir, "large.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-3", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).not.toContain("Line 2001");
			expect(output).toContain("[Showing lines 1-2000 of 2500. Use offset=2001 to continue.]");
		});

		it("should return the entire file when full is set, lifting the line cap", async () => {
			const testFile = join(testDir, "large-full.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-full", { path: testFile, full: true });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 2000");
			expect(output).toContain("Line 2500");
			expect(output).not.toContain("Use offset=");
		});

		it("should truncate when byte limit exceeded", async () => {
			const testFile = join(testDir, "large-bytes.txt");
			// Create file that exceeds 50KB byte limit but has fewer than 2000 lines
			const lines = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-4", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1:");
			// Should show byte limit message
			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("should handle offset parameter", async () => {
			const testFile = join(testDir, "offset-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-5", { path: testFile, offset: 51 });
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 50");
			expect(output).toContain("Line 51");
			expect(output).toContain("Line 100");
			// No truncation message since file fits within limits
			expect(output).not.toContain("Use offset=");
		});

		it("should handle limit parameter", async () => {
			const testFile = join(testDir, "limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-6", { path: testFile, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 1");
			expect(output).toContain("Line 10");
			expect(output).not.toContain("Line 11");
			expect(output).toContain("[90 more lines in file (100 lines total). Use offset=11 to continue.]");
		});

		it("should handle offset + limit together", async () => {
			const testFile = join(testDir, "offset-limit-test.txt");
			const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-7", {
				path: testFile,
				offset: 41,
				limit: 20,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("Line 40");
			expect(output).toContain("Line 41");
			expect(output).toContain("Line 60");
			expect(output).not.toContain("Line 61");
			expect(output).toContain("[40 more lines in file (100 lines total). Use offset=61 to continue.]");
		});

		it("should return actionable bounds when offset is beyond file length", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-8", { path: testFile, offset: 100, limit: 20 });
			const output = getTextOutput(result);

			expect(output).toContain("Requested lines 100-119");
			expect(output).toContain("has only 3 lines");
			expect(output).toContain("Last valid offset is 3");
			expect(output).toContain("read with offset=1, limit=3");
		});

		it("should report the total line count at EOF for bounded reads", async () => {
			const testFile = join(testDir, "bounded-eof.txt");
			writeFileSync(testFile, "Line 1\nLine 2\nLine 3");

			const result = await readTool.execute("test-call-bounded-eof", { path: testFile, offset: 2, limit: 10 });
			const output = getTextOutput(result);

			expect(output).toContain("Line 2");
			expect(output).toContain("Line 3");
			expect(output).toContain("[End of file: requested through line 11, file has 3 lines.]");
		});

		it("should include truncation details when truncated", async () => {
			const testFile = join(testDir, "large-file.txt");
			const lines = Array.from({ length: 2500 }, (_, i) => `Line ${i + 1}`);
			writeFileSync(testFile, lines.join("\n"));

			const result = await readTool.execute("test-call-9", { path: testFile });

			expect(result.details).toBeDefined();
			expect(result.details?.truncation).toBeDefined();
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(result.details?.truncation?.totalLines).toBe(2500);
			expect(result.details?.truncation?.outputLines).toBe(2000);
		});

		it("should detect image MIME type from file magic (not extension)", async () => {
			const png1x1Base64 =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
			const pngBuffer = Buffer.from(png1x1Base64, "base64");

			const testFile = join(testDir, "image.txt");
			writeFileSync(testFile, pngBuffer);

			const result = await readTool.execute("test-call-img-1", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(typeof imageBlock?.data).toBe("string");
			expect((imageBlock?.data ?? "").length).toBeGreaterThan(0);
		});

		it("should read BMP files from disk as PNG image attachments", async () => {
			const testFile = join(testDir, "image.bmp");
			writeFileSync(testFile, createTinyBmp1x1Red24bpp());

			const result = await readTool.execute("test-call-img-bmp", { path: testFile });

			expect(result.content[0]?.type).toBe("text");
			expect(getTextOutput(result)).toContain("Read image file [image/png]");
			expect(getTextOutput(result)).toContain("[Image converted from image/bmp to image/png.]");

			const imageBlock = result.content.find(
				(c): c is { type: "image"; mimeType: string; data: string } => c.type === "image",
			);
			expect(imageBlock).toBeDefined();
			expect(imageBlock?.mimeType).toBe("image/png");
			expect(Buffer.from(imageBlock?.data ?? "", "base64")[0]).toBe(0x89);
		});

		it("should treat files with image extension but non-image content as text", async () => {
			const testFile = join(testDir, "not-an-image.png");
			writeFileSync(testFile, "<html><body>definitely not a png</body></html>");

			const result = await readTool.execute("test-call-img-2", { path: testFile });
			const output = getTextOutput(result);

			expect(output).toContain("<html><body>definitely not a png</body></html>");
			expect(output).not.toContain("Read image file");
			expect(result.content.some((c: any) => c.type === "image")).toBe(false);
		});
	});

	describe("write tool", () => {
		it("should write file contents", async () => {
			const testFile = join(testDir, "write-test.txt");
			const content = "Test content";

			const result = await writeTool.execute("test-call-3", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
			expect(getTextOutput(result)).toContain(testFile);
			expect(result.details).toBeUndefined();
		});

		it("should create parent directories", async () => {
			const testFile = join(testDir, "nested", "dir", "test.txt");
			const content = "Nested content";

			const result = await writeTool.execute("test-call-4", { path: testFile, content });

			expect(getTextOutput(result)).toContain("Successfully wrote");
		});
	});

	describe("edit tool", () => {
		it("should replace text in file", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			const result = await editTool.execute("test-call-5", {
				path: testFile,
				edits: [{ oldText: "world", newText: "testing" }],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced");
			expect(result.details).toBeDefined();
			expect(result.details.diff).toBeDefined();
			expect(typeof result.details.diff).toBe("string");
			expect(result.details.diff).toContain("testing");
			expect(result.details.patch).toContain("--- ");
			expect(result.details.patch).toContain("+++ ");
			expect(result.details.patch).toContain("@@");
			expect(result.details.patch).toContain("-Hello, world!");
			expect(result.details.patch).toContain("+Hello, testing!");
			expect(applyPatch(originalContent, result.details.patch)).toBe("Hello, testing!");
			expect("originalContent" in result.details).toBe(false);
			expect("originalContentPreview" in result.details).toBe(false);
		});

		it("should fail if text not found", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "Hello, world!";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-6", {
					path: testFile,
					edits: [{ oldText: "nonexistent", newText: "testing" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
		});

		it("should include ENOENT when the edit target does not exist", async () => {
			const missingFile = join(testDir, "missing.txt");

			await expect(
				editTool.execute("test-call-6b", {
					path: missingFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${missingFile}. Error code: ENOENT.`);
		});

		it("should fail if text appears multiple times", async () => {
			const testFile = join(testDir, "edit-test.txt");
			const originalContent = "foo foo foo";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-7", {
					path: testFile,
					edits: [{ oldText: "foo", newText: "bar" }],
				}),
			).rejects.toThrow(/Found 3 occurrences/);
		});

		it("should reject quote-normalized fuzzy replacements", async () => {
			const testFile = join(testDir, "edit-fuzzy-quotes.txt");
			const originalContent = "const message = “hello”;\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-exact-quotes", {
					path: testFile,
					edits: [{ oldText: 'const message = "hello";\n', newText: 'const message = "goodbye";\n' }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should reject whitespace-normalized fuzzy replacements", async () => {
			const testFile = join(testDir, "edit-fuzzy-whitespace.txt");
			const originalContent = "alpha   \nbeta\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-exact-whitespace", {
					path: testFile,
					edits: [{ oldText: "alpha\nbeta\n", newText: "ALPHA\nbeta\n" }],
				}),
			).rejects.toThrow(/Could not find the exact text/);
			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should reject dash-normalized fuzzy replacements in previews", async () => {
			const testFile = join(testDir, "edit-fuzzy-dash-preview.txt");
			writeFileSync(testFile, "alpha—beta\n");

			const result = await computeEditsDiff(
				testFile,
				[{ oldText: "alpha-beta\n", newText: "ALPHA-BETA\n" }],
				testDir,
			);

			expect(result).toEqual({
				error: `Could not find the exact text in ${testFile}. The old text must match exactly including all whitespace and newlines.`,
			});
		});

		it("should reject overlapping duplicate exact matches", async () => {
			const testFile = join(testDir, "edit-overlapping-dups.txt");
			writeFileSync(testFile, "aaa");

			await expect(
				editTool.execute("test-call-overlapping-dups", {
					path: testFile,
					edits: [{ oldText: "aa", newText: "AA" }],
				}),
			).rejects.toThrow(/Found 2 occurrences/);
		});

		it("should replace multiple disjoint regions in one call", async () => {
			const testFile = join(testDir, "edit-multi.txt");
			writeFileSync(testFile, "alpha\nbeta\ngamma\ndelta\n");

			const result = await editTool.execute("test-call-8", {
				path: testFile,
				edits: [
					{ oldText: "alpha\n", newText: "ALPHA\n" },
					{ oldText: "gamma\n", newText: "GAMMA\n" },
				],
			});

			expect(getTextOutput(result)).toContain("Successfully replaced 2 block(s)");
			expect(readFileSync(testFile, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
			expect(result.details?.diff).toContain("ALPHA");
			expect(result.details?.diff).toContain("GAMMA");
		});

		it("should collapse large unchanged gaps in multi-edit diffs", async () => {
			const testFile = join(testDir, "edit-multi-large-gap.txt");
			const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`);
			writeFileSync(testFile, `${lines.join("\n")}\n`);

			const result = await editTool.execute("test-call-8b", {
				path: testFile,
				edits: [
					{ oldText: "line 100\n", newText: "LINE 100\n" },
					{ oldText: "line 300\n", newText: "LINE 300\n" },
					{ oldText: "line 500\n", newText: "LINE 500\n" },
				],
			});

			const diff = result.details?.diff ?? "";
			expect(diff).toContain("LINE 100");
			expect(diff).toContain("LINE 300");
			expect(diff).toContain("LINE 500");
			expect(diff).toContain("...");
			expect(diff).not.toContain("line 250");
			expect(diff.split("\n").length).toBeLessThan(50);
		});

		it("should match edits against the original file, not incrementally", async () => {
			const testFile = join(testDir, "edit-multi-original.txt");
			writeFileSync(testFile, "foo\nbar\nbaz\n");

			await editTool.execute("test-call-9", {
				path: testFile,
				edits: [
					{ oldText: "foo\n", newText: "foo bar\n" },
					{ oldText: "bar\n", newText: "BAR\n" },
				],
			});

			expect(readFileSync(testFile, "utf-8")).toBe("foo bar\nBAR\nbaz\n");
		});

		it("should fail when edits is empty", async () => {
			const testFile = join(testDir, "edit-empty-edits.txt");
			writeFileSync(testFile, "hello\nworld\n");

			await expect(
				editTool.execute("test-call-11", {
					path: testFile,
					edits: [],
				}),
			).rejects.toThrow(/edits must contain at least one replacement/);
		});

		it("should fail when multi-edit regions overlap", async () => {
			const testFile = join(testDir, "edit-overlap.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			await expect(
				editTool.execute("test-call-12", {
					path: testFile,
					edits: [
						{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
						{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
					],
				}),
			).rejects.toThrow(/overlap/);
		});

		it("should not partially apply edits when one edit fails", async () => {
			const testFile = join(testDir, "edit-no-partial.txt");
			const originalContent = "alpha\nbeta\ngamma\n";
			writeFileSync(testFile, originalContent);

			await expect(
				editTool.execute("test-call-13", {
					path: testFile,
					edits: [
						{ oldText: "alpha\n", newText: "ALPHA\n" },
						{ oldText: "missing\n", newText: "MISSING\n" },
					],
				}),
			).rejects.toThrow(/Could not find/);

			expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
		});

		it("should include EACCES for read-only files", async () => {
			const testFile = join(testDir, "edit-readonly.txt");
			writeFileSync(testFile, "hello\n");
			chmodSync(testFile, 0o444);

			await expect(
				editTool.execute("test-call-14", {
					path: testFile,
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow(`Could not edit file: ${testFile}. Error code: EACCES.`);
		});

		it("should include the original error message for unknown edit access errors", async () => {
			const genericFailureTool = createEditTool(testDir, {
				operations: {
					access: async () => {
						throw new Error("disk offline");
					},
					readFile: async () => Buffer.from("hello\n", "utf-8"),
					writeFile: async () => {},
				},
			});

			await expect(
				genericFailureTool.execute("test-call-16", {
					path: "broken.txt",
					edits: [{ oldText: "hello", newText: "world" }],
				}),
			).rejects.toThrow("Could not edit file: broken.txt. Error: disk offline.");
		});

		it("should include ENOENT in diff preview for missing files", async () => {
			const missingFile = join(testDir, "missing-preview.txt");
			const result = await computeEditsDiff(missingFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${missingFile}. Error code: ENOENT.` });
		});

		it("should include EACCES in diff preview for unreadable files", async () => {
			const unreadableFile = join(testDir, "unreadable-preview.txt");
			writeFileSync(unreadableFile, "hello\n");
			chmodSync(unreadableFile, 0o222);

			const result = await computeEditsDiff(unreadableFile, [{ oldText: "hello", newText: "world" }], testDir);

			expect(result).toEqual({ error: `Could not edit file: ${unreadableFile}. Error code: EACCES.` });
		});
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toBeUndefined();
		});

		it("should handle command errors", async () => {
			await expect(bashTool.execute("test-call-9", { command: "exit 1" })).rejects.toThrow(
				/(Command failed|code 1)/,
			);
		});

		it("should respect timeout", async () => {
			await expect(bashTool.execute("test-call-10", { command: "sleep 5", timeout: 1 })).rejects.toThrow(
				/timed out/i,
			);
		});

		it("should include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "Command timed out after 5 seconds" },
				{ error: "aborted", expected: "Command aborted" },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
				expect(message).not.toContain("Full output: undefined");
				const fullOutputPath = message.match(/Full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should send commands over stdin when shell resolution requires it", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const chunks: Buffer[] = [];
			const ops = createLocalBashOperations({ shellPath: "C:\\Windows\\System32\\bash.exe" });
			const nameExpansion = "$" + "{name}";
			const countExpansion = "$" + "{count}";
			const iExpansion = "$" + "{i}";
			const command = `name='World'; echo "Hello, ${nameExpansion}!"; count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`;

			const result = await ops.exec(command, testDir, {
				onData: (data) => chunks.push(data),
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe(command);
		});

		it("should resolve legacy WSL bash.exe to stdin command transport", () => {
			if (process.platform === "win32") return;
			const originalCwd = process.cwd();
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const shellPath = "C:\\Windows\\System32\\bash.exe";
			writeFileSync(join(testDir, shellPath), "");
			try {
				process.chdir(testDir);
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});

				expect(shellModule.getShellConfig(shellPath)).toEqual({
					shell: shellPath,
					args: ["-s"],
					commandTransport: "stdin",
				});
			} finally {
				process.chdir(originalCwd);
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(getTextOutput(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(getTextOutput(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(getTextOutput(result).trim()).toBe("no-prefix");
		});

		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("should not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", { command: "many-lines" });
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(2000);
			expect(output).toContain("line-2001");
			expect(output).toContain("line-4000");
			expect(output).toMatch(/\[Showing lines 2001-4000 of 4000\. Full output: /);
			expect(output).not.toContain("4001");
		});

		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(getTextOutput(result).trim()).toBe("€");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output).toMatch(/\[Showing lines \d+-\d+ of \d+\. Full output: /);
			expect(output).not.toContain("Full output: undefined");

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});

	describe("grep tool", () => {
		it("should include filename when searching a single file", async () => {
			const testFile = join(testDir, "example.txt");
			writeFileSync(testFile, "first line\nmatch line\nlast line");

			const result = await grepTool.execute("test-call-11", {
				pattern: "match",
				path: testFile,
			});

			const output = getTextOutput(result);
			expect(output).toContain("example.txt:2: match line");
		});

		it("should respect global limit and include context lines", async () => {
			const testFile = join(testDir, "context.txt");
			const content = ["before", "match one", "after", "middle", "match two", "after two"].join("\n");
			writeFileSync(testFile, content);

			const result = await grepTool.execute("test-call-12", {
				pattern: "match",
				path: testFile,
				limit: 1,
				context: 1,
			});

			const output = getTextOutput(result);
			expect(output).toContain("context.txt-1- before");
			expect(output).toContain("context.txt:2: match one");
			expect(output).toContain("context.txt-3- after");
			expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
			// Ensure second match is not present
			expect(output).not.toContain("match two");
		});

		it("should treat flag-like patterns as search text", async () => {
			const marker = join(testDir, "grep-injection-marker");
			const payload = join(testDir, "payload.sh");
			const testFile = join(testDir, "target.txt");
			writeFileSync(payload, `#!/bin/sh\necho executed > ${marker}\ncat "$1"\n`);
			chmodSync(payload, 0o755);
			writeFileSync(testFile, "target\n");

			const result = await grepTool.execute("test-call-grep-injection", {
				pattern: `--pre=${payload}`,
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No matches found");
			expect(existsSync(marker)).toBe(false);
		});

		it("should include ordinary hidden files but skip VCS metadata", async () => {
			mkdirSync(join(testDir, ".git", "objects"), { recursive: true });
			mkdirSync(join(testDir, ".secret"));
			writeFileSync(join(testDir, ".git", "objects", "metadata.txt"), "hidden-needle in git metadata\n");
			writeFileSync(join(testDir, ".secret", "data.txt"), "hidden-needle in dot dir\n");
			writeFileSync(join(testDir, "source.txt"), "hidden-needle in source\n");

			const result = await grepTool.execute("test-call-grep-hidden-vcs", {
				pattern: "hidden-needle",
				path: testDir,
			});
			const output = getTextOutput(result);

			expect(output).toContain("source.txt");
			expect(output).toContain(".secret/data.txt");
			expect(output).not.toContain(".git/objects/metadata.txt");
		});

		it("should build ugrep argv with hidden, ignore-file, VCS exclusion, and glob defaults", () => {
			const args = buildUgrepArgs({
				pattern: "needle",
				searchPath: testDir,
				glob: "*.ts",
				ignoreCase: true,
				literal: true,
			});

			expect(args).toEqual(
				expect.arrayContaining([
					"--no-config",
					"-r",
					"-n",
					"--with-filename",
					"--ignore-files",
					"-.",
					"--color=never",
					"--exclude-dir",
					".git",
					"--ignore-case",
					"--fixed-strings",
					"-g",
					"*.ts",
				]),
			);
			expect(args.slice(-3)).toEqual(["--", "needle", testDir]);
		});

		it("should preserve rg argv with hidden files and VCS exclusion", () => {
			const args = buildRgArgs({ pattern: "needle", searchPath: testDir, glob: "*.ts" });

			expect(args).toEqual([
				"--json",
				"--line-number",
				"--color=never",
				"--hidden",
				"--glob",
				"!.git",
				"--glob",
				"!.svn",
				"--glob",
				"!.hg",
				"--glob",
				"!.bzr",
				"--glob",
				"!.jj",
				"--glob",
				"!.sl",
				"--glob",
				"*.ts",
				"--",
				"needle",
				testDir,
			]);
		});

		it("should add rg type filter when requested", () => {
			const args = buildRgArgs({ pattern: "needle", searchPath: testDir, type: "ts" });

			expect(args).toContain("--type");
			expect(args).toContain("ts");
			expect(args.slice(-3)).toEqual(["--", "needle", testDir]);
		});

		it("should expose Claude-style output fields in the schema", () => {
			const definition = createGrepToolDefinition(process.cwd());
			// Uppercase Grep is now extension-provided via native-tool-aliases.
			// Verify the lowercase factory still exposes the Claude-style fields.
			const properties = (definition.parameters as any).properties;

			expect(definition.name).toBe("grep");
			expect(properties.outputMode).toBeDefined();
			expect(properties.output_mode).toBeDefined();
			expect(properties.headLimit).toBeDefined();
			expect(properties.head_limit).toBeDefined();
			expect(properties.offset).toBeDefined();
			expect(properties.type).toBeDefined();
			expect(properties.multiline).toBeDefined();
		});

		it("should expose optional timeout in the schema", () => {
			const definition = createGrepToolDefinition(process.cwd());
			expect((definition.parameters as any).properties.timeout).toBeDefined();
			expect((definition.parameters as any).properties.timeout.exclusiveMinimum).toBe(0);
			expect((definition.parameters as any).properties.timeout.maximum).toBe(300);
		});

		it("should time out slow grep calls with an actionable result", async () => {
			const slowFile = join(testDir, "slow.txt");
			writeFileSync(slowFile, "match one\nmatch two\n");
			const tool = createGrepTool(testDir);

			const result = await tool.execute("test-call-grep-timeout", {
				pattern: "match",
				path: testDir,
				timeout: 0.001,
			});

			expect((result as any).isError).toBe(true);
			expect(result.details?.timedOut).toBe(true);
			expect(result.details?.timeoutMs).toBe(1);
			expect(result.details?.matchesReturned).toBeGreaterThanOrEqual(0);
			expect(getTextOutput(result)).toContain("grep timed out after 1ms");
			expect(getTextOutput(result)).toContain("Retry with a narrower path/glob/pattern");
		});

		it("should keep old grep calls in content mode by default", async () => {
			const testFile = join(testDir, "old-default.txt");
			writeFileSync(testFile, "first\nneedle line\nlast\n");

			const result = await grepTool.execute("test-call-grep-old-default", {
				pattern: "needle",
				path: testFile,
			});

			expect(getTextOutput(result)).toContain("old-default.txt:2: needle line");
			expect(result.details?.mode).toBe("content");
		});

		it("should support grep content output mode", async () => {
			const testFile = join(testDir, "content-mode.txt");
			writeFileSync(testFile, "needle one\nother\nneedle two\n");

			const result = await grepTool.execute("test-call-grep-content-mode", {
				pattern: "needle",
				path: testFile,
				outputMode: "content",
			});
			const output = getTextOutput(result);

			expect(output).toContain("content-mode.txt:1: needle one");
			expect(output).toContain("content-mode.txt:3: needle two");
			expect(result.details?.mode).toBe("content");
		});

		it("should support grep files_with_matches output mode", async () => {
			writeFileSync(join(testDir, "one.txt"), "needle\n");
			writeFileSync(join(testDir, "two.txt"), "needle\nneedle\n");
			writeFileSync(join(testDir, "miss.txt"), "nothing\n");

			const result = await grepTool.execute("test-call-grep-files-mode", {
				pattern: "needle",
				path: testDir,
				output_mode: "files_with_matches",
			});
			const output = getTextOutput(result);

			expect(output).toContain("one.txt");
			expect(output).toContain("two.txt");
			expect(output).not.toContain("miss.txt");
			expect(output).not.toContain(":1:");
			expect(result.details?.mode).toBe("files_with_matches");
			expect(result.details?.numFiles).toBe(2);
		});

		it("should support grep count output mode", async () => {
			writeFileSync(join(testDir, "one.txt"), "needle\n");
			writeFileSync(join(testDir, "two.txt"), "needle\nneedle\n");

			const result = await grepTool.execute("test-call-grep-count-mode", {
				pattern: "needle",
				path: testDir,
				outputMode: "count",
			});
			const output = getTextOutput(result);

			expect(output).toContain("one.txt:1");
			expect(output).toContain("two.txt:2");
			expect(result.details?.mode).toBe("count");
			expect(result.details?.numMatches).toBe(3);
		});

		it("should support headLimit and offset pagination", async () => {
			const testFile = join(testDir, "paged.txt");
			writeFileSync(testFile, "needle 1\nneedle 2\nneedle 3\nneedle 4\n");

			const result = await grepTool.execute("test-call-grep-head-offset", {
				pattern: "needle",
				path: testFile,
				outputMode: "content",
				headLimit: 2,
				offset: 1,
			});
			const output = getTextOutput(result);

			expect(output).not.toContain("needle 1");
			expect(output).toContain("paged.txt:2: needle 2");
			expect(output).toContain("paged.txt:3: needle 3");
			expect(output).not.toContain("needle 4");
			expect(result.details?.appliedLimit).toBe(2);
			expect(result.details?.appliedOffset).toBe(1);
		});

		it("should support head_limit alias", async () => {
			const testFile = join(testDir, "snake-paged.txt");
			writeFileSync(testFile, "needle 1\nneedle 2\nneedle 3\n");

			const result = await grepTool.execute("test-call-grep-head-limit", {
				pattern: "needle",
				path: testFile,
				output_mode: "content",
				head_limit: 1,
			});
			const output = getTextOutput(result);

			expect(output).toContain("snake-paged.txt:1: needle 1");
			expect(output).not.toContain("needle 2");
			expect(result.details?.appliedLimit).toBe(1);
		});

		it("full:true lifts the default 100-entry output cap, returning every match", async () => {
			const testFile = join(testDir, "many-matches.txt");
			writeFileSync(testFile, `${Array.from({ length: 150 }, (_, i) => `needle ${i + 1}`).join("\n")}\n`);

			// Default: capped (backend match limit collects only the first 100).
			const capped = await grepTool.execute("test-call-grep-full-capped", {
				pattern: "needle",
				path: testFile,
				outputMode: "content",
			});
			expect(getTextOutput(capped)).not.toContain("needle 150");

			// full:true: backend collects all matches AND the default output-entry
			// head cap is lifted, so every one of the 150 matches is returned.
			// (Pre-fix this sliced to 100 via the default headLimit -> appliedLimit=100.)
			const result = await grepTool.execute("test-call-grep-full", {
				pattern: "needle",
				path: testFile,
				outputMode: "content",
				full: true,
			});
			expect(result.details?.appliedLimit).toBeUndefined();
			const output = getTextOutput(result);
			expect(output).toContain("many-matches.txt:1: needle 1");
			expect(output).toContain("many-matches.txt:150: needle 150");
		});

		it("bounds large full grep output before joining formatted lines", async () => {
			const testFile = join(testDir, "many-large-matches.txt");
			const largeSuffix = "x".repeat(1200);
			writeFileSync(
				testFile,
				`${Array.from({ length: 300 }, (_, i) => `needle ${i + 1} ${largeSuffix}`).join("\n")}\n`,
			);

			const result = await grepTool.execute("test-call-grep-full-large-bounded", {
				pattern: "needle",
				path: testFile,
				outputMode: "content",
				full: true,
			});
			const output = getTextOutput(result);

			expect(Buffer.byteLength(output, "utf-8")).toBeLessThan(60 * 1024);
			expect(output).toContain("many-large-matches.txt:1: needle 1");
			expect(output).not.toContain("needle 300");
			expect(output).toContain("50.0KB limit reached");
			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.outputBytes).toBeLessThanOrEqual(50 * 1024);
		});

		it("should match across lines with multiline:true", async () => {
			const testFile = join(testDir, "multiline.txt");
			writeFileSync(testFile, "needle\nacross\nunrelated\n");

			const result = await grepTool.execute("test-call-grep-multiline", {
				pattern: "needle.*across",
				path: testFile,
				multiline: true,
			});
			const output = getTextOutput(result);

			expect(output).toContain("multiline.txt:1: needle");
			expect(output).toContain("multiline.txt-2- across");
			expect(output).not.toContain("unrelated");
		});

		it("should not match across lines without multiline", async () => {
			const testFile = join(testDir, "multiline-off.txt");
			writeFileSync(testFile, "needle\nacross\n");

			const result = await grepTool.execute("test-call-grep-multiline-off", {
				pattern: "needle.*across",
				path: testFile,
			});

			expect(getTextOutput(result)).toContain("No matches found");
		});

		it("should honor explicit higher grep timeout", async () => {
			const testFile = join(testDir, "explicit-timeout.txt");
			writeFileSync(testFile, "needle\n");

			const result = await grepTool.execute("test-call-grep-explicit-timeout", {
				pattern: "needle",
				path: testFile,
				timeout: 1,
			});

			expect(getTextOutput(result)).toContain("explicit-timeout.txt:1: needle");
		});

		it("should distinguish grep AbortSignal cancellation from timeout", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				grepTool.execute(
					"test-call-grep-abort",
					{ pattern: "needle", path: testDir, timeout: 1 },
					controller.signal,
				),
			).rejects.toThrow("Operation aborted");
		});
	});

	describe("Glob tool", () => {
		it("should include hidden files that are not gitignored", async () => {
			const hiddenDir = join(testDir, ".secret");
			mkdirSync(hiddenDir);
			writeFileSync(join(hiddenDir, "hidden.txt"), "hidden");
			writeFileSync(join(testDir, "visible.txt"), "visible");

			const result = await globTool.execute("test-call-13", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);

			expect(outputLines).toContain("visible.txt");
			expect(outputLines).toContain(".secret/hidden.txt");
		});

		it("should respect .gitignore with the rg backend", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");
			const rgGlobTool = createGlobTool(testDir, { backend: "rg" });

			const result = await rgGlobTool.execute("test-call-glob-rg-ignore", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should include gitignored files with ignore:false on the rg backend", async () => {
			writeFileSync(join(testDir, ".gitignore"), ".pi/\n");
			mkdirSync(join(testDir, ".pi", "worktrees"), { recursive: true });
			writeFileSync(join(testDir, ".pi", "worktrees", "registry.json"), "{}\n");
			const rgGlobTool = createGlobTool(testDir, { backend: "rg" });

			const defaultResult = await rgGlobTool.execute("test-call-glob-rg-ignore-default", {
				pattern: "**/.pi/worktrees/registry.json",
				path: testDir,
			});
			expect(getTextOutput(defaultResult)).toContain("retry this Glob call with ignore:false");

			const noIgnoreResult = await rgGlobTool.execute("test-call-glob-rg-no-ignore", {
				pattern: "**/.pi/worktrees/registry.json",
				path: testDir,
				ignore: false,
			});

			expect(getTextOutput(noIgnoreResult)).toContain(".pi/worktrees/registry.json");
		});

		it("should respect .gitignore with the fd backend", async () => {
			writeFileSync(join(testDir, ".gitignore"), "ignored.txt\n");
			writeFileSync(join(testDir, "ignored.txt"), "ignored");
			writeFileSync(join(testDir, "kept.txt"), "kept");
			const fdGlobTool = createGlobTool(testDir, { backend: "fd" });

			const result = await fdGlobTool.execute("test-call-14", {
				pattern: "**/*.txt",
				path: testDir,
			});

			const output = getTextOutput(result);
			expect(output).toContain("kept.txt");
			expect(output).not.toContain("ignored.txt");
		});

		it("should include gitignored files with ignore:false on the fd backend", async () => {
			writeFileSync(join(testDir, ".gitignore"), ".pi/\n");
			mkdirSync(join(testDir, ".pi", "worktrees"), { recursive: true });
			writeFileSync(join(testDir, ".pi", "worktrees", "registry.json"), "{}\n");
			const fdGlobTool = createGlobTool(testDir, { backend: "fd" });

			const noIgnoreResult = await fdGlobTool.execute("test-call-glob-fd-no-ignore", {
				pattern: "**/.pi/worktrees/registry.json",
				path: testDir,
				ignore: false,
			});

			expect(getTextOutput(noIgnoreResult)).toContain(".pi/worktrees/registry.json");
		});

		it("should keep VCS metadata excluded with ignore:false on the fd backend", async () => {
			mkdirSync(join(testDir, ".git", "objects"), { recursive: true });
			writeFileSync(join(testDir, ".git", "objects", "metadata.txt"), "metadata");
			const fdGlobTool = createGlobTool(testDir, { backend: "fd" });

			const result = await fdGlobTool.execute("test-call-glob-fd-no-ignore-vcs", {
				pattern: "**/.git/objects/metadata.txt",
				path: testDir,
				ignore: false,
			});

			expect(getTextOutput(result)).toContain("No files found matching pattern");
			expect(getTextOutput(result)).not.toContain(".git/objects/metadata.txt");
		});

		it("should surface fd glob parse errors", async () => {
			const fdGlobTool = createGlobTool(testDir, { backend: "fd" });

			await expect(
				fdGlobTool.execute("test-call-15", {
					pattern: "[",
					path: testDir,
				}),
			).rejects.toThrow(/error parsing glob|fd exited with code 1|fd error/i);
		});

		it("should treat flag-like patterns as search text", async () => {
			const result = await globTool.execute("test-call-glob-flag-pattern", {
				pattern: "--help",
				path: testDir,
			});

			expect(getTextOutput(result)).toContain("No files found matching pattern");
		});

		it("should return rg-backed Glob results sorted by modification time", async () => {
			writeFileSync(join(testDir, "old.ts"), "old");
			writeFileSync(join(testDir, "new.ts"), "new");
			utimesSync(join(testDir, "old.ts"), new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
			utimesSync(join(testDir, "new.ts"), new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));
			const rgGlobTool = createGlobTool(testDir, { backend: "rg" });

			const result = await rgGlobTool.execute("test-call-glob-rg-mtime", {
				pattern: "*.ts",
				path: testDir,
			});

			const outputLines = getTextOutput(result)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
			expect(outputLines.indexOf("old.ts")).toBeLessThan(outputLines.indexOf("new.ts"));
		});

		it("should build rg files argv with modification sort, hidden files, VCS exclusion, and gitignore outside repos", () => {
			const args = buildRgFilesArgs({ searchPath: testDir, insideGitRepo: false });

			expect(args).toEqual([
				"--files",
				"--sort=modified",
				"--hidden",
				"--glob",
				"!.git",
				"--glob",
				"!.svn",
				"--glob",
				"!.hg",
				"--glob",
				"!.bzr",
				"--glob",
				"!.jj",
				"--glob",
				"!.sl",
				"--no-require-git",
				testDir,
			]);
		});

		it("should build rg files argv with --no-ignore when Glob ignore is false", () => {
			const args = buildRgFilesArgs({
				searchPath: testDir,
				insideGitRepo: true,
				ignore: false,
			});

			expect(args).toContain("--no-ignore");
			expect(args.indexOf("--no-ignore")).toBeLessThan(args.indexOf(testDir));
			expect(args).not.toContain("--no-require-git");
		});

		it("should build bfs argv for native file discovery fallback", () => {
			const args = buildBfsArgs({ pattern: "src/**/*.ts", searchPath: testDir, limit: 5 });

			expect(args).toEqual(
				expect.arrayContaining([
					testDir,
					"-s",
					"-exclude",
					"-name",
					".git",
					"-type",
					"f",
					"-path",
					"*/src/**/*.ts",
					"-print",
					"-limit",
					"5",
				]),
			);
		});

		it("should preserve fd fallback argv and ignore-aware defaults", () => {
			const args = buildFdArgs({ pattern: "src/**/*.ts", searchPath: testDir, limit: 5 });

			expect(args).toEqual([
				"--glob",
				"--color=never",
				"--hidden",
				"--exclude",
				".git",
				"--exclude",
				".svn",
				"--exclude",
				".hg",
				"--exclude",
				".bzr",
				"--exclude",
				".jj",
				"--exclude",
				".sl",
				"--no-require-git",
				"--max-results",
				"5",
				"--full-path",
				"--",
				"**/src/**/*.ts",
				testDir,
			]);
		});

		it("should build fd fallback argv with --no-ignore when Glob ignore is false", () => {
			const args = buildFdArgs({
				pattern: "src/**/*.ts",
				searchPath: testDir,
				limit: 5,
				insideGitRepo: true,
				ignore: false,
			});

			expect(args).toEqual([
				"--glob",
				"--color=never",
				"--hidden",
				"--exclude",
				".git",
				"--exclude",
				".svn",
				"--exclude",
				".hg",
				"--exclude",
				".bzr",
				"--exclude",
				".jj",
				"--exclude",
				".sl",
				"--no-ignore",
				"--max-results",
				"5",
				"--full-path",
				"--",
				"**/src/**/*.ts",
				testDir,
			]);
		});

		it("should expose optional timeout and ignore in the schema", () => {
			const definition = createGlobToolDefinition(process.cwd());
			expect((definition.parameters as any).properties.ignore).toBeDefined();
			expect((definition.parameters as any).properties.ignore.type).toBe("boolean");
			expect((definition.parameters as any).properties.timeout).toBeDefined();
			expect((definition.parameters as any).properties.timeout.exclusiveMinimum).toBe(0);
			expect((definition.parameters as any).properties.timeout.maximum).toBe(300);
		});

		it("should time out slow Glob calls with an actionable result", async () => {
			writeFileSync(join(testDir, "slow-glob.txt"), "contents");
			const result = await globTool.execute("test-call-glob-timeout", {
				pattern: "**/*",
				path: testDir,
				timeout: 0.001,
			});

			expect((result as any).isError).toBe(true);
			expect(result.details?.timedOut).toBe(true);
			expect(result.details?.timeoutMs).toBe(1);
			expect(result.details?.entriesReturned).toBeGreaterThanOrEqual(0);
			expect(getTextOutput(result)).toContain("Glob timed out after 1ms");
			expect(getTextOutput(result)).toContain("Retry with a narrower path/glob");
		});

		it("should honor explicit higher Glob timeout", async () => {
			writeFileSync(join(testDir, "explicit-timeout.ts"), "contents");

			const result = await globTool.execute("test-call-glob-explicit-timeout", {
				pattern: "**/*.ts",
				path: testDir,
				timeout: 1,
			});

			expect(getTextOutput(result)).toContain("explicit-timeout.ts");
		});

		it("should distinguish Glob AbortSignal cancellation from timeout", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				globTool.execute("test-call-glob-abort", { pattern: "**/*", path: testDir, timeout: 1 }, controller.signal),
			).rejects.toThrow("Operation aborted");
		});
	});

	describe("ls tool", () => {
		it("should list dotfiles and directories", async () => {
			writeFileSync(join(testDir, ".hidden-file"), "secret");
			mkdirSync(join(testDir, ".hidden-dir"));

			const result = await lsTool.execute("test-call-15", { path: testDir });
			const output = getTextOutput(result);

			expect(output).toContain(".hidden-file");
			expect(output).toContain(".hidden-dir/");
		});
	});
});

describe("edit tool exact matching", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-exact-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should reject text that only matches after trailing whitespace is stripped", async () => {
		const testFile = join(testDir, "trailing-ws.txt");
		const originalContent = "line one   \nline two  \nline three\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-trailing-ws", {
				path: testFile,
				edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should reject fullwidth punctuation normalization", async () => {
		const testFile = join(testDir, "chinese-punctuation.txt");
		const originalContent = "你好，世界\n你好（世界）\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-chinese", {
				path: testFile,
				edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should reject compatibility-equivalent Unicode forms", async () => {
		const testFile = join(testDir, "unicode-compatibility.txt");
		const originalContent = "ＡＢＣ１２３\ncafe\u0301\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-unicode", {
				path: testFile,
				edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should reject smart single quotes when oldText uses ASCII quotes", async () => {
		const testFile = join(testDir, "smart-quotes.txt");
		const originalContent = "console.log(\u2018hello\u2019);\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-single-quotes", {
				path: testFile,
				edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should reject smart double quotes when oldText uses ASCII quotes", async () => {
		const testFile = join(testDir, "smart-double-quotes.txt");
		const originalContent = "const msg = \u201CHello World\u201D;\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-double-quotes", {
				path: testFile,
				edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should reject Unicode dash normalization", async () => {
		const testFile = join(testDir, "unicode-dashes.txt");
		const originalContent = "range: 1\u20135\nbreak\u2014here\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-dashes", {
				path: testFile,
				edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should reject non-breaking space normalization", async () => {
		const testFile = join(testDir, "nbsp.txt");
		const originalContent = "hello\u00A0world\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-nbsp", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "hello universe" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});

	it("should still replace exact text", async () => {
		const testFile = join(testDir, "exact-replace.txt");
		writeFileSync(testFile, "const x = 'exact';\nconst y = 'other';\n");

		const result = await editTool.execute("test-exact-replace", {
			path: testFile,
			edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
		expect(readFileSync(testFile, "utf-8")).toBe("const x = 'changed';\nconst y = 'other';\n");
	});

	it("should fail when text is not found", async () => {
		const testFile = join(testDir, "no-match.txt");
		writeFileSync(testFile, "completely different content\n");

		await expect(
			editTool.execute("test-exact-no-match", {
				path: testFile,
				edits: [{ oldText: "this does not exist", newText: "replacement" }],
			}),
		).rejects.toThrow(/Could not find the exact text/);
	});

	it("should detect only exact duplicates", async () => {
		const testFile = join(testDir, "exact-dups.txt");
		writeFileSync(testFile, "hello world\nhello world\n");

		await expect(
			editTool.execute("test-exact-dups", {
				path: testFile,
				edits: [{ oldText: "hello world", newText: "replaced" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should reject fuzzy matches in multi-edit mode without partial writes", async () => {
		const testFile = join(testDir, "exact-multi.txt");
		const originalContent = "console.log(\u2018hello\u2019);\nhello\u00A0world\n";
		writeFileSync(testFile, originalContent);

		await expect(
			editTool.execute("test-exact-multi", {
				path: testFile,
				edits: [
					{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
					{ oldText: "hello world\n", newText: "hello universe\n" },
				],
			}),
		).rejects.toThrow(/Could not find edits\[0\]/);
		expect(readFileSync(testFile, "utf-8")).toBe(originalContent);
	});
});

describe("edit tool CRLF handling", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-crlf-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("should match LF oldText against CRLF file content", async () => {
		const testFile = join(testDir, "crlf-test.txt");

		writeFileSync(testFile, "line one\r\nline two\r\nline three\r\n");

		const result = await editTool.execute("test-crlf-1", {
			path: testFile,
			edits: [{ oldText: "line two\n", newText: "replaced line\n" }],
		});

		expect(getTextOutput(result)).toContain("Successfully replaced");
	});

	it("should preserve CRLF line endings after edit", async () => {
		const testFile = join(testDir, "crlf-preserve.txt");
		writeFileSync(testFile, "first\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-crlf-2", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve LF line endings for LF files", async () => {
		const testFile = join(testDir, "lf-preserve.txt");
		writeFileSync(testFile, "first\nsecond\nthird\n");

		await editTool.execute("test-lf-1", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("first\nREPLACED\nthird\n");
	});

	it("should detect duplicates across CRLF/LF variants", async () => {
		const testFile = join(testDir, "mixed-endings.txt");

		writeFileSync(testFile, "hello\r\nworld\r\n---\r\nhello\nworld\n");

		await expect(
			editTool.execute("test-crlf-dup", {
				path: testFile,
				edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }],
			}),
		).rejects.toThrow(/Found 2 occurrences/);
	});

	it("should preserve UTF-8 BOM after edit", async () => {
		const testFile = join(testDir, "bom-test.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\n");

		await editTool.execute("test-bom", {
			path: testFile,
			edits: [{ oldText: "second\n", newText: "REPLACED\n" }],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nREPLACED\r\nthird\r\n");
	});

	it("should preserve CRLF line endings and BOM in multi-edit mode", async () => {
		const testFile = join(testDir, "bom-crlf-multi.txt");
		writeFileSync(testFile, "\uFEFFfirst\r\nsecond\r\nthird\r\nfourth\r\n");

		await editTool.execute("test-crlf-multi", {
			path: testFile,
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		});

		const content = readFileSync(testFile, "utf-8");
		expect(content).toBe("\uFEFFfirst\r\nSECOND\r\nthird\r\nFOURTH\r\n");
	});
});
