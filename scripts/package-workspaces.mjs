import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

export function findPackageDirectories(root = "packages") {
	const packageDirectories = [];

	function visit(directory) {
		if (existsSync(join(directory, "package.json"))) {
			packageDirectories.push(directory);
		}

		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			visit(join(directory, entry.name));
		}
	}

	visit(root);
	return packageDirectories.sort();
}

/**
 * Packages vendored verbatim from upstream Pi. Their versions track upstream's
 * release rather than the fork's, so they stay out of lockstep bumps and out of
 * the internal dependency rewrite.
 */
export function isVendoredUpstreamPackage(name) {
	return typeof name === "string" && name.startsWith("@earendil-works/");
}
