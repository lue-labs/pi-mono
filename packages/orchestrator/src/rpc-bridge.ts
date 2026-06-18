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

function unsupported(id: string | undefined, command: RpcCommand["type"]): RpcResponse {
	return error(id, command, `Unsupported RPC command in orchestrator bridge: ${command}`);
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

		case "steer": {
			await session.steer(command.message, command.images);
			return success(id, "steer");
		}

		case "follow_up": {
			await session.followUp(command.message, command.images);
			return success(id, "follow_up");
		}

		case "abort": {
			await session.abort();
			return success(id, "abort");
		}

		case "new_session":
		case "switch_session":
		case "fork":
		case "clone":
			return unsupported(id, command.type);

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

		case "set_model": {
			const models = await session.modelRegistry.getAvailable();
			const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!model) {
				return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
			}
			await session.setModel(model);
			return success(id, "set_model", model);
		}

		case "cycle_model": {
			const result = await session.cycleModel();
			return success(id, "cycle_model", result ?? null);
		}

		case "get_available_models": {
			const models = await session.modelRegistry.getAvailable();
			return success(id, "get_available_models", { models });
		}

		case "set_thinking_level": {
			session.setThinkingLevel(command.level);
			return success(id, "set_thinking_level");
		}

		case "cycle_thinking_level": {
			const level = session.cycleThinkingLevel();
			return success(id, "cycle_thinking_level", level ? { level } : null);
		}

		case "set_steering_mode": {
			session.setSteeringMode(command.mode);
			return success(id, "set_steering_mode");
		}

		case "set_follow_up_mode": {
			session.setFollowUpMode(command.mode);
			return success(id, "set_follow_up_mode");
		}

		case "compact": {
			const result = await session.compact(command.customInstructions);
			return success(id, "compact", result);
		}

		case "set_auto_compaction": {
			session.setAutoCompactionEnabled(command.enabled);
			return success(id, "set_auto_compaction");
		}

		case "set_auto_retry": {
			session.setAutoRetryEnabled(command.enabled);
			return success(id, "set_auto_retry");
		}

		case "abort_retry": {
			session.abortRetry();
			return success(id, "abort_retry");
		}

		case "bash": {
			const result = await session.executeBash(command.command, undefined, {
				excludeFromContext: command.excludeFromContext,
			});
			return success(id, "bash", result);
		}

		case "abort_bash": {
			session.abortBash();
			return success(id, "abort_bash");
		}

		case "get_session_stats": {
			const stats = session.getSessionStats();
			return success(id, "get_session_stats", stats);
		}

		case "export_html": {
			const path = await session.exportToHtml(command.outputPath);
			return success(id, "export_html", { path });
		}

		case "get_fork_messages": {
			const messages = session.getUserMessagesForForking();
			return success(id, "get_fork_messages", { messages });
		}

		case "get_last_assistant_text": {
			const text = session.getLastAssistantText() ?? null;
			return success(id, "get_last_assistant_text", { text });
		}

		case "set_session_name": {
			const name = command.name.trim();
			if (!name) {
				return error(id, "set_session_name", "Session name cannot be empty");
			}
			session.setSessionName(name);
			return success(id, "set_session_name");
		}

		case "get_messages": {
			return success(id, "get_messages", { messages: session.messages });
		}

		case "get_commands": {
			const commands = [];

			for (const registeredCommand of session.extensionRunner.getRegisteredCommands()) {
				commands.push({
					name: registeredCommand.invocationName,
					description: registeredCommand.description,
					source: "extension",
					sourceInfo: registeredCommand.sourceInfo,
				});
			}

			for (const template of session.promptTemplates) {
				commands.push({
					name: template.name,
					description: template.description,
					source: "prompt",
					sourceInfo: template.sourceInfo,
				});
			}

			for (const skill of session.resourceLoader.getSkills().skills) {
				commands.push({
					name: `skill:${skill.name}`,
					description: skill.description,
					source: "skill",
					sourceInfo: skill.sourceInfo,
				});
			}

			return success(id, "get_commands", { commands });
		}

		default: {
			const unknownCommand = command as { type: string };
			return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
		}
	}
}
