import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("terminal tool-output settings", () => {
	it("defaults to compact full-motion output and persists explicit preferences", async () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getToolOutput()).toBe("compact");
		expect(settings.getMotion()).toBe("full");

		settings.setToolOutput("expanded");
		settings.setMotion("reduced");
		await settings.flush();

		expect(settings.getToolOutput()).toBe("expanded");
		expect(settings.getMotion()).toBe("reduced");
	});
});
