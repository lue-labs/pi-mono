import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { findAgentChain, loadAgentChainRegistry } from "../src/core/agents/chains.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-chains-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("native saved agent chains", () => {
	test("loads project chain json", async () => {
		const cwd = await makeTempDir();
		const chainsDir = join(cwd, ".pi", "chains");
		await mkdir(chainsDir, { recursive: true });
		await writeFile(
			join(chainsDir, "review.json"),
			JSON.stringify({
				name: "review",
				description: "Review workflow",
				chain: [
					{ agent: "scout", task: "Map the code" },
					{ agent: "reviewer", task: "Review {previous}", context: "slim", outputMode: "file" },
				],
			}),
		);

		const registry = await loadAgentChainRegistry(cwd);
		const chain = findAgentChain(registry, "review");
		expect(chain).toMatchObject({ name: "review", source: "project", description: "Review workflow" });
		expect(chain?.chain).toHaveLength(2);
		expect(chain?.chain[1]).toMatchObject({ agent: "reviewer", context: "slim", outputMode: "file" });
	});

	test("loads Claude-style aliases in saved chain json", async () => {
		const cwd = await makeTempDir();
		const chainsDir = join(cwd, ".pi", "chains");
		await mkdir(chainsDir, { recursive: true });
		await writeFile(
			join(chainsDir, "review.json"),
			JSON.stringify({
				name: "review",
				chain: [{ subagent_type: "reviewer", prompt: "Review {previous}", context: "slim" }],
			}),
		);

		const registry = await loadAgentChainRegistry(cwd);
		const chain = findAgentChain(registry, "review");
		expect(chain?.chain[0]).toMatchObject({ agent: "reviewer", task: "Review {previous}", context: "slim" });
		expect(registry.diagnostics).toEqual([]);
	});

	test("reports invalid chain definitions", async () => {
		const cwd = await makeTempDir();
		const chainsDir = join(cwd, ".pi", "chains");
		await mkdir(chainsDir, { recursive: true });
		await writeFile(join(chainsDir, "bad.json"), JSON.stringify({ name: "bad", chain: [] }));

		const registry = await loadAgentChainRegistry(cwd);
		expect(registry.chains).toEqual([]);
		expect(registry.diagnostics[0]?.message).toContain("Skipping invalid chain");
	});
});
