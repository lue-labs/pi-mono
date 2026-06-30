import { createHash } from "node:crypto";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";

export interface FileReadLedgerStat {
	mtimeMs: number;
	size?: number;
}

export interface FileReadLedgerEntry {
	canonicalPath: string;
	mtimeMs: number;
	size?: number;
	digest: string;
	readAt: number;
}

export interface FileReadLedger {
	recordRead(path: string, content: Buffer | string, stat?: FileReadLedgerStat): Promise<void>;
	recordWrite(path: string, content: Buffer | string, stat?: FileReadLedgerStat): Promise<void>;
	assertFresh(path: string, operation: "edit" | "write"): Promise<void>;
	get(path: string): Promise<FileReadLedgerEntry | undefined>;
}

function digestContent(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}

async function canonicalize(path: string): Promise<string> {
	try {
		return await fsRealpath(path);
	} catch {
		return path;
	}
}

export class SessionFileReadLedger implements FileReadLedger {
	private readonly entries = new Map<string, FileReadLedgerEntry>();

	async recordRead(path: string, content: Buffer | string, stat?: FileReadLedgerStat): Promise<void> {
		await this.record(path, content, stat);
	}

	async recordWrite(path: string, content: Buffer | string, stat?: FileReadLedgerStat): Promise<void> {
		await this.record(path, content, stat);
	}

	async assertFresh(path: string, operation: "edit" | "write"): Promise<void> {
		const canonicalPath = await canonicalize(path);
		const entry = this.entries.get(canonicalPath);
		if (!entry) return;

		let latest: FileReadLedgerStat;
		try {
			latest = await fsStat(canonicalPath);
		} catch (error) {
			throw new Error(
				`Refusing to ${operation} ${path}: file was read earlier in this session but cannot be statted now (${error instanceof Error ? error.message : String(error)}). Re-read the file and retry.`,
			);
		}

		if (latest.mtimeMs !== entry.mtimeMs || (entry.size !== undefined && latest.size !== entry.size)) {
			throw new Error(
				`Refusing to ${operation} ${path}: file changed since the last Read in this session. Re-read the file and retry with current contents.`,
			);
		}
	}

	async get(path: string): Promise<FileReadLedgerEntry | undefined> {
		return this.entries.get(await canonicalize(path));
	}

	private async record(path: string, content: Buffer | string, stat?: FileReadLedgerStat): Promise<void> {
		const canonicalPath = await canonicalize(path);
		let fileStat = stat;
		if (!fileStat) {
			try {
				fileStat = await fsStat(canonicalPath);
			} catch {
				fileStat = { mtimeMs: Date.now(), size: Buffer.byteLength(content) };
			}
		}
		this.entries.set(canonicalPath, {
			canonicalPath,
			mtimeMs: fileStat.mtimeMs,
			size: fileStat.size,
			digest: digestContent(content),
			readAt: Date.now(),
		});
	}
}
