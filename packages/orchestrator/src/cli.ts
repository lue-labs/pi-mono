#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { getSocketPath } from "./config.ts";
import { sendIpcRequest } from "./ipc/client.ts";
import { encodeMessage } from "./ipc/protocol.ts";
import { serve } from "./serve.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8")) as {
	version: string;
};

function printHelp(): void {
	console.log(
		`orchestrator v${packageJson.version}\n\nUsage:\n  orchestrator serve\n  orchestrator list\n  orchestrator spawn [--cwd <path>] [--label <label>]\n  orchestrator status <instance-id>\n  orchestrator stop <instance-id>\n  orchestrator rpc <instance-id> <json-command>\n  orchestrator attach <instance-id>\n  orchestrator --help\n  orchestrator --version`,
	);
}

function printResponse(response: unknown): void {
	console.log(JSON.stringify(response, null, 2));
}

function getFlagValue(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index === -1 || index + 1 >= args.length) {
		return undefined;
	}
	return args[index + 1];
}

async function attach(instanceId: string): Promise<void> {
	const socket = createConnection(getSocketPath());
	process.stdin.setEncoding("utf8");

	await new Promise<void>((resolve, reject) => {
		socket.once("connect", () => {
			socket.write(encodeMessage({ type: "attach", instanceId }));
			resolve();
		});
		socket.once("error", reject);
	});

	socket.on("data", (chunk: Buffer | string) => {
		process.stdout.write(chunk.toString());
	});
	socket.on("error", (error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
	socket.on("end", () => {
		process.exit(0);
	});
	process.stdin.on("data", (chunk: string) => {
		const lines = chunk
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		for (const line of lines) {
			socket.write(encodeMessage({ type: "attach_rpc", command: JSON.parse(line) }));
		}
	});
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printHelp();
		process.exit(0);
	}

	if (args[0] === "--version" || args[0] === "-v") {
		console.log(packageJson.version);
		process.exit(0);
	}

	if (args[0] === "serve") {
		await serve();
		return;
	}

	if (args[0] === "list") {
		printResponse(await sendIpcRequest({ type: "list" }));
		return;
	}

	if (args[0] === "spawn") {
		const spawnCwd = getFlagValue(args, "--cwd") ?? cwd();
		const label = getFlagValue(args, "--label");
		printResponse(await sendIpcRequest({ type: "spawn", cwd: spawnCwd, label }));
		return;
	}

	if (args[0] === "status") {
		const instanceId = args[1];
		if (!instanceId) {
			console.error("Usage: orchestrator status <instance-id>");
			process.exit(1);
		}
		printResponse(await sendIpcRequest({ type: "status", instanceId }));
		return;
	}

	if (args[0] === "stop") {
		const instanceId = args[1];
		if (!instanceId) {
			console.error("Usage: orchestrator stop <instance-id>");
			process.exit(1);
		}
		printResponse(await sendIpcRequest({ type: "stop", instanceId }));
		return;
	}

	if (args[0] === "rpc") {
		const instanceId = args[1];
		const commandJson = args[2];
		if (!instanceId || !commandJson) {
			console.error("Usage: orchestrator rpc <instance-id> <json-command>");
			process.exit(1);
		}
		printResponse(
			await sendIpcRequest({
				type: "rpc",
				instanceId,
				command: JSON.parse(commandJson),
			}),
		);
		return;
	}

	if (args[0] === "attach") {
		const instanceId = args[1];
		if (!instanceId) {
			console.error("Usage: orchestrator attach <instance-id>");
			process.exit(1);
		}
		await attach(instanceId);
		return;
	}

	console.error(`Unknown command: ${args[0]}`);
	printHelp();
	process.exit(1);
}

await main();
