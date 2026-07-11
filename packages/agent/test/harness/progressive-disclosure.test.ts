import { type TSchema, Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { AgentTool } from "../../src/index.ts";
import {
	createOpenClawProgressiveDisclosureTools,
	estimateHarnessToolSchemaChars,
	formatProgressiveSkillsForSystemPrompt,
} from "../../src/index.ts";

function tool(
	name: string,
	description: string,
	parameters: TSchema = Type.Object({ value: Type.String(), noisy: Type.Optional(Type.String()) }),
): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

const skills = [
	{
		name: "wordpress-update",
		description: "Production WordPress and WooCommerce updates.",
		content: "# WordPress Update\nRun the safe update checklist.",
		filePath: "/skills/wordpress-update/SKILL.md",
	},
	{
		name: "cloudflare-registrar",
		description: "Domain availability and registration.",
		content: "# Cloudflare Registrar\nUse registrar APIs carefully.",
		filePath: "/skills/cloudflare-registrar/SKILL.md",
	},
];

function bulkyOpenClawTool(index: number): AgentTool {
	const properties: Record<string, TSchema> = {};
	for (let property = 0; property < 14; property += 1) {
		properties[`field_${property}`] = Type.String({
			description: `OpenClaw runtime option ${property} for tool ${index}. This description stands in for large MCP-style schemas.`,
		});
	}
	return tool(
		`openclaw_tool_${index}`,
		`OpenClaw runtime tool ${index} with a large provider schema.`,
		Type.Object(properties),
	);
}

function catalogSkill(index: number) {
	return {
		name: `skill-${index}`,
		description: `OpenClaw specialized workflow ${index} with enough detail to look like a real model-visible catalog entry.`,
		content: `# Skill ${index}\nDetailed instructions live here.`,
		filePath: `/skills/skill-${index}/SKILL.md`,
	};
}

describe("OpenClaw progressive disclosure helpers", () => {
	it("reduces OpenClaw-sized first-turn tool and skill context", () => {
		const runtimeTools = Array.from({ length: 55 }, (_value, index) => bulkyOpenClawTool(index));
		let activeToolNames = ["tool_search", "skill_search"];
		let progressiveTools: AgentTool[] = [];
		progressiveTools = createOpenClawProgressiveDisclosureTools({
			getTools: (): AgentTool[] => [...progressiveTools, ...runtimeTools],
			getActiveToolNames: () => activeToolNames,
			setActiveToolNames: (toolNames: string[]) => {
				activeToolNames = toolNames;
			},
			getSkills: () => Array.from({ length: 22 }, (_value, index) => catalogSkill(index)),
		});
		const fullSchemaChars = estimateHarnessToolSchemaChars(runtimeTools);
		const progressiveSchemaChars = estimateHarnessToolSchemaChars(progressiveTools);
		const skillPrompt = formatProgressiveSkillsForSystemPrompt(
			Array.from({ length: 22 }, (_value, index) => catalogSkill(index)),
		);

		expect(fullSchemaChars).toBeGreaterThan(40_996);
		expect(progressiveSchemaChars).toBeLessThan(1_600);
		expect(progressiveTools).toHaveLength(2);
		expect(skillPrompt.length).toBeLessThan(260);
		expect(skillPrompt).toContain("22 available");
		expect(skillPrompt).not.toContain("skill-0");
	});

	it("keeps first-turn tool schemas to search tools and activates matches on demand", async () => {
		const runtimeTools = [
			tool("message", "Send a website or sidebar message."),
			tool("woocommerce__add_to_cart", "Add a product to the WooCommerce cart."),
			tool("cron", "Schedule recurring background jobs."),
		];
		let activeToolNames = ["tool_search", "skill_search"];
		let searchTools: AgentTool[] = [];
		searchTools = createOpenClawProgressiveDisclosureTools({
			getTools: (): AgentTool[] => [...searchTools, ...runtimeTools],
			getActiveToolNames: () => activeToolNames,
			setActiveToolNames: (toolNames: string[]) => {
				activeToolNames = toolNames;
			},
			getSkills: () => skills,
		});

		expect(searchTools.map((candidate) => candidate.name)).toEqual(["tool_search", "skill_search"]);
		expect(estimateHarnessToolSchemaChars(searchTools)).toBeLessThan(1600);

		const result = await searchTools[0].execute("call-1", { query: "cart" });

		expect(activeToolNames).toEqual(["tool_search", "skill_search", "woocommerce__add_to_cart"]);
		expect(result.content).toEqual([{ type: "tool_reference", name: "woocommerce__add_to_cart" }]);
	});

	it("searches skills without putting the full catalog in the prompt", async () => {
		let activeToolNames = ["tool_search", "skill_search"];
		let progressiveTools: AgentTool[] = [];
		progressiveTools = createOpenClawProgressiveDisclosureTools({
			getTools: (): AgentTool[] => progressiveTools,
			getActiveToolNames: () => activeToolNames,
			setActiveToolNames: (toolNames: string[]) => {
				activeToolNames = toolNames;
			},
			getSkills: () => skills,
		});
		const prompt = formatProgressiveSkillsForSystemPrompt(skills);

		expect(prompt).toContain("Use skill_search");
		expect(prompt).toContain("2 available");
		expect(prompt).not.toContain("wordpress-update");
		expect(prompt.length).toBeLessThan(260);

		const listResult = await progressiveTools[1].execute("call-2", { query: "woocommerce" });
		expect(listResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("wordpress-update"),
		});
		expect(String(listResult.content[0].type === "text" ? listResult.content[0].text : "")).not.toContain(
			"Run the safe update checklist.",
		);

		const loadResult = await progressiveTools[1].execute("call-3", { name: "wordpress-update" });
		expect(loadResult.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Run the safe update checklist."),
		});
	});
});
