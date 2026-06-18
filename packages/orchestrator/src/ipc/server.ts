import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { getSocketPath } from "../config.ts";
import {
	type AttachClientRequest,
	type AttachReadyResponse,
	type AttachRequest,
	type AttachRpcResponse,
	type ErrorResponse,
	encodeMessage,
	type ListRequest,
	type ListResponse,
	type OrchestratorRequest,
	type OrchestratorResponse,
	parseRequestLine,
	type RpcBridgeResponse,
	type RpcRequest,
	type SpawnRequest,
	type SpawnResponse,
	type StatusRequest,
	type StatusResponse,
	type StopRequest,
	type StopResponse,
} from "./protocol.ts";

export interface IpcRequestHandler {
	(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse> | SpawnResponse | ErrorResponse;
	(request: ListRequest): Promise<ListResponse | ErrorResponse> | ListResponse | ErrorResponse;
	(request: StopRequest): Promise<StopResponse | ErrorResponse> | StopResponse | ErrorResponse;
	(request: StatusRequest): Promise<StatusResponse | ErrorResponse> | StatusResponse | ErrorResponse;
	(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse> | RpcBridgeResponse | ErrorResponse;
	(request: AttachRequest): Promise<AttachReadyResponse | ErrorResponse> | AttachReadyResponse | ErrorResponse;
	(request: OrchestratorRequest): Promise<OrchestratorResponse> | OrchestratorResponse;
	attach(
		instanceId: string,
		onEvent: (response: AttachRpcResponse) => void,
		onSessionEvent: (event: import("@earendil-works/pi-coding-agent").AgentSessionEvent) => void,
	):
		| {
				handleRequest(request: AttachClientRequest): Promise<void>;
				close(): void;
		  }
		| undefined;
}

export async function startIpcServer(handler: IpcRequestHandler): Promise<Server> {
	const socketPath = getSocketPath();
	await removeStaleSocketIfNeeded(socketPath);

	const server = createServer((socket) => {
		let buffer = "";

		socket.on("data", async (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				return;
			}

			try {
				const request = parseRequestLine(line);
				if (request.type === "attach") {
					const response = await handler(request);
					if (!response.ok || !response.instance) {
						socket.end(encodeMessage(response));
						return;
					}

					const attachment = handler.attach(
						request.instanceId,
						(response) => {
							socket.write(encodeMessage(response));
						},
						(event) => {
							socket.write(encodeMessage({ type: "attach_event", event }));
						},
					);
					if (!attachment) {
						socket.end(
							encodeMessage({ type: "error", ok: false, error: `Unknown instance: ${request.instanceId}` }),
						);
						return;
					}

					socket.write(encodeMessage(response));
					socket.removeAllListeners("data");
					socket.on("data", (attachChunk: Buffer | string) => {
						buffer += attachChunk.toString();
						for (;;) {
							const attachNewlineIndex = buffer.indexOf("\n");
							if (attachNewlineIndex === -1) {
								break;
							}
							const attachLine = buffer.slice(0, attachNewlineIndex).trim();
							buffer = buffer.slice(attachNewlineIndex + 1);
							if (!attachLine) {
								continue;
							}
							void (async () => {
								try {
									const attachRequest = JSON.parse(attachLine) as AttachClientRequest;
									await attachment.handleRequest(attachRequest);
								} catch (attachError) {
									socket.write(
										encodeMessage({
											type: "error",
											ok: false,
											error: attachError instanceof Error ? attachError.message : String(attachError),
										}),
									);
								}
							})();
						}
					});
					socket.once("close", () => attachment.close());
					return;
				}

				const response = await handler(request);
				socket.end(encodeMessage(response));
			} catch (error) {
				const response: ErrorResponse = {
					type: "error",
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
				socket.end(encodeMessage(response));
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return server;
}

async function removeStaleSocketIfNeeded(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	const isLive = await isSocketLive(socketPath);
	if (isLive) {
		throw new Error(`orchestrator is already running: ${socketPath}`);
	}

	unlinkSync(socketPath);
}

async function isSocketLive(socketPath: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;

		const finish = (result: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};

		socket.on("connect", () => finish(true));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				finish(false);
				return;
			}
			if (error.code === "EPIPE" || error.code === "ECONNRESET") {
				finish(false);
				return;
			}
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			reject(error);
		});
	});
}
