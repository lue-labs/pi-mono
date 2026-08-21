import { describe, expect, it } from "vitest";
import { checkBashPolicy, EXPLORE_BASH_POLICY } from "../src/core/bash-policy.ts";

const policy = EXPLORE_BASH_POLICY;

describe("checkBashPolicy — unsafe shell constructs (read-only explore)", () => {
	it("rejects command substitution, backticks, and here-docs", () => {
		expect(checkBashPolicy("echo $(rm -rf x)", policy)).toContain("command substitution");
		expect(checkBashPolicy("echo `rm -rf x`", policy)).toContain("backtick");
		expect(checkBashPolicy("cat <<EOF\nrm -rf x\nEOF", policy)).toContain("here-doc");
	});

	it("rejects process substitution `<(...)` / `>(...)` — it runs an arbitrary command", () => {
		for (const command of [
			"cat <(rm -rf x)",
			"diff <(git show a) <(git show b)",
			"tee >(rm -rf x) < file",
			"while read l; do :; done < <(git branch)",
		]) {
			expect(checkBashPolicy(command, policy), command).toContain("process substitution");
		}
	});

	it("does not flag literal `<(` / `>(` inside single quotes", () => {
		expect(checkBashPolicy("git log --grep '<(pattern)'", policy)).toBeUndefined();
	});

	it("allows benign read-only commands", () => {
		expect(checkBashPolicy("git status", policy)).toBeUndefined();
		expect(checkBashPolicy("cat README.md", policy)).toBeUndefined();
		expect(checkBashPolicy("git log --oneline -5", policy)).toBeUndefined();
	});
});
