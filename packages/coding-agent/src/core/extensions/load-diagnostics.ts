/**
 * Severity policy for extension load failures.
 *
 * Auto-discovered extensions (found by scanning `.pi/extensions/`, the agent dir,
 * or a configured directory) are conveniences: one failing to load degrades to a
 * warning so the process still starts. A broken dev extension checked into a repo
 * must not make that repo unusable for everyone working in it.
 *
 * Extensions the user named — `-e <path>`, a settings entry, or a package
 * manifest — keep failing hard. Silently dropping something asked for by name
 * would be worse than exiting.
 *
 * See docs/worktree-bootstrap.md for the incident this policy comes from.
 */

import type { AgentSessionRuntimeDiagnostic } from "../agent-session-services.ts";
import type { ExtensionLoadError } from "./types.ts";

/** Prefix used for skipped (non-fatal) auto-discovered extensions. */
export const SKIPPED_EXTENSION_PREFIX = "Skipped extension ";
/** Prefix used for fatal extension load failures. */
export const FAILED_EXTENSION_PREFIX = "Failed to load extension ";

/** Env var restoring the old behaviour where every load failure is fatal. */
export const STRICT_EXTENSIONS_ENV = "PI_STRICT_EXTENSIONS";

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * True when strict extension loading is on, making auto-discovered failures fatal
 * again. Intended for CI, where a silently skipped extension could hide a real
 * regression.
 */
export function strictExtensionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env[STRICT_EXTENSIONS_ENV]);
}

/**
 * Map one extension load failure onto a startup diagnostic.
 *
 * The message text is deliberately unchanged from the underlying loader error
 * (e.g. `Cannot find module '@valkyriweb/pi-tui'`): only the severity differs, so
 * a skipped extension stays just as visible as a fatal one.
 */
export function extensionLoadDiagnostic(
	failure: ExtensionLoadError,
	env: NodeJS.ProcessEnv = process.env,
): AgentSessionRuntimeDiagnostic {
	const { path, error, discovered } = failure;
	if (discovered && !strictExtensionsEnabled(env)) {
		return { type: "warning", message: `${SKIPPED_EXTENSION_PREFIX}"${path}": ${error}` };
	}
	return { type: "error", message: `${FAILED_EXTENSION_PREFIX}"${path}": ${error}` };
}
