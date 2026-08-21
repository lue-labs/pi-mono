#!/usr/bin/env node

// Runs the anti-slop Oxlint plugin over the fork's own source only.
//
// Nearly all source here is upstream-owned (earendil-works/pi-mono). Linting it
// reports thousands of findings the fork cannot act on: fixing an upstream file
// for style guarantees merge conflicts on every sync for zero fork value. So
// scope to files the fork ADDED — present in HEAD, absent from upstream/main's
// tip — which have no upstream counterpart and therefore cannot conflict.
//
// Same boundary and rationale as check-fork-delta-static.mjs.

import { execFileSync, spawnSync } from "node:child_process";

const UPSTREAM_URL = "https://github.com/earendil-works/pi-mono.git";
const LINTABLE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDED_PREFIXES = ["experiments/", "packages/coding-agent/test/fixtures/", "tools/oxlint/anti-slop/"];

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function ensureUpstream() {
	const remotes = git(["remote"]).split("\n");
	if (!remotes.includes("upstream")) {
		git(["remote", "add", "upstream", UPSTREAM_URL]);
	}

	try {
		git(["fetch", "upstream", "main", "--depth=1"]);
	} catch {
		git(["fetch", "upstream", "main"]);
	}
}

function forkAddedFiles() {
	const output = git(["diff", "--name-only", "--diff-filter=A", "upstream/main", "HEAD"]);
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((path) => path.length > 0)
		.filter((path) => LINTABLE_EXTENSIONS.test(path))
		.filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

ensureUpstream();
const files = forkAddedFiles();

if (files.length === 0) {
	console.log("lint:slop:fork-delta: no fork-added source files to lint");
	process.exit(0);
}

console.log(`lint:slop:fork-delta: linting ${files.length} fork-added file(s) vs upstream/main tip`);
const result = spawnSync("npx", ["oxlint", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
