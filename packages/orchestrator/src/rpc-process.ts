import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";

interface PendingRequest {
	resolve(response: RpcResponse): void;
	reject(error: Error): void;
}

export interface RpcProcessInstance {
	process: ChildProcess;
	send(command: RpcCommand): Promise<RpcResponse>;
	handleUiResponse(response: RpcExtensionUIResponse): void;
	setUiRequestHandler(handler?: (request: RpcExtensionUIRequest) => void): void;
	onEvent(listener: (event: AgentSessionEvent) => void): () => void;
	onExit(listener: (error?: Error) => void): () => void;
	dispose(): Promise<void>;
}

function resolveCodingAgentCli(): string {
	const require = createRequire(import.meta.url);
	return require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function createRpcProcessInstance(options: { cwd: string }): RpcProcessInstance {
	const cliPath = resolveCodingAgentCli();
	const child = spawn(process.execPath, [cliPath, "--mode", "rpc"], {
		cwd: options.cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	if (!child.stdin || !child.stdout) {
		throw new Error("Failed to create RPC process stdio");
	}

	let exited = false;
	let nextRequestId = 0;
	let stdoutBuffer = "";
	let stderrBuffer = "";
	const pendingRequests = new Map<string, PendingRequest>();
	const eventListeners = new Set<(event: AgentSessionEvent) => void>();
	const exitListeners = new Set<(error?: Error) => void>();

	const rejectAllPending = (error: Error) => {
		for (const [id, pending] of pendingRequests) {
			pendingRequests.delete(id);
			pending.reject(error);
		}
	};

	const notifyExit = (error?: Error) => {
		for (const listener of exitListeners) {
			listener(error);
		}
	};

	let uiRequestHandler: ((request: RpcExtensionUIRequest) => void) | undefined;

	const handleLine = (line: string) => {
		const parsed = JSON.parse(line) as { type?: string; id?: string };

		switch (parsed.type) {
			case "response": {
				if (!parsed.id) {
					return;
				}
				const pending = pendingRequests.get(parsed.id);
				if (!pending) {
					return;
				}
				pendingRequests.delete(parsed.id);
				pending.resolve(parsed as RpcResponse);
				return;
			}

			case "extension_ui_request": {
				uiRequestHandler?.(parsed as RpcExtensionUIRequest);
				return;
			}

			default: {
				for (const listener of eventListeners) {
					listener(parsed as AgentSessionEvent);
				}
			}
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdoutBuffer += chunk;
		while (true) {
			const newlineIndex = stdoutBuffer.indexOf("\n");
			if (newlineIndex === -1) {
				break;
			}
			const line = stdoutBuffer.slice(0, newlineIndex).trim();
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (!line) {
				continue;
			}
			handleLine(line);
		}
	});

	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderrBuffer += chunk;
	});

	child.once("error", (error) => {
		exited = true;
		const wrapped = new Error(`RPC process error: ${error.message}. Stderr: ${stderrBuffer}`);
		rejectAllPending(wrapped);
		notifyExit(wrapped);
	});

	child.once("exit", (code, signal) => {
		exited = true;
		const error = new Error(`RPC process exited (code=${code} signal=${signal}). Stderr: ${stderrBuffer}`);
		rejectAllPending(error);
		notifyExit(error);
	});

	const send = async (command: RpcCommand): Promise<RpcResponse> => {
		if (exited) {
			throw new Error(`RPC process is not running. Stderr: ${stderrBuffer}`);
		}
		const id = command.id ?? `orchestrator_${++nextRequestId}_${randomUUID()}`;
		const fullCommand = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			pendingRequests.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify(fullCommand)}\n`, (error) => {
				if (!error) {
					return;
				}
				pendingRequests.delete(id);
				reject(toError(error));
			});
		});
	};

	return {
		process: child,
		send,
		handleUiResponse(response) {
			if (exited) {
				return;
			}
			child.stdin.write(`${JSON.stringify(response)}\n`);
		},
		setUiRequestHandler(handler) {
			uiRequestHandler = handler;
		},
		onEvent(listener) {
			eventListeners.add(listener);
			return () => {
				eventListeners.delete(listener);
			};
		},
		onExit(listener) {
			exitListeners.add(listener);
			return () => {
				exitListeners.delete(listener);
			};
		},
		async dispose() {
			uiRequestHandler = undefined;
			rejectAllPending(new Error("RPC process disposed"));
			if (exited) {
				return;
			}
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				child.once("exit", () => resolve());
			});
		},
	};
}
