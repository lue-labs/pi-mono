import { hostname, platform } from "node:os";
import { AuthStorage, type OAuthCredential } from "@earendil-works/pi-coding-agent";
import { getOrchestratorDir, getSocketPath } from "./config.ts";
import { loadMachine, saveMachine } from "./storage.ts";
import type { InstanceRecord, MachineRecord, RadiusRegistration } from "./types.ts";

const DEFAULT_RADIUS_URL = "https://radius.pi.dev/";
const DEFAULT_ORCHESTRATOR_BASE_PATH = "/v1/";
const ORCHESTRATOR_VERSION = "0.79.6";
const NOT_FOUND_RETRY_THRESHOLD = 3;
const RADIUS_PROVIDER = "radius";

interface RegisterMachineResponse extends RadiusRegistration {
	id: string;
}

interface RegisterPiResponse extends RadiusRegistration {
	id: string;
}

interface RadiusPresenceCoordinator {
	getLiveInstance(instanceId: string): InstanceRecord | undefined;
	listLiveInstances(): InstanceRecord[];
	updateInstance(instance: InstanceRecord): void;
}

interface PiHeartbeatState {
	timer: NodeJS.Timeout;
	radiusPiId: string;
	consecutiveNotFoundCount: number;
}

class RadiusHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RadiusHttpError";
		this.status = status;
	}
}

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusAccessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		throw new RadiusHttpError(response.status, `Radius request failed: ${response.status} ${await response.text()}`);
	}

	return (await response.json()) as T;
}

async function maybePost(path: string, body: unknown): Promise<void> {
	const response = await fetch(new URL(path, getRadiusOrchestratorBaseUrl()), {
		method: "POST",
		headers: {
			Authorization: `Bearer ${getRadiusAccessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new RadiusHttpError(response.status, `Radius request failed: ${response.status} ${await response.text()}`);
	}
}

function isNotFoundError(error: unknown): error is RadiusHttpError {
	return error instanceof RadiusHttpError && error.status === 404;
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

const radiusAuthStorage = AuthStorage.create();

function getStoredRadiusCredential(): OAuthCredential | undefined {
	radiusAuthStorage.reload();
	const credential = radiusAuthStorage.get(RADIUS_PROVIDER);
	if (!credential || credential.type !== "oauth") {
		return undefined;
	}
	return credential;
}

export function getRadiusAccessToken(): string {
	const storedCredential = getStoredRadiusCredential();
	if (typeof storedCredential?.access === "string" && storedCredential.access) {
		return storedCredential.access;
	}

	const apiKey = process.env.PI_RADIUS_API_KEY;
	if (apiKey) {
		return apiKey;
	}

	throw new Error("Radius credentials are required in ~/.pi/agent/auth.json or PI_RADIUS_API_KEY");
}

export function isRadiusEnabled(): boolean {
	return !!getStoredRadiusCredential()?.access || !!process.env.PI_RADIUS_API_KEY;
}

export class RadiusPresence {
	private machineHeartbeatTimer?: NodeJS.Timeout;
	private machineConsecutiveNotFoundCount = 0;
	private readonly piHeartbeatStates = new Map<string, PiHeartbeatState>();
	private machine?: MachineRecord;
	private coordinator?: RadiusPresenceCoordinator;

	setCoordinator(coordinator: RadiusPresenceCoordinator): void {
		this.coordinator = coordinator;
	}

	async start(label?: string): Promise<MachineRecord | undefined> {
		if (!isRadiusEnabled()) {
			return undefined;
		}

		const registered = await this.registerMachine(label);
		this.startMachineHeartbeat(registered.heartbeatIntervalMs);
		return this.machine;
	}

	async stop(): Promise<void> {
		if (this.machineHeartbeatTimer) {
			clearInterval(this.machineHeartbeatTimer);
			this.machineHeartbeatTimer = undefined;
		}
		for (const [instanceId, state] of this.piHeartbeatStates) {
			clearInterval(state.timer);
			this.piHeartbeatStates.delete(instanceId);
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
		const registeredInstance = { ...instance, radiusPiId: registered.id };
		this.startPiHeartbeat(instance.id, registered.heartbeatIntervalMs, registered.id);
		return registeredInstance;
	}

	async disconnectPi(instance: InstanceRecord): Promise<void> {
		const state = this.piHeartbeatStates.get(instance.id);
		if (state) {
			clearInterval(state.timer);
			this.piHeartbeatStates.delete(instance.id);
		}
		if (!isRadiusEnabled() || !instance.radiusPiId) {
			return;
		}
		await maybePost(`pis/${instance.radiusPiId}/disconnect`, {});
	}

	private async registerMachine(label?: string): Promise<RegisterMachineResponse> {
		const existingMachine = this.machine ?? loadMachine();
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
		this.machineConsecutiveNotFoundCount = 0;
		return registered;
	}

	private startMachineHeartbeat(intervalMs: number): void {
		if (this.machineHeartbeatTimer) {
			clearInterval(this.machineHeartbeatTimer);
		}
		this.machineHeartbeatTimer = setInterval(() => {
			void this.heartbeatMachine();
		}, intervalMs);
	}

	private startPiHeartbeat(instanceId: string, intervalMs: number, radiusPiId: string): void {
		const existingState = this.piHeartbeatStates.get(instanceId);
		if (existingState) {
			clearInterval(existingState.timer);
		}
		const timer = setInterval(() => {
			void this.heartbeatPi(instanceId);
		}, intervalMs);
		this.piHeartbeatStates.set(instanceId, {
			timer,
			radiusPiId,
			consecutiveNotFoundCount: 0,
		});
	}

	private async heartbeatMachine(): Promise<void> {
		if (!this.machine || !isRadiusEnabled()) {
			return;
		}

		try {
			await maybePost(`machines/${this.machine.id}/heartbeat`, {
				cwd: getOrchestratorDir(),
				socketPath: getSocketPath(),
			});
			this.machineConsecutiveNotFoundCount = 0;
		} catch (error) {
			if (!isNotFoundError(error)) {
				console.error("Radius machine heartbeat failed", error);
				return;
			}

			this.machineConsecutiveNotFoundCount += 1;
			if (this.machineConsecutiveNotFoundCount < NOT_FOUND_RETRY_THRESHOLD) {
				return;
			}

			try {
				await this.reRegisterMachineAndPis();
			} catch (recoveryError) {
				console.error("Radius machine re-registration failed", recoveryError);
			}
		}
	}

	private async heartbeatPi(instanceId: string): Promise<void> {
		if (!isRadiusEnabled()) {
			return;
		}

		const state = this.piHeartbeatStates.get(instanceId);
		if (!state) {
			return;
		}

		try {
			await maybePost(`pis/${state.radiusPiId}/heartbeat`, {});
			state.consecutiveNotFoundCount = 0;
		} catch (error) {
			if (!isNotFoundError(error)) {
				console.error(`Radius Pi heartbeat failed for instance ${instanceId}`, error);
				return;
			}

			state.consecutiveNotFoundCount += 1;
			if (state.consecutiveNotFoundCount < NOT_FOUND_RETRY_THRESHOLD) {
				return;
			}

			try {
				const recovered = await this.reRegisterPi(instanceId);
				if (!recovered) {
					console.error(`Radius Pi re-registration skipped for instance ${instanceId}`);
				}
			} catch (recoveryError) {
				console.error(`Radius Pi re-registration failed for instance ${instanceId}`, recoveryError);
			}
		}
	}

	private async reRegisterMachineAndPis(): Promise<void> {
		const registered = await this.registerMachine(this.machine?.label);
		this.startMachineHeartbeat(registered.heartbeatIntervalMs);

		const instances = this.coordinator?.listLiveInstances() ?? [];
		for (const instance of instances) {
			try {
				await this.reRegisterPi(instance.id);
			} catch (error) {
				console.error(`Radius Pi re-registration failed for instance ${instance.id}`, error);
			}
		}
	}

	private async reRegisterPi(instanceId: string): Promise<boolean> {
		const instance = this.coordinator?.getLiveInstance(instanceId);
		if (!instance) {
			const state = this.piHeartbeatStates.get(instanceId);
			if (state) {
				clearInterval(state.timer);
				this.piHeartbeatStates.delete(instanceId);
			}
			return false;
		}

		if (!this.machine) {
			await this.reRegisterMachineAndPis();
			return true;
		}

		const registeredInstance = await this.registerPi(instance);
		this.coordinator?.updateInstance(registeredInstance);
		return true;
	}
}

export const radiusPresence = new RadiusPresence();
