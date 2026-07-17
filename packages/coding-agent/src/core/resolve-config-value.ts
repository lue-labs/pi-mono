/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime).
// Successful runs seed a last-known-good value so a later transient spawn
// failure can fall back to it instead of killing the turn (issue #171).
const commandResultCache = new Map<string, string | undefined>();

// One short retry absorbs transient spawn failures (e.g. posix_spawn EAGAIN
// under process pressure) without re-running commands that legitimately failed.
const TRANSIENT_RETRY_DELAY_MS = 75;

// A command "ran" when the process actually executed (clean exit or non-zero
// exit). It did NOT run on a spawn-level failure (EAGAIN/ENOMEM), which is the
// transient case eligible for retry and last-good-cache fallback.
type CommandOutcome = { ran: boolean; value: string | undefined };
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

function executeWithConfiguredShell(command: string): CommandOutcome {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: 10000,
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { ran: false, value: undefined };
			}
			return { ran: true, value: undefined };
		}

		if (result.status !== 0) {
			return { ran: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { ran: true, value: value || undefined };
	} catch {
		return { ran: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): CommandOutcome {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return { ran: true, value: output.trim() || undefined };
	} catch (error) {
		const err = error as NodeJS.ErrnoException & { status?: number | null; signal?: string | null };
		// Process ran and exited non-zero (e.g. `exit 1`, unknown command → 127),
		// or was killed (timeout): a definitive failure, not eligible for retry.
		if (typeof err.status === "number" || err.signal) {
			return { ran: true, value: undefined };
		}
		// No status/signal → the process never started (spawn-level failure).
		return { ran: false, value: undefined };
	}
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runCommandOnce(command: string): CommandOutcome {
	if (process.platform !== "win32") {
		return executeWithDefaultShell(command);
	}
	const configuredResult = executeWithConfiguredShell(command);
	return configuredResult.ran ? configuredResult : executeWithDefaultShell(command);
}

function runCommandWithRetry(commandConfig: string): CommandOutcome {
	const command = commandConfig.slice(1);
	const outcome = runCommandOnce(command);
	// Retry once only for transient spawn failures (process never ran).
	if (outcome.value === undefined && !outcome.ran) {
		sleepSync(TRANSIENT_RETRY_DELAY_MS);
		return runCommandOnce(command);
	}
	return outcome;
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const outcome = runCommandWithRetry(commandConfig);
	if (outcome.value !== undefined) {
		commandResultCache.set(commandConfig, outcome.value); // seed last-known-good
		return outcome.value;
	}
	// Transient failure (process never ran): fall back to last-known-good value.
	if (!outcome.ran && commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}
	return undefined;
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const outcome = runCommandWithRetry(commandConfig);
	if (outcome.value !== undefined) {
		commandResultCache.set(commandConfig, outcome.value);
		return outcome.value;
	}
	// Cache definitive failures (process ran); leave transient failures uncached
	// so a later call can retry rather than serving a poisoned undefined.
	if (outcome.ran) {
		commandResultCache.set(commandConfig, undefined);
	}
	return undefined;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValueUncached(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
