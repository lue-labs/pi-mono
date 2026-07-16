/**
 * Registry-derived model selection for tests.
 *
 * Tests must not hardcode literal provider model ids (e.g. getModel("openai-codex",
 * "gpt-5.5")). Those ids are typed against `keyof MODELS[provider]`, so renaming or
 * dropping a model in `src/models.generated.ts` turns every pinned test into a
 * compile error (the churn behind fork issues #30 and #33).
 *
 * Instead, select a currently-valid model for a provider by capability. The
 * selection self-heals across provider drift: as long as the provider still
 * exposes a model with the required capability, the test keeps resolving a real
 * model. If no model matches, `pickModel` throws a descriptive error so drift
 * surfaces as a clear, actionable failure rather than an `undefined` model.
 */

import { type BuiltinProvider, getModels } from "../../src/compat.ts";
import { getSupportedThinkingLevels } from "../../src/models.ts";
import type { Api, Model, ModelThinkingLevel } from "../../src/types.ts";

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

/** Model sets a truthy compat flag (e.g. "zaiToolStream"). */
export function hasCompatFlag(flag: string): ModelPredicate {
	return (model) => Boolean((model.compat as Record<string, unknown> | undefined)?.[flag]);
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
				"Registry drift: regenerate src/models.generated.ts or relax the test capability.",
		);
	}
	return match as ProviderModel<TProvider>;
}
