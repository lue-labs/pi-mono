import { describe, expect, test } from "vitest";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test("keeps the fork bash definition's background-job guidance", () => {
		const definition = createBashToolDefinition("/workspace");

		expect(definition.promptSnippet).toContain("run_in_background:true");
		expect(definition.promptGuidelines).toEqual(
			expect.arrayContaining([
				"Always stop background jobs you started but no longer need with bash_kill(bgId).",
				"Inspect PI_* environment variables for current model and session details.",
			]),
		);
	});

	test("keeps bash session-environment guidance conditional without dropping fork guidance", () => {
		const definition = createBashToolDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toEqual(
			expect.arrayContaining(["Always stop background jobs you started but no longer need with bash_kill(bgId)."]),
		);
		expect(definition.promptGuidelines).not.toContain(
			"Inspect PI_* environment variables for current model and session details.",
		);
	});

	test("keeps powershell session-environment guidance conditional", () => {
		const definition = createPowerShellToolDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});
