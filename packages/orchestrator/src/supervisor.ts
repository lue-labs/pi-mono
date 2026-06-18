import { randomUUID } from "node:crypto";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	type RpcCommand,
	type RpcResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { radiusPresence } from "./radius.ts";
import { handleRpcCommand } from "./rpc-bridge.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord } from "./types.ts";

interface LiveInstance {
	runtime: AgentSessionRuntime;
	record: InstanceRecord;
	subscribers: Set<AgentSessionEventListener>;
	unsubscribeSession?: () => void;
}

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

async function createRuntime(cwd: string): Promise<AgentSessionRuntime> {
	const agentDir = getAgentDir();
	const sessionManager = SessionManager.create(cwd);
	const runtimeFactory: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({ cwd, agentDir });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
		});
		return {
			...created,
			services,
			diagnostics: services.diagnostics,
		};
	};

	return createAgentSessionRuntime(runtimeFactory, {
		cwd,
		agentDir,
		sessionManager,
	});
}

export class OrchestratorSupervisor {
	private readonly liveInstances = new Map<string, LiveInstance>();

	private syncInstanceRecord(live: LiveInstance): void {
		live.record = {
			...live.record,
			sessionId: live.runtime.session.sessionId,
			sessionFile: live.runtime.session.sessionFile,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(live.record);
	}

	private bindLiveInstance(live: LiveInstance): void {
		live.unsubscribeSession?.();
		live.unsubscribeSession = live.runtime.session.subscribe((event) => {
			for (const subscriber of live.subscribers) {
				subscriber(event);
			}
		});
		live.runtime.setRebindSession(async () => {
			this.syncInstanceRecord(live);
			this.bindLiveInstance(live);
		});
	}

	updateInstance(instance: InstanceRecord): void {
		const live = this.liveInstances.get(instance.id);
		if (live) {
			live.record = instance;
		}
		upsertInstance(instance);
	}

	attachInstance(
		instanceId: string,
		onEvent: (event: AgentSessionEvent) => void,
	): { handleRpc(command: RpcCommand): Promise<RpcResponse>; close(): void } | undefined {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}
		live.subscribers.add(onEvent);
		return {
			handleRpc: async (command) => {
				const response = await handleRpcCommand(live.runtime, command);
				this.syncInstanceRecord(live);
				return response;
			},
			close: () => {
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
		const runtime = await createRuntime(options.cwd);
		const now = new Date().toISOString();
		const record: InstanceRecord = {
			id: randomUUID(),
			status: "online",
			cwd: options.cwd,
			createdAt: now,
			lastSeenAt: now,
			label: options.label,
			sessionId: runtime.session.sessionId,
			sessionFile: runtime.session.sessionFile,
		};

		const registeredRecord = await radiusPresence.registerPi(record);
		const live: LiveInstance = { runtime, record: registeredRecord, subscribers: new Set() };
		this.bindLiveInstance(live);
		this.liveInstances.set(registeredRecord.id, live);
		upsertInstance(registeredRecord);
		return cloneInstance(registeredRecord);
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		await radiusPresence.disconnectPi(live.record);
		live.unsubscribeSession?.();
		live.runtime.setRebindSession(undefined);
		await live.runtime.dispose();
		this.liveInstances.delete(instanceId);
		removeInstance(instanceId);
		return cloneInstance(live.record);
	}

	async handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			return undefined;
		}

		const response = await handleRpcCommand(live.runtime, command);
		this.syncInstanceRecord(live);
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
