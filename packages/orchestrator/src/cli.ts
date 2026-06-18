#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as {
	version: string;
};

function printHelp(): void {
	console.log(`orchestrator v${packageJson.version}\n\nUsage:\n  orchestrator --help\n  orchestrator --version`);
}

const args = process.argv.slice(2);

if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	printHelp();
	process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
	console.log(packageJson.version);
	process.exit(0);
}

console.error(`Unknown command: ${args[0]}`);
printHelp();
process.exit(1);
