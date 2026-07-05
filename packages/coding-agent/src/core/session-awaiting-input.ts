import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

/**
 * Per-session "awaiting input" signalling.
 *
 * Mirrors the sidecar-marker pattern already established by
 * `session-liveness.ts` (`<sessionPath>.live`), but for a different question:
 * not "is a pi process holding this session file open" but "is that process
 * currently blocked mid-turn on an interactive prompt" (e.g. `BuildInterface`
 * rendering a question/confirmation and waiting on the user's answer).
 *
 * This is a genuinely new, additive core seam — no existing hook exposes a
 * permission/question-blocked signal anywhere in core today (confirmed by
 * exhaustive search across `core/agents`, `core/tools`, and the extension
 * surface for `approval`/`needsApproval`/permission-blocked terminology:
 * zero hits). It is deliberately a side file, not a transcript/message
 * entry, so it carries zero cache or system-prompt implications: nothing
 * about the session's message history or system prompt changes because this
 * marker exists.
 *
 *   <sessionPath>.awaiting-input   ->   { pid, reason, since }
 *
 * A process marks its own session file when it enters an interactive
 * blocking prompt and clears the marker unconditionally (submit, cancel, or
 * error) in a `finally`. Cross-process readers (e.g. a separate `pi agents`
 * dashboard process tailing another session's `.jsonl`) additionally
 * validate the marker's owning pid is alive and the marker isn't stale
 * before trusting it, exactly as `session-liveness.ts` does for its own
 * markers — a crashed process can leave a marker behind, and a reader must
 * not report "awaiting input" forever for a session whose process is gone.
 */

const MARKER_SUFFIX = ".awaiting-input";
/** A marker older than this without being refreshed/cleared is stale. */
const STALE_MS = 60_000;

export interface AwaitingInputMarker {
	pid: number;
	/** Short, human-readable description of what's pending (e.g. the tool's `intent`). */
	reason: string;
	/** Epoch ms the marker was written. */
	since: number;
}

function markerPathFor(sessionPath: string): string {
	return `${sessionPath}${MARKER_SUFFIX}`;
}

/** Returns true when a process with the given pid is currently alive. */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// Signal 0 performs existence/permission checks without delivering a signal.
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but is owned by another user.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Mark `sessionPath` as currently blocked on an interactive prompt owned by
 * this process. Call immediately before rendering the blocking UI; safe to
 * call repeatedly (each call refreshes `since`). Best-effort — a transiently
 * unwritable session dir must never throw and break the calling tool.
 */
export function markSessionAwaitingInput(sessionPath: string, reason: string): void {
	const marker: AwaitingInputMarker = { pid: process.pid, reason, since: Date.now() };
	try {
		writeFileSync(markerPathFor(sessionPath), JSON.stringify(marker));
	} catch {
		// Best effort; absence of a marker just falls back to regex inference
		// for readers, which is the existing behavior anyway.
	}
}

/**
 * Clear the awaiting-input marker for `sessionPath`. Call unconditionally
 * once the blocking prompt resolves (submitted, cancelled, or errored) —
 * callers should wrap this in a `finally`.
 */
export function clearSessionAwaitingInput(sessionPath: string): void {
	try {
		unlinkSync(markerPathFor(sessionPath));
	} catch {
		// Already cleared or never written; nothing to do.
	}
}

/**
 * Read and validate the awaiting-input marker for `sessionPath`. Returns
 * `undefined` when no marker exists, it's malformed, its owning pid is dead,
 * or it has gone stale (the owning process died without clearing it, or is
 * wedged badly enough that trusting a minute-old "awaiting input" claim is
 * no longer useful). Callers needing liveness only (not staleness) may
 * inspect `.pid` themselves via a fresher check.
 */
export function readSessionAwaitingInput(sessionPath: string): AwaitingInputMarker | undefined {
	try {
		const parsed = JSON.parse(readFileSync(markerPathFor(sessionPath), "utf8")) as Partial<AwaitingInputMarker>;
		if (typeof parsed.pid !== "number" || typeof parsed.reason !== "string" || typeof parsed.since !== "number") {
			return undefined;
		}
		if (Date.now() - parsed.since >= STALE_MS) return undefined;
		if (!isPidAlive(parsed.pid)) return undefined;
		return { pid: parsed.pid, reason: parsed.reason, since: parsed.since };
	} catch {
		return undefined;
	}
}
