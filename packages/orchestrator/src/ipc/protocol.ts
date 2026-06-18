export interface SpawnRequest {
	type: "spawn";
	cwd: string;
	label?: string;
	provider?: string;
	model?: string;
}

export interface ListRequest {
	type: "list";
}

export interface StopRequest {
	type: "stop";
	instanceId: string;
}

export interface StatusRequest {
	type: "status";
	instanceId: string;
}

export type OrchestratorRequest = SpawnRequest | ListRequest | StopRequest | StatusRequest;

export interface InstanceSummary {
	id: string;
	status: "starting" | "online" | "stopping" | "stopped" | "error";
	cwd: string;
	label?: string;
	sessionId?: string;
}

export interface ResponseBase {
	type: string;
	ok: boolean;
	error?: string;
}

export interface SpawnResponse extends ResponseBase {
	type: "spawn_result";
	instance?: InstanceSummary;
}

export interface ListResponse extends ResponseBase {
	type: "list_result";
	instances?: InstanceSummary[];
}

export interface StopResponse extends ResponseBase {
	type: "stop_result";
	instanceId?: string;
}

export interface StatusResponse extends ResponseBase {
	type: "status_result";
	instance?: InstanceSummary;
}

export type OrchestratorResponse = SpawnResponse | ListResponse | StopResponse | StatusResponse;

export function encodeMessage(message: OrchestratorRequest | OrchestratorResponse): string {
	return `${JSON.stringify(message)}\n`;
}

export function parseRequestLine(line: string): OrchestratorRequest {
	const value = JSON.parse(line) as OrchestratorRequest;
	return value;
}

export function parseResponseLine(line: string): OrchestratorResponse {
	const value = JSON.parse(line) as OrchestratorResponse;
	return value;
}
