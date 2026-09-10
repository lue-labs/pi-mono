#!/usr/bin/env node

/**
 * Validates lockstep versions for published packages, then synchronizes
 * internal dependency versions in all workspace packages, including private ones.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories, isVendoredUpstreamPackage } from "./package-workspaces.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

/**
 * Point a specifier at `version` without changing how wide it is.
 *
 * The two paths that bump this repo disagree otherwise. Changesets — the path
 * releases actually take — maintains exact pins on the fork-owned packages,
 * while rewriting everything to `^` here widens them behind its back, so
 * running `npm run version:*` produces a diff that reverses the last release
 * commit. Widening is also not free: `^` on a package whose version is not the
 * fork's resolves to whatever gets published next, which is the same failure
 * `isVendoredUpstreamPackage` already exists to prevent.
 *
 * Returns null for anything that is not a plain `[^~]?<semver>` range —
 * `workspace:*`, `npm:` aliases, `>=`/`||` unions — because there is no
 * single version those can be retargeted to without changing their meaning.
 */
function retargetSpecifier(currentSpecifier, version) {
	const match = /^([\^~]?)\d+\.\d+\.\d+(?:[-+][-0-9A-Za-z.]+)?$/.exec(currentSpecifier);
	return match ? `${match[1]}${version}` : null;
}

const packageRoot = process.argv[2] ?? "packages";
const workspacePackages = findPackageDirectories(packageRoot)
	.filter((directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)))
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});
// Vendored upstream packages are versioned by upstream, so they neither join the
// fork's lockstep set nor supply versions for the dependency rewrite below.
const forkOwnedPackages = workspacePackages.filter((pkg) => !isVendoredUpstreamPackage(pkg.data.name));
const publishedPackages = forkOwnedPackages.filter((pkg) => pkg.data.private !== true);
const versionMap = new Map(forkOwnedPackages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("Current versions:");
for (const pkg of [...publishedPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

const versions = new Set(publishedPackages.map((pkg) => pkg.data.version));
if (versions.size > 1) {
	console.error("\nERROR: Not all non-private packages have the same version.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\nAll non-private packages are at the same version (lockstep).");

let totalUpdates = 0;
const updatedPackages = new Set();
for (const pkg of workspacePackages) {
	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// Registry aliases such as `npm:@earendil-works/pi-ai@0.1.2` are never workspace-linked,
			// so lockstep bumping them would point at a version that is not published yet.
			const version = versionMap.get(dependencyName);
			const newSpecifier = version ? retargetSpecifier(currentSpecifier, version) : null;
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
