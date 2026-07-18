import type { Api, Model } from "@valkyriweb/pi-ai";

export interface DeferredToolCapabilities {
	nativeDeferredTools: boolean;
	toolReferenceResults: boolean;
	/**
	 * The transport cannot deliver deferred tool schemas via native tool_reference
	 * blocks, but it CAN receive an activated tool's full schema inside a transcript
	 * `<functions>` message. When true, the fallback path hydrates via message
	 * delivery (append-only, cache-stable) instead of mutating the active tools[]
	 * (a full-prefix cache bust). See fork issue #348.
	 */
	messageDeliveredSchemas: boolean;
	fallbackReason?: string;
}

export function getDeferredToolCapabilities(model: Model<Api> | undefined): DeferredToolCapabilities {
	if (!model) {
		return {
			nativeDeferredTools: false,
			toolReferenceResults: false,
			messageDeliveredSchemas: false,
			fallbackReason: "No model selected; using fallback active-tool mutation.",
		};
	}

	if (supportsNativeAnthropicDeferredTools(model)) {
		if (model.id.toLowerCase().includes("haiku")) {
			return {
				nativeDeferredTools: false,
				toolReferenceResults: false,
				messageDeliveredSchemas: false,
				fallbackReason: `${model.provider}/${model.id} does not support Anthropic tool_reference blocks; activation may bust prompt cache once.`,
			};
		}
		const compat = model.compat as { supportsDeferredTools?: boolean } | undefined;
		if (compat?.supportsDeferredTools === false) {
			// CC-adapter / bridge-OAuth lane: no native tool_reference support, but the
			// harness can deliver an activated tool's schema in a `<functions>` message.
			// Hydrate append-only instead of bursting the tools[] prefix (issue #348).
			return {
				nativeDeferredTools: false,
				toolReferenceResults: false,
				messageDeliveredSchemas: true,
				fallbackReason: `${model.provider}/${model.id} disables Anthropic deferred tools; hydrating activated schemas via message delivery.`,
			};
		}
		return { nativeDeferredTools: true, toolReferenceResults: true, messageDeliveredSchemas: false };
	}

	if (supportsNativeCodexDeferredTools(model)) {
		const compat = model.compat as { supportsDeferredTools?: boolean } | undefined;
		if (compat?.supportsDeferredTools === false) {
			return {
				nativeDeferredTools: false,
				toolReferenceResults: false,
				messageDeliveredSchemas: false,
				fallbackReason: `${model.provider}/${model.id} disables Codex deferred tools; activation may bust prompt cache once.`,
			};
		}
		return { nativeDeferredTools: true, toolReferenceResults: true, messageDeliveredSchemas: false };
	}

	return {
		nativeDeferredTools: false,
		toolReferenceResults: false,
		messageDeliveredSchemas: false,
		fallbackReason: `${model.provider}/${model.id} does not expose native deferred tool references; activation may bust prompt cache once.`,
	};
}

function supportsNativeAnthropicDeferredTools(model: Model<Api>): boolean {
	return model.api === "anthropic-messages";
}

function supportsNativeCodexDeferredTools(model: Model<Api>): boolean {
	return model.api === "openai-codex-responses";
}
