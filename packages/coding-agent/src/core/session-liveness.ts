import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizePath } from "../utils/paths.ts";

/**
 * Per-session liveness signalling.
 *
 * A running interactive pi process advertises which session file it currently
 * has open by writing a sidecar marker file next to the session `.jsonl`:
 *
 *   <sessionPath>.live   ->   { pid, startedAt, heartbeat }
 *
 * The marker is refreshed on a timer and removed on shutdown. The resume picker
 * reads these markers to show which sessions are open in another live pi
 * process. Crashed processes leave a stale marker; readers treat a marker as
 * inactive when its owning pid is dead OR its heartbeat is older than
 * {@link STALE_MS}, and best-effort delete it.
 */

const MARKER_SUFFIX = ".live";
const HEARTBEAT_INTERVAL_MS = 5_000;
/** A marker older than this (without a fresh heartbeat) is considered stale. */
const STALE_MS = 20_000;

interface LivenessMarker {
	pid: number;
	startedAt: number;
	heartbeat: number;
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

function readMarker(markerPath: string): LivenessMarker | null {
	try {
		const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LivenessMarker>;
		if (typeof parsed.pid !== "number" || typeof parsed.heartbeat !== "number") return null;
		return {
			pid: parsed.pid,
			startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : parsed.heartbeat,
			heartbeat: parsed.heartbeat,
		};
	} catch {
		return null;
	}
}

function isMarkerLive(marker: LivenessMarker): boolean {
	return Date.now() - marker.heartbeat < STALE_MS && isPidAlive(marker.pid);
}

/**
 * Given candidate session file paths, return the subset currently open in a live
 * pi process. Stale/dead markers are skipped and best-effort removed. Returned
 * paths are canonicalized to match picker comparisons.
 */
export function listActiveSessionPaths(sessionPaths: Iterable<string>): Set<string> {
	const active = new Set<string>();
	for (const sessionPath of sessionPaths) {
		const markerPath = markerPathFor(sessionPath);
		if (!existsSync(markerPath)) continue;
		const marker = readMarker(markerPath);
		if (marker && isMarkerLive(marker)) {
			active.add(canonicalizePath(sessionPath) ?? sessionPath);
			continue;
		}
		// Stale or unreadable marker — clean it up so it cannot linger.
		try {
			unlinkSync(markerPath);
		} catch {
			// Another process may have removed it already; ignore.
		}
	}
	return active;
}

/**
 * Reap liveness markers left behind by crashed or force-killed sessions.
 *
 * Graceful shutdown removes a session's own marker, and the resume picker reaps
 * stale markers for the sessions it lists — but a SIGKILL'd session whose path
 * is never reopened leaves its marker forever. This walks the whole sessions
 * tree and deletes every marker whose owning process is gone or whose heartbeat
 * has gone stale, so dead markers cannot accumulate. Resolves to the count removed.
 *
 * Only dead markers are touched; live sessions are never disturbed. Safe to call
 * at startup without blocking terminal input while the sessions tree is read.
 */
export async function sweepStaleMarkers(sessionsDir: string): Promise<number> {
	let removed = 0;
	let markerPaths: string[];
	try {
		const entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true });
		markerPaths = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(MARKER_SUFFIX))
			.map((entry) => join(entry.parentPath, entry.name));
	} catch {
		return 0; // sessions dir absent or unreadable
	}
	for (const markerPath of markerPaths) {
		const marker = readMarker(markerPath);
		if (marker && isMarkerLive(marker)) continue;
		try {
			unlinkSync(markerPath);
			removed++;
		} catch {
			// Already gone or being reaped by another process; ignore.
		}
	}
	return removed;
}

/**
 * Manages this process's liveness marker for whichever session file it currently
 * owns. The session path is read lazily on each heartbeat so lazily-created and
 * switched sessions are tracked without extra wiring.
 */
export class SessionLiveness {
	private getSessionPath: (() => string | undefined) | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private currentMarkerPath: string | null = null;

	/** Begin advertising the session returned by `getSessionPath`. */
	start(getSessionPath: () => string | undefined): void {
		this.getSessionPath = getSessionPath;
		this.sync();
		if (this.timer) return;
		this.timer = setInterval(() => this.sync(), HEARTBEAT_INTERVAL_MS);
		// Do not keep the event loop alive solely for the heartbeat.
		this.timer.unref?.();
	}

	/** Write/refresh the marker for the current session path immediately. */
	sync(): void {
		const sessionPath = this.getSessionPath?.();
		const markerPath = sessionPath ? markerPathFor(sessionPath) : null;

		// Session switched: remove the marker for the previous session file.
		if (this.currentMarkerPath && this.currentMarkerPath !== markerPath) {
			this.removeMarker(this.currentMarkerPath);
		}
		this.currentMarkerPath = markerPath;
		if (!markerPath) return;

		const now = Date.now();
		const marker: LivenessMarker = { pid: process.pid, startedAt: now, heartbeat: now };
		try {
			writeFileSync(markerPath, JSON.stringify(marker));
		} catch {
			// Session dir may be transiently unavailable; the next tick retries.
		}
	}

	/** Stop advertising and remove this process's marker. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.getSessionPath = null;
		if (this.currentMarkerPath) {
			this.removeMarker(this.currentMarkerPath);
			this.currentMarkerPath = null;
		}
	}

	private removeMarker(markerPath: string): void {
		try {
			if (existsSync(markerPath)) unlinkSync(markerPath);
		} catch {
			// Best effort; a stale marker will be reaped by readers.
		}
	}
}
