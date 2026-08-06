import { readFileSync } from "node:fs";
import type { ExtensionLoadMode } from "./extensions/types.ts";

/** Extension manifest entry. The object form carries the fork's per-entry load mode. */
export type ExtensionManifestEntry = string | { path: string; load?: ExtensionLoadMode };

export interface PiManifest {
	extensions?: ExtensionManifestEntry[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/** Path of a manifest entry, regardless of whether it uses the string or object form. */
export function manifestEntryPath(entry: ExtensionManifestEntry): string {
	return typeof entry === "string" ? entry : entry.path;
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExtensionManifestEntry(entry: unknown): entry is ExtensionManifestEntry {
	if (typeof entry === "string") return true;
	if (!isObject(entry) || typeof entry.path !== "string") return false;
	return entry.load === undefined || entry.load === "eager" || entry.load === "deferred";
}

export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (!isObject(pkg) || !isObject(pkg.pi)) {
			return null;
		}

		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.pi[field];
			if (!Array.isArray(entries)) continue;
			if (field === "extensions") {
				manifest.extensions = entries.filter(isExtensionManifestEntry);
				continue;
			}
			if (entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
