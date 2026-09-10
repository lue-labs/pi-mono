import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const syncVersionsScript = fileURLToPath(new URL("./sync-versions.js", import.meta.url));

async function writeManifest(root, relativeDirectory, manifest) {
	const directory = join(root, relativeDirectory);
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function readManifest(root, relativeDirectory) {
	return JSON.parse(await readFile(join(root, relativeDirectory, "package.json"), "utf8"));
}

function runSyncVersions(root) {
	return spawnSync(process.execPath, [syncVersionsScript, join(root, "packages")], {
		cwd: root,
		encoding: "utf8",
	});
}

test("synchronizes fork-owned dependencies without touching vendored packages, registry aliases, generated manifests, or published lockstep", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-"));
	try {
		await writeManifest(root, "packages/ai", {
			name: "@lue-labs/pi-ai",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/coding-agent", {
			name: "@lue-labs/pi-coding-agent",
			version: "2.0.0",
		});
		// Vendored upstream package: published, and deliberately off the fork's lockstep.
		await writeManifest(root, "packages/chord", {
			name: "@earendil-works/chord",
			version: "9.9.9",
		});
		await writeManifest(root, "packages/evals", {
			name: "@earendil-works/pi-evals",
			version: "9.9.9",
			private: true,
			dependencies: {
				"@lue-labs/pi-coding-agent": "^1.0.0",
				"@earendil-works/chord": "9.9.9",
				"@mariozechner/pi-ai": "npm:@earendil-works/pi-ai@1.0.0",
			},
		});
		await writeManifest(root, "packages/coding-agent/install-lock", {
			name: "generated-install-lock",
			version: "0.0.0",
			private: true,
			dependencies: {
				"@lue-labs/pi-coding-agent": "^1.0.0",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const evalsManifest = await readManifest(root, "packages/evals");
		assert.equal(evalsManifest.dependencies["@lue-labs/pi-coding-agent"], "^2.0.0");
		// Vendored versions are upstream's, so the exact pin must survive the rewrite:
		// a caret range would resolve to whatever upstream publishes next.
		assert.equal(evalsManifest.dependencies["@earendil-works/chord"], "9.9.9");
		assert.equal(evalsManifest.dependencies["@mariozechner/pi-ai"], "npm:@earendil-works/pi-ai@1.0.0");
		const generatedManifest = await readManifest(root, "packages/coding-agent/install-lock");
		assert.equal(generatedManifest.dependencies["@lue-labs/pi-coding-agent"], "^1.0.0");

		await writeManifest(root, "packages/ai", {
			name: "@lue-labs/pi-ai",
			version: "3.0.0",
		});
		const lockstepFailure = runSyncVersions(root);
		assert.equal(lockstepFailure.status, 1, lockstepFailure.stderr);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retargets each internal dependency without widening or narrowing its range", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-sync-versions-range-"));
	try {
		await writeManifest(root, "packages/ai", { name: "@lue-labs/pi-ai", version: "2.0.0" });
		await writeManifest(root, "packages/coding-agent", {
			name: "@lue-labs/pi-coding-agent",
			version: "2.0.0",
		});
		await writeManifest(root, "packages/consumer", {
			name: "@lue-labs/pi-consumer",
			version: "2.0.0",
			private: true,
			dependencies: {
				// Changesets maintains exact pins on fork-owned packages; a caret
				// here would reverse the last release commit on the next bump.
				"@lue-labs/pi-ai": "1.0.0",
				"@lue-labs/pi-coding-agent": "~1.0.0",
			},
			devDependencies: {
				// No single version expresses these, so they are left alone rather
				// than collapsed to a release that may not exist.
				"@lue-labs/pi-ai": "workspace:*",
			},
		});

		const result = runSyncVersions(root);
		assert.equal(result.status, 0, result.stderr);

		const consumer = await readManifest(root, "packages/consumer");
		assert.equal(consumer.dependencies["@lue-labs/pi-ai"], "2.0.0");
		assert.equal(consumer.dependencies["@lue-labs/pi-coding-agent"], "~2.0.0");
		assert.equal(consumer.devDependencies["@lue-labs/pi-ai"], "workspace:*");

		// Running again must be a no-op: the churn this prevents is what made the
		// two bump paths disagree in the first place.
		const rerun = runSyncVersions(root);
		assert.equal(rerun.status, 0, rerun.stderr);
		assert.match(rerun.stdout, /already in sync/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
