#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const DEFAULT_BASE_REF = process.env.CHANGELOG_BASE_REF ?? "origin/main";
const diffRange = process.argv[2] ?? `${DEFAULT_BASE_REF}...HEAD`;

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function parseNames(output) {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

// Committed range plus anything staged. The staged half matters when this runs from the
// pre-commit hook: the commit being created is not in HEAD yet, so a range-only view is
// always one commit behind and the very commit that adds the required changelog entry
// would be rejected for not having it.
function changedFiles() {
	const committed = parseNames(git(["diff", "--name-only", diffRange]));
	let staged = [];
	try {
		staged = parseNames(git(["diff", "--name-only", "--cached"]));
	} catch {
		staged = [];
	}
	return [...new Set([...committed, ...staged])];
}

function isChangelog(path) {
	return path === "FORK-CHANGELOG.md" || /(^|\/)CHANGELOG\.md$/.test(path);
}

function isDocsOnly(path) {
	return path.startsWith("docs/") || path.endsWith(".md") || path.endsWith(".mdx");
}

function isTestOnly(path) {
	return /(^|\/)(test|tests|__tests__|fixtures)\//.test(path) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);
}

// Generated lockfiles have no documentable surface. Match by basename, not an exact root
// path: the fork's npm-shrinkwrap.json lives at packages/coding-agent/npm-shrinkwrap.json.
function isLockfile(path) {
	return /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(path);
}

function isVersionLine(content) {
	// A package's own version bump or an internal @lue-labs/* dependency pin bump, e.g.
	//   "version": "0.80.3",
	//   "@lue-labs/pi-ai": "0.80.3",
	const semver = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
	return (
		new RegExp(String.raw`^"version":\s*"${semver}",?$`).test(content) ||
		new RegExp(String.raw`^"@lue-labs/[^"]+":\s*"[~^]?${semver}",?$`).test(content)
	);
}

// A package.json whose diff only bumps the package's own version and/or internal
// @lue-labs/* dependency pins is a release-mechanical change (like a lockfile), not a
// documentable surface change — the changesets "version packages" PR (config changelog:
// false) lands here. Any other changed line (new dep, script, config) still requires a
// changelog entry.
function isVersionOnlyPackageJson(path) {
	if (!/(^|\/)package\.json$/.test(path)) return false;
	let diff;
	try {
		diff = git(["diff", "--unified=0", diffRange, "--", path]);
		// Staged-only edits are invisible to the range diff (see changedFiles).
		if (diff.trim() === "") diff = git(["diff", "--unified=0", "--cached", "--", path]);
	} catch {
		return false;
	}
	let sawChange = false;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (!line.startsWith("+") && !line.startsWith("-")) continue;
		const content = line.slice(1).trim();
		if (content === "") continue;
		sawChange = true;
		if (!isVersionLine(content)) return false;
	}
	return sawChange;
}

function isIgnored(path) {
	return (
		isChangelog(path) ||
		isDocsOnly(path) ||
		isTestOnly(path) ||
		path.startsWith(".github/") ||
		isLockfile(path) ||
		isVersionOnlyPackageJson(path)
	);
}

function requiredChangelog(path) {
	if (isIgnored(path)) return undefined;
	const packageMatch = /^packages\/([^/]+)\//.exec(path);
	if (packageMatch) return `packages/${packageMatch[1]}/CHANGELOG.md`;
	return "FORK-CHANGELOG.md";
}

const files = changedFiles();
const changed = new Set(files);
const required = new Set(files.map(requiredChangelog).filter(Boolean));
// Fork convention: FORK-CHANGELOG.md is the home for all fork-specific notes, so a
// touched FORK-CHANGELOG.md also satisfies any package-CHANGELOG requirement.
// Package CHANGELOGs stay reserved for upstream / upstreamable release notes and may
// still be updated directly, but are no longer mandatory for a fork change.
const forkChangelogTouched = changed.has("FORK-CHANGELOG.md");
const missing = [...required].filter(
	(path) => !changed.has(path) && !(forkChangelogTouched && path !== "FORK-CHANGELOG.md"),
);

if (missing.length === 0) {
	console.log("Changelog check passed.");
	process.exit(0);
}

console.error("Changelog check failed.");
console.error("");
console.error(`Diff range: ${diffRange}`);
console.error("");
console.error("Update the changelog file that matches the changed surface:");
for (const path of missing) {
	console.error(`  - ${path}`);
}
console.error("");
console.error(
	"Docs-only, tests-only, workflow-only, lockfile-only, and version-bump-only changes are ignored.",
);
process.exit(1);
