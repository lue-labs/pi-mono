import { join } from "node:path";

/**
 * Persist test sessions under the fixture root.
 * SessionManager.create(cwd) without sessionDir writes to ~/.pi/agent/sessions.
 */
export function fixtureSessionDir(root: string): string {
	return join(root, "sessions");
}
