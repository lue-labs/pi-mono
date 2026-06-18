import { hostname, platform } from "node:os";
import { getOrchestratorDir, getSocketPath } from "./config.ts";
import { loadMachine, saveMachine } from "./storage.ts";
import type { InstanceRecord, MachineRecord, RadiusRegistration } from "./types.ts";

const DEFAULT_RADIUS_URL = "https://radius.pi.dev/";
const DEFAULT_ORCHESTRATOR_BASE_PATH = "/v1/";
const ORCHESTRATOR_VERSION = "0.79.6";

interface RegisterMachineResponse extends RadiusRegistration {
	id: string;
}

interface RegisterPiResponse extends RadiusRegistration {
	id: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusApiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new Error(`Radius request failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as T;
}

async function maybePost(path: string, body: unknown): Promise<void> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusApiKey()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`Radius request failed: ${response.status} ${await response.text()}`);
	}
}

export function getRadiusUrl(): string {
	return process.env.PI_RADIUS_URL || DEFAULT_RADIUS_URL;
}

export function getRadiusOrchestratorBaseUrl(): string {
	const explicitUrl = process.env.PI_RADIUS_ORCHESTRATOR_URL;
	if (explicitUrl) {
		return explicitUrl;
	}

	return new URL(DEFAULT_ORCHESTRATOR_BASE_PATH, getRadiusUrl()).toString();
}

export function getRadiusApiKey(): string {
	const apiKey = process.env.PI_RADIUS_API_KEY;
	if (!apiKey) {
		throw new Error("PI_RADIUS_API_KEY is required for Radius integration");
	}
	return apiKey;
}

export function isRadiusEnabled(): boolean {
	return !!process.env.PI_RADIUS_API_KEY;
}

export class RadiusPresence {
	private machineHeartbeatTimer?: NodeJS.Timeout;
	private readonly piHeartbeatTimers = new Map<string, NodeJS.Timeout>();
	private machine?: MachineRecord;

	async start(label?: string): Promise<MachineRecord | undefined> {
		if (!isRadiusEnabled()) {
			return undefined;
		}

		const existingMachine = loadMachine();
		const registered = await post<RegisterMachineResponse>("machines/register", {
			machineId: existingMachine?.id,
			label,
			hostname: hostname(),
			platform: platform(),
			arch: process.arch,
			version: ORCHESTRATOR_VERSION,
			capabilities: { spawn: true, relay: false, iroh: false },
		});

		const timestamp = new Date().toISOString();
		this.machine = {
			id: registered.id,
			createdAt: existingMachine?.createdAt ?? timestamp,
			lastSeenAt: timestamp,
			label,
		};
		saveMachine(this.machine);
		this.machineHeartbeatTimer = setInterval(() => {
			void this.heartbeatMachine();
		}, registered.heartbeatIntervalMs);
		return this.machine;
	}

	async stop(): Promise<void> {
		if (this.machineHeartbeatTimer) {
			clearInterval(this.machineHeartbeatTimer);
			this.machineHeartbeatTimer = undefined;
		}
		for (const [instanceId, timer] of this.piHeartbeatTimers) {
			clearInterval(timer);
			this.piHeartbeatTimers.delete(instanceId);
		}
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}
		await maybePost(`machines/${this.machine.id}/disconnect`, {});
	}

	async registerPi(instance: InstanceRecord): Promise<InstanceRecord> {
		if (!isRadiusEnabled()) {
			return instance;
		}
		const machine = this.machine ?? loadMachine();
		if (!machine) {
			throw new Error("No registered machine available for Pi registration");
		}
		const registered = await post<RegisterPiResponse>("pis/register", {
			machineId: machine.id,
			label: instance.label,
			cwd: instance.cwd,
			hostname: hostname(),
			pid: process.pid,
			transport: "local-rpc",
			capabilities: { rpc: true, relay: false, iroh: false },
			sessionId: instance.sessionId,
		});
		this.startPiHeartbeat(instance.id, registered.heartbeatIntervalMs, registered.id);
		return { ...instance, radiusPiId: registered.id };
	}

	async disconnectPi(instance: InstanceRecord): Promise<void> {
		const timer = this.piHeartbeatTimers.get(instance.id);
		if (timer) {
			clearInterval(timer);
			this.piHeartbeatTimers.delete(instance.id);
		}
		if (!isRadiusEnabled() || !instance.radiusPiId) {
			return;
		}
		await maybePost(`pis/${instance.radiusPiId}/disconnect`, {});
	}

	private startPiHeartbeat(instanceId: string, intervalMs: number, radiusPiId: string): void {
		const existingTimer = this.piHeartbeatTimers.get(instanceId);
		if (existingTimer) {
			clearInterval(existingTimer);
		}
		const timer = setInterval(() => {
			void this.heartbeatPi(radiusPiId);
		}, intervalMs);
		this.piHeartbeatTimers.set(instanceId, timer);
	}

	private async heartbeatMachine(): Promise<void> {
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}
		await maybePost(`machines/${this.machine.id}/heartbeat`, {
			cwd: getOrchestratorDir(),
			socketPath: getSocketPath(),
		});
	}

	private async heartbeatPi(radiusPiId: string): Promise<void> {
		if (!isRadiusEnabled()) {
			return;
		}
		await maybePost(`pis/${radiusPiId}/heartbeat`, {});
	}
}

export const radiusPresence = new RadiusPresence();
