/**
 * Prompt-cache heartbeats (fork-owned).
 *
 * Keeps the Anthropic prompt cache warm during working hours by sending
 * minimal opportunistic requests:
 * - Base heartbeat: process-global, warms the static base system prompt
 *   prefix (everything before SYSTEM_PROMPT_DYNAMIC_BOUNDARY) under a fixed
 *   synthetic session id shared by all sessions on the same model.
 * - Session heartbeat: per-session, replays the full current context so the
 *   session's own cache prefix stays warm while the user is idle.
 *
 * Heartbeats are opportunistic: failures are swallowed, rate-limit errors set
 * a per-model global cooldown, and nothing here may surface to the user. The
 * request bytes (system prompt, messages, tools) must match what the real
 * session sends — this module must never mutate or reorder them.
 *
 * Fork provenance: extracted verbatim from agent-session.ts (fork-delta
 * reforge slice 5); only `this.*` receivers were renamed to `this.host.*`
 * for session-owned state. Tier `platform` in pi-fork-patch-inventory.
 */
import type { Agent } from "@valkyriweb/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@valkyriweb/pi-ai";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from "@valkyriweb/pi-ai/compat";
import type { AgentSessionEvent } from "./agent-session.ts";
import { createPromptCacheAffinityKey } from "./cache-affinity.ts";
import { convertToLlm } from "./messages.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { boundModelFacingContextImages } from "./tool-artifacts.ts";

const BASE_HEARTBEAT_SESSION_ID = "pi-base-system-prompt-heartbeat";
const CACHE_HEARTBEAT_MESSAGE = "<system-reminder>Cache heartbeat only. Reply with a single '.'</system-reminder>";

const globalCacheHeartbeat: {
	timer: ReturnType<typeof setTimeout> | undefined;
	running: boolean;
	baseWarmAt: Map<string, number>;
	rateLimitedUntil: Map<string, number>;
} = {
	timer: undefined,
	running: false,
	baseWarmAt: new Map(),
	rateLimitedUntil: new Map(),
};

function modelCacheKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function isRateLimitErrorText(text: string | undefined): boolean {
	return /\b429\b|rate.?limit|quota|too many requests/i.test(text ?? "");
}

/**
 * Session-owned state the heartbeat manager reads. All members are read live
 * per invocation (the manager holds the host, never snapshots of its values),
 * so model/system-prompt changes mid-session are always observed.
 */
export interface CacheHeartbeatHost {
	readonly disposed: boolean;
	readonly model: Model<any> | undefined;
	readonly systemPrompt: string;
	readonly sessionId: string;
	readonly settingsManager: SettingsManager;
	readonly agent: Agent;
	findLastAssistantMessage(): AssistantMessage | undefined;
	loadDeferredExtensions(): Promise<void>;
	emit(event: AgentSessionEvent): void;
}

export class CacheHeartbeatManager {
	private readonly host: CacheHeartbeatHost;
	private _cacheHeartbeatTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private _cacheHeartbeatAbortController: AbortController | undefined = undefined;
	private _sessionHeartbeatTargetTimestamp: number | undefined = undefined;
	private _sessionHeartbeatUsedTimestamp: number | undefined = undefined;

	constructor(host: CacheHeartbeatHost) {
		this.host = host;
	}

	/** Record the assistant-message timestamp the next session heartbeat must match. */
	setSessionTarget(timestamp: number | undefined): void {
		this._sessionHeartbeatTargetTimestamp = timestamp;
	}

	/** Clear the session timer and abort any in-flight heartbeat request. */
	dispose(): void {
		if (this._cacheHeartbeatTimer) {
			clearTimeout(this._cacheHeartbeatTimer);
			this._cacheHeartbeatTimer = undefined;
		}
		this._cacheHeartbeatAbortController?.abort();
	}

	noteActivity(scope: "base" | "session" | "all" = "all"): void {
		if (this.host.disposed) return;
		const settings = this.host.settingsManager.getCacheHeartbeatSettings();
		if (!settings.enabled || !this.host.model || !this._isWithinCacheHeartbeatHours()) return;
		if (!this._isCacheHeartbeatProviderAllowed()) return;
		if (this._isCacheHeartbeatRateLimited()) return;

		if ((scope === "base" || scope === "all") && settings.basePrompt) {
			this._markBaseCacheWarm();
			this._scheduleBaseCacheHeartbeat(settings.intervalMs);
		}
		if ((scope === "session" || scope === "all") && settings.sessionPrompt) {
			this._scheduleSessionCacheHeartbeat(settings.intervalMs);
		}
	}

	private _isWithinCacheHeartbeatHours(now = new Date()): boolean {
		const { workingHours } = this.host.settingsManager.getCacheHeartbeatSettings();
		if (!workingHours.days.includes(now.getDay())) return false;

		const minutes = now.getHours() * 60 + now.getMinutes();
		const start = this._parseTimeOfDay(workingHours.start, 8 * 60);
		const end = this._parseTimeOfDay(workingHours.end, 18 * 60);
		return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
	}

	private _parseTimeOfDay(value: string, fallback: number): number {
		const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
		if (!match) return fallback;
		const hours = Number(match[1]);
		const minutes = Number(match[2]);
		if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
		return hours * 60 + minutes;
	}

	private _isCacheHeartbeatProviderAllowed(): boolean {
		if (!this.host.model) return false;
		const modelName = modelCacheKey(this.host.model);
		return this.host.settingsManager
			.getCacheHeartbeatSettings()
			.providers.some(
				(prefix) => modelName.startsWith(prefix) || this.host.model?.provider === prefix.replace(/\/$/, ""),
			);
	}

	private _isCacheHeartbeatRateLimited(): boolean {
		if (!this.host.model) return true;
		const until = globalCacheHeartbeat.rateLimitedUntil.get(modelCacheKey(this.host.model));
		return until !== undefined && until > Date.now();
	}

	private _markCacheHeartbeatRateLimited(errorText: string | undefined): void {
		if (!this.host.model || !isRateLimitErrorText(errorText)) return;
		const cooldownMs = this.host.settingsManager.getCacheHeartbeatSettings().rateLimitCooldownMs;
		globalCacheHeartbeat.rateLimitedUntil.set(modelCacheKey(this.host.model), Date.now() + cooldownMs);
	}

	private _markBaseCacheWarm(): void {
		if (!this.host.model) return;
		globalCacheHeartbeat.baseWarmAt.set(modelCacheKey(this.host.model), Date.now());
	}

	private _scheduleBaseCacheHeartbeat(intervalMs: number): void {
		if (!this.host.model) return;
		const lastWarmAt = globalCacheHeartbeat.baseWarmAt.get(modelCacheKey(this.host.model)) ?? Date.now();
		const delayMs = Math.max(0, intervalMs - (Date.now() - lastWarmAt));
		if (globalCacheHeartbeat.timer) {
			clearTimeout(globalCacheHeartbeat.timer);
		}
		globalCacheHeartbeat.timer = setTimeout(() => {
			void this._runBaseCacheHeartbeat();
		}, delayMs);
	}

	private _scheduleSessionCacheHeartbeat(intervalMs: number): void {
		if (this._cacheHeartbeatTimer) {
			clearTimeout(this._cacheHeartbeatTimer);
		}
		this._cacheHeartbeatTimer = setTimeout(() => {
			void this._runSessionCacheHeartbeat();
		}, intervalMs);
	}

	private _baseSystemPromptForHeartbeat(): string {
		const boundary = this.host.systemPrompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		return boundary === -1 ? this.host.systemPrompt : this.host.systemPrompt.slice(0, boundary).trimEnd();
	}

	private async _runBaseCacheHeartbeat(): Promise<void> {
		if (this.host.disposed || globalCacheHeartbeat.running) return;
		const settings = this.host.settingsManager.getCacheHeartbeatSettings();
		if (!settings.enabled || !settings.basePrompt || !this.host.model || !this._isWithinCacheHeartbeatHours()) return;
		if (!this._isCacheHeartbeatProviderAllowed() || this._isCacheHeartbeatRateLimited()) return;

		globalCacheHeartbeat.running = true;
		try {
			await this._sendCacheHeartbeat(
				{
					systemPrompt: this._baseSystemPromptForHeartbeat(),
					messages: [],
					tools: [],
					sessionId: BASE_HEARTBEAT_SESSION_ID,
				},
				"base",
			);
		} finally {
			this._markBaseCacheWarm();
			globalCacheHeartbeat.running = false;
			const latest = this.host.settingsManager.getCacheHeartbeatSettings();
			if (latest.enabled && latest.basePrompt && this._isWithinCacheHeartbeatHours()) {
				this._scheduleBaseCacheHeartbeat(latest.intervalMs);
			}
		}
	}

	private async _runSessionCacheHeartbeat(): Promise<void> {
		if (this.host.disposed) return;
		const settings = this.host.settingsManager.getCacheHeartbeatSettings();
		const targetTimestamp = this._sessionHeartbeatTargetTimestamp;
		if (
			!settings.enabled ||
			!settings.sessionPrompt ||
			!this.host.model ||
			!targetTimestamp ||
			this._sessionHeartbeatUsedTimestamp === targetTimestamp ||
			!this._isWithinCacheHeartbeatHours() ||
			!this._isCacheHeartbeatProviderAllowed() ||
			this._isCacheHeartbeatRateLimited()
		) {
			return;
		}

		const lastAssistant = this.host.findLastAssistantMessage();
		if (!lastAssistant || lastAssistant.timestamp !== targetTimestamp) return;

		this._sessionHeartbeatUsedTimestamp = targetTimestamp;
		await this._sendCacheHeartbeat(
			{
				systemPrompt: this.host.systemPrompt,
				messages: boundModelFacingContextImages(await convertToLlm(this.host.agent.state.messages)),
				tools: this.host.agent.state.tools,
				sessionId: this.host.sessionId,
			},
			"session",
		);
	}

	private async _sendCacheHeartbeat(
		context: Context & { sessionId: string },
		scope: "base" | "session",
	): Promise<void> {
		if (this.host.disposed || !this.host.model) return;
		await this.host.loadDeferredExtensions();
		this._cacheHeartbeatAbortController?.abort();
		const abortController = new AbortController();
		this._cacheHeartbeatAbortController = abortController;

		const heartbeatContext: Context = {
			...context,
			messages: [
				...context.messages,
				{ role: "user", content: [{ type: "text", text: CACHE_HEARTBEAT_MESSAGE }], timestamp: Date.now() },
			],
		};

		const settings = this.host.settingsManager.getCacheHeartbeatSettings();
		const providerRetrySettings = this.host.settingsManager.getProviderRetrySettings();
		try {
			const model = this.host.model;
			const stream = await this.host.agent.streamFunction(model, heartbeatContext, {
				cacheRetention: "long",
				maxTokens: settings.maxTokens,
				maxRetries: 0,
				maxRetryDelayMs: 0,
				timeoutMs: providerRetrySettings.timeoutMs,
				sessionId: context.sessionId,
				cacheAffinityKey: createPromptCacheAffinityKey(model, heartbeatContext),
				signal: abortController.signal,
				transport: this.host.settingsManager.getTransport(),
			});
			for await (const event of stream) {
				if (event.type === "done") {
					this._emitCacheHeartbeatEvent(scope, model, event.message as AssistantMessage);
					break;
				}
				if (event.type === "error") {
					this._markCacheHeartbeatRateLimited("message" in event ? String(event.message) : undefined);
					break;
				}
			}
		} catch (error) {
			this._markCacheHeartbeatRateLimited(error instanceof Error ? error.message : String(error));
			// Heartbeats are opportunistic. Never surface background cache-refresh failures to the user.
		} finally {
			if (this._cacheHeartbeatAbortController === abortController) {
				this._cacheHeartbeatAbortController = undefined;
			}
		}
	}

	private _emitCacheHeartbeatEvent(scope: "base" | "session", model: Model<any>, message: AssistantMessage): void {
		const usage = message.usage;
		const cacheableInput = usage.input + usage.cacheRead;
		this.host.emit({
			type: "cache_heartbeat",
			scope,
			model: model.id,
			provider: model.provider,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			input: usage.input,
			cacheHitRate: cacheableInput > 0 ? usage.cacheRead / cacheableInput : undefined,
		});
	}
}
