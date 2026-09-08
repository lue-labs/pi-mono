#!/usr/bin/env node

/**
 * `npm version --workspaces` has no exclude flag, but vendored upstream packages
 * carry upstream's version rather than the fork's. Bumping them rewrites the
 * dependents' pins to a version that was never published, so name the fork-owned
 * workspaces explicitly instead.
 *
 * Usage: node scripts/version-workspaces.mjs [npm flags...] <increment-or-version>
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isVendoredUpstreamPackage } from "./package-workspaces.mjs";

const args = process.argv.slice(2);
const npmFlags = args.filter((arg) => arg.startsWith("-"));
const targets = args.filter((arg) => !arg.startsWith("-"));
if (targets.length !== 1) {
	console.error("usage: version-workspaces.mjs [npm flags...] <increment-or-version>");
	process.exit(1);
}

/** Expand the root `workspaces` entries. Only a trailing `/*` is used in this repo. */
function resolveWorkspaceDirectories() {
	const patterns = JSON.parse(readFileSync("package.json", "utf8")).workspaces ?? [];
	const directories = [];
	for (const pattern of patterns) {
		if (!pattern.endsWith("/*")) {
			directories.push(pattern);
			continue;
		}
		const parent = pattern.slice(0, -2);
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(parent, entry.name, "package.json"))) {
				directories.push(join(parent, entry.name));
			}
		}
	}
	return directories.sort();
}

const forkOwnedDirectories = resolveWorkspaceDirectories().filter((directory) => {
	const { name } = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	return !isVendoredUpstreamPackage(name);
});

const result = spawnSync(
	"npm",
	["version", targets[0], ...npmFlags, ...forkOwnedDirectories.map((directory) => `--workspace=${directory}`)],
	{ stdio: "inherit" },
);
process.exit(result.status ?? 1);
