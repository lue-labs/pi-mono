import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadAgentDefinitionsFromDirectory } from "../src/core/agents/loader.ts";
import { loadAgentRegistry } from "../src/core/agents/registry.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-agent-loader-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent markdown loader", () => {
	test("loads the official frontmatter subset", async () => {
		const dir = await makeTempDir();
		await writeFile(
			join(dir, "scout.md"),
			`---\nname: scout\ndescription: Fast recon\ntools: read, grep, Glob, ls\nmodel: inherit\ncontext: slim\ncacheProfile: stable\n---\nScout prompt.`,
		);

		const result = await loadAgentDefinitionsFromDirectory(dir, "user");
		expect(result.diagnostics).toEqual([]);
		expect(result.agents[0]).toMatchObject({
			id: "scout",
			description: "Fast recon",
			tools: ["read", "grep", "Glob", "ls"],
			model: "inherit",
			defaultContext: "slim",
			cacheProfile: "stable",
			prompt: "Scout prompt.",
			source: "user",
		});
	});

	test("invalid files warn and skip", async () => {
		const dir = await makeTempDir();
		await writeFile(join(dir, "bad.md"), "---\ndescription: Missing name\n---\nPrompt");

		const result = await loadAgentDefinitionsFromDirectory(dir, "user");
		expect(result.agents).toEqual([]);
		expect(result.diagnostics[0]?.message).toContain("Skipping invalid agent file");
	});

	test("project agents are excluded by default and override with explicit scope", async () => {
		const cwd = await makeTempDir();
		const projectAgents = join(cwd, ".pi", "agents");
		await mkdir(projectAgents, { recursive: true });
		await writeFile(
			join(projectAgents, "worker.md"),
			`---\nname: worker\ndescription: Project worker\n---\nProject prompt.`,
		);

		const defaultRegistry = await loadAgentRegistry({ cwd });
		expect(defaultRegistry.agents.find((agent) => agent.id === "worker")?.source).toBe("builtin");

		const projectRegistry = await loadAgentRegistry({ cwd, agentScope: "project" });
		expect(projectRegistry.agents.find((agent) => agent.id === "worker")).toMatchObject({
			source: "project",
			description: "Project worker",
		});
	});
});
