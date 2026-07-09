#!/usr/bin/env node

// Advisory static analysis (knip + dependency-cruiser), scoped to the fork's delta against
// upstream/main. This is a long-lived fork of earendil-works/pi-mono: nearly all source is
// upstream-owned, so running knip/depcruise against the full tree mostly surfaces upstream
// findings we can't act on. Instead, resolve the merge-base with upstream, diff to find the
// files the fork actually touched, and filter both tools' findings down to that set.

import { execFileSync } from "node:child_process";

const STRICT = process.argv.includes("--strict");
const UPSTREAM_URL = "https://github.com/earendil-works/pi-mono.git";
const DELTA_GLOBS = [
	"packages/agent/src",
	"packages/ai/src",
	"packages/coding-agent/src",
	"packages/orchestrator/src",
	"packages/tui/src",
];
const DEPCRUISE_ARGS = [
	"packages/agent/src",
	"packages/ai/src",
	"packages/coding-agent/src",
	"packages/orchestrator/src",
	"packages/tui/src",
	"--config",
	".dependency-cruiser.cjs",
	"--output-type",
	"json",
];

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(args) {
	try {
		return { ok: true, output: git(args) };
	} catch (error) {
		return { ok: false, error };
	}
}

function ensureUpstreamRemote() {
	const remotes = git(["remote"]).split("\n").map((line) => line.trim()).filter(Boolean);
	if (!remotes.includes("upstream")) {
		git(["remote", "add", "upstream", UPSTREAM_URL]);
	}
}

function fetchUpstream() {
	// Only the upstream tip tree is needed (diff-filter=A against upstream/main),
	// so a shallow fetch suffices; fall back to a full fetch if it fails.
	let result = tryGit(["fetch", "upstream", "main", "--depth=1"]);
	if (!result.ok) {
		result = tryGit(["fetch", "upstream", "main"]);
	}
	return result.ok;
}

function computeDeltaFiles() {
	// Fork-ADDED files only: present in HEAD but absent from upstream/main's tip
	// (--diff-filter=A against the tip, not the merge-base — a merge-base diff also
	// counts files upstream added since divergence, which arrive via sync merges).
	// Files the fork merely modified still participate in upstream import
	// cycles/graphs, so including them drowns the report in inherited findings the
	// fork can't fix (~400 cycle warnings). Diff committed state (HEAD), not the
	// working tree, so dirty CI trees cannot widen the delta set.
	const output = git([
		"diff",
		"--name-only",
		"--diff-filter=A",
		"upstream/main",
		"HEAD",
		"--",
		...DELTA_GLOBS.map((dir) => `${dir}/**/*.ts`),
	]);
	return new Set(
		output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
}

const MAX_BUFFER = 64 * 1024 * 1024;

function runJson(command, args) {
	try {
		const output = execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_BUFFER,
		});
		return JSON.parse(output);
	} catch (error) {
		// knip/depcruise still exit non-zero on some runs even with --no-exit-code depending on
		// version/config; JSON is usually still on stdout, so try to recover it.
		const stdout = error?.stdout;
		if (typeof stdout === "string" && stdout.trim().length > 0) {
			try {
				return JSON.parse(stdout);
			} catch {
				// fall through
			}
		}
		throw error;
	}
}

const KNIP_ISSUE_TYPES = [
	"files",
	"dependencies",
	"devDependencies",
	"optionalPeerDependencies",
	"unlisted",
	"binaries",
	"unresolved",
	"exports",
	"types",
	"enumMembers",
	"duplicates",
	"namespaceMembers",
];

function filterKnipIssues(knipResult, deltaFiles) {
	const issues = knipResult.issues ?? [];
	const filtered = issues.filter((issue) => deltaFiles.has(issue.file));
	const countsByType = {};
	for (const issue of filtered) {
		for (const type of KNIP_ISSUE_TYPES) {
			const entries = issue[type];
			if (Array.isArray(entries) && entries.length > 0) {
				countsByType[type] = (countsByType[type] ?? 0) + entries.length;
			}
		}
	}
	// Fully-unused files live in a top-level `files: string[]` array in knip's JSON
	// reporter, not in `issues[]` — handle them separately so --strict sees them.
	const unusedFiles = (knipResult.files ?? []).filter((file) => deltaFiles.has(file));
	if (unusedFiles.length > 0) countsByType.files = unusedFiles.length;
	return { filtered, countsByType, unusedFiles };
}

function filterDepcruiseViolations(depcruiseResult, deltaFiles) {
	const violations = depcruiseResult.summary?.violations ?? [];
	return violations.filter((violation) => deltaFiles.has(violation.from));
}

function main() {
	ensureUpstreamRemote();

	const fetched = fetchUpstream();
	if (!fetched) {
		console.log(
			"check-fork-delta-static: could not fetch upstream (offline or network-restricted). Skipping fork-delta static analysis.",
		);
		process.exit(0);
	}

	const deltaFiles = computeDeltaFiles();
	console.log(`check-fork-delta-static: fork-added delta files=${deltaFiles.size} (vs upstream/main tip)`);

	if (deltaFiles.size === 0) {
		console.log("check-fork-delta-static: no fork-owned .ts changes in the delta set; nothing to check.");
		process.exit(0);
	}

	const knipResult = runJson("npx", ["knip", "--reporter", "json", "--no-exit-code"]);
	const { filtered: knipIssues, countsByType, unusedFiles } = filterKnipIssues(knipResult, deltaFiles);

	const depcruiseResult = runJson("npx", ["depcruise", ...DEPCRUISE_ARGS]);
	const depcruiseViolations = filterDepcruiseViolations(depcruiseResult, deltaFiles);

	console.log("");
	console.log("knip (fork-delta scoped):");
	if (Object.keys(countsByType).length === 0) {
		console.log("  no issues");
	} else {
		for (const [type, count] of Object.entries(countsByType)) {
			console.log(`  ${type}: ${count}`);
		}
	}

	console.log("");
	console.log(`dependency-cruiser (fork-delta scoped): ${depcruiseViolations.length} violation(s)`);
	for (const violation of depcruiseViolations) {
		const severity = violation.rule?.severity ?? "unknown";
		console.log(`  [${severity}] [${violation.rule?.name ?? "unknown"}] ${violation.from} -> ${violation.to}`);
	}

	// Error-severity depcruise rules (the package-boundary rules) are always blocking:
	// they encode hard architectural constraints on fork-added code and are green today.
	// Warn-severity (no-circular/no-orphans through upstream hubs) and knip stay advisory
	// unless --strict.
	const errorViolations = depcruiseViolations.filter((violation) => violation.rule?.severity === "error");
	if (errorViolations.length > 0) {
		console.error(`\ncheck-fork-delta-static: ${errorViolations.length} error-severity boundary violation(s) on fork-added files.`);
		process.exit(1);
	}

	const hasFindings = knipIssues.length > 0 || unusedFiles.length > 0 || depcruiseViolations.length > 0;
	if (STRICT && hasFindings) {
		console.error("\ncheck-fork-delta-static: --strict set and fork-delta findings exist.");
		process.exit(1);
	}

	process.exit(0);
}

main();
