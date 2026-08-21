import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cjsRequire = createRequire(import.meta.url);
const experimentDir = dirname(fileURLToPath(import.meta.url));
const addonPath = join(experimentDir, "target", "release", "rusty-core-recast.node");

export function loadNativePlanner() {
	if (!existsSync(addonPath)) {
		throw new Error(`native addon is missing: build it, then copy ${join("target", "release", "librusty_core_recast_addon.dylib")} to ${addonPath}`);
	}
	const addon = cjsRequire(addonPath);
	if (typeof addon.scanResidentTranscript !== "function") {
		throw new Error("native addon did not expose scanResidentTranscript(path)");
	}
	return addon;
}

export function scanResidentTranscript(path) {
	const result = loadNativePlanner().scanResidentTranscript(path);
	if (typeof result !== "string") throw new Error("native addon returned a non-string result");
	const plan = JSON.parse(result);
	if (plan?.error) throw new Error(`native addon failed: ${plan.error}`);
	return plan;
}
