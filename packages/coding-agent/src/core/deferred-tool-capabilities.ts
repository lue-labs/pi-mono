import type { Api, Model } from "@valkyriweb/pi-ai";

export interface DeferredToolCapabilities {
	nativeDeferredTools: boolean;
	toolReferenceResults: boolean;
	fallbackReason?: string;
}

export function getDeferredToolCapabilities(model: Model<Api> | undefined): DeferredToolCapabilities {
	if (!model) {
		return {
			nativeDeferredTools: false,
			toolReferenceResults: false,
			fallbackReason: "No model selected; using fallback active-tool mutation.",
		};
	}

	if (supportsNativeAnthropicDeferredTools(model)) {
		if (model.id.toLowerCase().includes("haiku")) {
			return {
				nativeDeferredTools: false,
				toolReferenceResults: false,
				fallbackReason: `${model.provider}/${model.id} does not support Anthropic tool_reference blocks; activation may bust prompt cache once.`,
			};
		}
		const compat = model.compat as { supportsDeferredTools?: boolean } | undefined;
		if (compat?.supportsDeferredTools === false) {
			return {
				nativeDeferredTools: false,
				toolReferenceResults: false,
				fallbackReason: `${model.provider}/${model.id} disables Anthropic deferred tools; activation may bust prompt cache once.`,
			};
		}
		return { nativeDeferredTools: true, toolReferenceResults: true };
	}

	if (supportsNativeCodexDeferredTools(model)) {
		const compat = model.compat as { supportsDeferredTools?: boolean } | undefined;
		if (compat?.supportsDeferredTools === false) {
			return {
				nativeDeferredTools: false,
				toolReferenceResults: false,
				fallbackReason: `${model.provider}/${model.id} disables Codex deferred tools; activation may bust prompt cache once.`,
			};
		}
		return { nativeDeferredTools: true, toolReferenceResults: true };
	}

	return {
		nativeDeferredTools: false,
		toolReferenceResults: false,
		fallbackReason: `${model.provider}/${model.id} does not expose native deferred tool references; activation may bust prompt cache once.`,
	};
}

function supportsNativeAnthropicDeferredTools(model: Model<Api>): boolean {
	return model.api === "anthropic-messages";
}

function supportsNativeCodexDeferredTools(model: Model<Api>): boolean {
	return model.api === "openai-codex-responses";
}
