#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const myPiDir = process.env.MY_PI_EXTENSION_GATE_DIR
	? resolve(process.env.MY_PI_EXTENSION_GATE_DIR)
	: resolve(repoRoot, "..", "my-pi");
const packageJson = resolve(myPiDir, "package.json");

if (!existsSync(packageJson)) {
	console.log(`skip test:my-pi-extensions: sibling repo not present at ${myPiDir}`);
	process.exit(0);
}

const status = spawnSync("git", ["-C", myPiDir, "status", "--porcelain"], {
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
});

if (status.status !== 0) {
	console.error(`error: unable to inspect my-pi dirty state at ${myPiDir}`);
	if (status.stderr) console.error(status.stderr.trim());
	process.exit(status.status ?? 1);
}

if (status.stdout.trim()) {
	console.warn(`warning: skipping test:my-pi-extensions because ${myPiDir} has uncommitted changes`);
	console.warn(`warning: run \`npm --prefix ${myPiDir} run test:extension-gate:ci\` from a clean my-pi checkout for full coverage`);
	process.exit(0);
}

const gate = spawnSync("npm", ["--prefix", myPiDir, "run", "test:extension-gate:ci"], {
	stdio: "inherit",
});

process.exit(gate.status ?? 1);
