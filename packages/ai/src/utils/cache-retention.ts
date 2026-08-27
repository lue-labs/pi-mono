import type { CacheRetention, ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

const CACHE_RETENTION_VALUES = ["short", "none", "long"] as const;

export interface CacheRetentionResolutionOptions {
	/** The value to use when no explicit or environment value is set. */
	readonly defaultRetention: CacheRetention | undefined;
	/** Environment values accepted by this adapter. Defaults to all retention values. */
	readonly allowedEnvValues?: readonly CacheRetention[];
}

export function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention;
export function resolveCacheRetention(
	cacheRetention: CacheRetention | undefined,
	env: ProviderEnv | undefined,
	options: CacheRetentionResolutionOptions,
): CacheRetention | undefined;
export function resolveCacheRetention(
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
	options?: CacheRetentionResolutionOptions,
): CacheRetention | undefined {
	if (cacheRetention) {
		return cacheRetention;
	}

	const envRetention = getProviderEnvValue("PI_CACHE_RETENTION", env);
	if (isCacheRetention(envRetention) && (options?.allowedEnvValues ?? CACHE_RETENTION_VALUES).includes(envRetention)) {
		return envRetention;
	}

	return options ? options.defaultRetention : "long";
}

function isCacheRetention(value: string | undefined): value is CacheRetention {
	return value === "short" || value === "none" || value === "long";
}
