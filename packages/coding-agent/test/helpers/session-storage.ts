import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir } from "../../src/config.ts";
import { getDefaultSessionDir, type NewSessionOptions, SessionManager } from "../../src/core/session-manager.ts";

/**
 * Persist test sessions under the fixture root.
 * SessionManager.create(cwd) without sessionDir writes to ~/.pi/agent/sessions.
 */
export function fixtureSessionDir(root: string): string {
	return join(root, "sessions");
}

type CreateFn = typeof SessionManager.create;

/**
 * Fill omitted SessionManager.create sessionDir via exported getDefaultSessionDir.
 * seam: executor.ts SessionManager.create(childCwd) is the omitted-sessionDir producer
 * these harness/fork suites exercise; keep cwd-slug encoding, not a flat sessions dir.
 */
export function redirectOmittedSessionCreates(agentDir: string): () => void {
	const previous: CreateFn = SessionManager.create;
	const patched: CreateFn = (cwd: string, sessionDir?: string, options?: NewSessionOptions) =>
		previous(cwd, sessionDir ?? getDefaultSessionDir(cwd, agentDir), options);
	SessionManager.create = patched;
	return () => {
		SessionManager.create = previous;
	};
}

/**
 * Default session dir for cwd under the live agent dir, without mkdir'ing it.
 * getDefaultSessionDirPath is unexported; getDefaultSessionDir(cwd) mkdir's.
 */
export function liveDefaultSessionDir(cwd: string): string {
	const probeRoot = mkdtempSync(join(tmpdir(), "pi-session-slug-"));
	try {
		return join(getAgentDir(), "sessions", basename(getDefaultSessionDir(cwd, probeRoot)));
	} finally {
		rmSync(probeRoot, { recursive: true, force: true });
	}
}
