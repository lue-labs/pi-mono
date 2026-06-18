import type { AgentSessionRuntime, RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";

function success<T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: object | null): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

function error(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

export async function handleRpcCommand(runtime: AgentSessionRuntime, command: RpcCommand): Promise<RpcResponse> {
	const session = runtime.session;
	const id = command.id;

	switch (command.type) {
		case "prompt": {
			await session.prompt(command.message, {
				images: command.images,
				streamingBehavior: command.streamingBehavior,
				source: "rpc",
			});
			return success(id, "prompt");
		}

		case "abort": {
			await session.abort();
			return success(id, "abort");
		}

		case "get_state": {
			const state: RpcSessionState = {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				isStreaming: session.isStreaming,
				isCompacting: session.isCompacting,
				steeringMode: session.steeringMode,
				followUpMode: session.followUpMode,
				sessionFile: session.sessionFile,
				sessionId: session.sessionId,
				sessionName: session.sessionName,
				autoCompactionEnabled: session.autoCompactionEnabled,
				messageCount: session.messages.length,
				pendingMessageCount: session.pendingMessageCount,
			};
			return success(id, "get_state", state);
		}

		case "get_last_assistant_text": {
			const text = session.getLastAssistantText() ?? null;
			return success(id, "get_last_assistant_text", { text });
		}

		case "get_messages": {
			return success(id, "get_messages", { messages: session.messages });
		}

		default:
			return error(id, command.type, `Unsupported RPC command: ${command.type}`);
	}
}
