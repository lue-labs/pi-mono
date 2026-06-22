import { randomUUID } from "node:crypto";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { radiusPresence } from "./radius.ts";
import { createRpcProcessInstance, type RpcProcessInstance } from "./rpc-process.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord } from "./types.ts";

interface LiveInstance {
	rpc: RpcProcessInstance;
	record: InstanceRecord;
	subscribers: Set<AgentSessionEventListener>;
	onUiRequest?: (request: RpcExtensionUIRequest) => void;
	unsubscribeEvents?: () => void;
	unsubscribeExit?: () => void;
}

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

// Only refresh persisted session metadata after commands that can plausibly change
// the instance identity/details we store in instances.json. Most RPCs mutate transient
// runtime state only, so forcing a follow-up get_state after every command is wasted IO.
//
// - new_session / switch_session / fork / clone can change sessionId/sessionFile
// - set_session_name changes a persisted session detail we may want reflected externally
// - prompt can materialize or advance persisted session state after the child processes it
const SESSION_METADATA_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"set_session_name",
	"prompt",
]);

function shouldRefreshSessionMetadata(command: RpcCommand): boolean {
	return SESSION_METADATA_COMMANDS.has(command.type);
}

function isGetStateSuccess(
	response: RpcResponse,
): response is Extract<
	RpcResponse,
	{ success: true; command: "get_state"; data: { sessionId: string; sessionFile?: string } }
> {
	return response.success === true && response.command === "get_state" && "data" in response;
}

export class OrchestratorSupervisor {
	private readonly liveInstances = new Map<string, LiveInstance>();

	private async syncInstanceRecord(live: LiveInstance): Promise<void> {
		const response = await live.rpc.send({ type: "get_state" });
		if (!isGetStateSuccess(response)) {
			live.record = {
				...live.record,
				lastSeenAt: new Date().toISOString(),
			};
			upsertInstance(live.record);
			return;
		}
		live.record = {
			...live.record,
			sessionId: response.data.sessionId,
			sessionFile: response.data.sessionFile,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(live.record);
	}

	private bindLiveInstance(live: LiveInstance): void {
		live.unsubscribeEvents?.();
		live.unsubscribeExit?.();
		live.unsubscribeEvents = live.rpc.onEvent((event) => {
			for (const subscriber of live.subscribers) {
				subscriber(event);
			}
		});
		live.unsubscribeExit = live.rpc.onExit(() => {
			live.record = {
				...live.record,
				status: "stopped",
				lastSeenAt: new Date().toISOString(),
			};
			upsertInstance(live.record);
			this.liveInstances.delete(live.record.id);
		});
		live.rpc.setUiRequestHandler((request) => {
			live.onUiRequest?.(request);
		});
	}

	updateInstance(instance: InstanceRecord): void {
		const live = this.liveInstances.get(instance.id);
		if (live) {
			live.record = instance;
		}
		upsertInstance(instance);
	}

	openRpcStream(
		instanceId: string,
		onEvent: (event: AgentSessionEvent) => void,
		onUiRequest: (request: RpcExtensionUIRequest) => void,
	):
		| {
				handleRpc(command: RpcCommand): Promise<RpcResponse>;
				handleUiResponse(response: RpcExtensionUIResponse): void;
				close(): void;
		  }
		| undefined {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}
		live.subscribers.add(onEvent);
		live.onUiRequest = onUiRequest;
		return {
			handleRpc: async (command) => {
				const response = await live.rpc.send(command);
				if (shouldRefreshSessionMetadata(command)) {
					await this.syncInstanceRecord(live);
				}
				return response;
			},
			handleUiResponse: (response) => {
				live.rpc.handleUiResponse(response);
			},
			close: () => {
				if (live.onUiRequest === onUiRequest) {
					live.onUiRequest = undefined;
				}
				live.subscribers.delete(onEvent);
			},
		};
	}

	getLiveInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		return live ? cloneInstance(live.record) : undefined;
	}

	listLiveInstances(): InstanceRecord[] {
		return [...this.liveInstances.values()].map((live) => cloneInstance(live.record));
	}

	async recoverAfterRestart(): Promise<void> {
		const recoveredAt = new Date().toISOString();
		const instances = loadInstances().map((instance) => ({
			...instance,
			status: instance.status === "online" || instance.status === "starting" ? "stopped" : instance.status,
			lastSeenAt: recoveredAt,
		}));
		for (const instance of instances) {
			await radiusPresence.disconnectPi(instance);
		}
		saveInstances(instances);
	}

	listInstances(): InstanceRecord[] {
		return loadInstances().map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			return cloneInstance(live.record);
		}
		const stored = getInstance(instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	async spawnInstance(options: { cwd: string; label?: string }): Promise<InstanceRecord> {
		const rpc = createRpcProcessInstance({ cwd: options.cwd });
		const now = new Date().toISOString();
		const record: InstanceRecord = {
			id: randomUUID(),
			status: "online",
			cwd: options.cwd,
			createdAt: now,
			lastSeenAt: now,
			label: options.label,
		};

		const registeredRecord = await radiusPresence.registerPi(record);
		const live: LiveInstance = {
			rpc,
			record: registeredRecord,
			subscribers: new Set(),
		};
		this.bindLiveInstance(live);
		this.liveInstances.set(registeredRecord.id, live);
		await this.syncInstanceRecord(live);
		upsertInstance(live.record);
		return cloneInstance(live.record);
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		await radiusPresence.disconnectPi(live.record);
		live.unsubscribeEvents?.();
		live.unsubscribeExit?.();
		live.onUiRequest = undefined;
		await live.rpc.dispose();
		this.liveInstances.delete(instanceId);
		removeInstance(instanceId);
		return cloneInstance(live.record);
	}

	async handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		const response = await live.rpc.send(command);
		if (shouldRefreshSessionMetadata(command)) {
			await this.syncInstanceRecord(live);
		}
		return response;
	}

	async shutdown(): Promise<void> {
		for (const instanceId of [...this.liveInstances.keys()]) {
			await this.stopInstance(instanceId);
		}
	}
}

export const supervisor = new OrchestratorSupervisor();

radiusPresence.setCoordinator({
	getLiveInstance(instanceId) {
		return supervisor.getLiveInstance(instanceId);
	},
	listLiveInstances() {
		return supervisor.listLiveInstances();
	},
	updateInstance(instance) {
		supervisor.updateInstance(instance);
	},
});
