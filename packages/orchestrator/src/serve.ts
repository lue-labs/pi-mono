import { existsSync, unlinkSync } from "node:fs";
import { getSocketPath } from "./config.ts";
import { handleIpcRequest } from "./handler.ts";
import { startIpcServer } from "./ipc/server.ts";

export async function serve(): Promise<void> {
	const socketPath = getSocketPath();
	const server = await startIpcServer(handleIpcRequest);

	const cleanup = () => {
		server.close();
		if (existsSync(socketPath)) {
			unlinkSync(socketPath);
		}
	};

	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});

	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
}
