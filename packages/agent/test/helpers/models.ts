/**
 * Registry-derived model selection for agent tests.
 *
 * Mirrors packages/ai/test/helpers/models.ts (test helpers are not package exports,
 * so each package keeps its own copy). Tests must not hardcode literal provider model
 * ids (e.g. getModel("anthropic", "claude-sonnet-4-5")): those ids are typed against
 * `keyof MODELS[provider]`, so renaming/dropping a model in models.generated.ts turns
 * every pinned test into a compile error. Select by capability instead; the pick
 * self-heals across provider drift and throws a descriptive error if nothing matches.
 */

import { type Api, getSupportedThinkingLevels, type Model, type ModelThinkingLevel } from "@valkyriweb/pi-ai";
import { type BuiltinProvider, getModels } from "@valkyriweb/pi-ai/compat";

type ProviderModel<TProvider extends BuiltinProvider> = ReturnType<typeof getModels<TProvider>>[number];

export type ModelPredicate = (model: Model<Api>) => boolean;

/** Model accepts image input. */
export const supportsImages: ModelPredicate = (model) => model.input.includes("image");

/** Model is a reasoning/thinking model. */
export const isReasoning: ModelPredicate = (model) => model.reasoning;

/** Model exposes the given thinking level (e.g. "xhigh"). */
export function supportsThinkingLevel(level: ModelThinkingLevel): ModelPredicate {
	return (model) => getSupportedThinkingLevels(model).includes(level);
}

/** Combine predicates: all must hold. */
export function allOf(...predicates: ModelPredicate[]): ModelPredicate {
	return (model) => predicates.every((predicate) => predicate(model));
}

/**
 * Pick the first registered model for a provider, optionally matching a capability
 * predicate. Throws if the provider has no matching model so registry drift fails
 * loudly instead of returning an undefined model.
 */
export function pickModel<TProvider extends BuiltinProvider>(
	provider: TProvider,
	predicate?: ModelPredicate,
): ProviderModel<TProvider> {
	const models = getModels(provider);
	const match = predicate ? models.find((model) => predicate(model as Model<Api>)) : models[0];
	if (!match) {
		const detail = predicate ? " matching the requested capability" : "";
		throw new Error(
			`No registered model for provider "${provider}"${detail}. ` +
				"Registry drift: regenerate models.generated.ts or relax the test capability.",
		);
	}
	return match as ProviderModel<TProvider>;
}
