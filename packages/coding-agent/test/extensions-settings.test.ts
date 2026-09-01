import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";

describe("extension settings", () => {
	it("registers a setting and routes its change through the extension API", async () => {
		const runtime = createExtensionRuntime();
		const changes: Array<[string, string, unknown]> = [];
		runtime.setExtensionConfigValue = (namespace, key, value) => {
			changes.push([namespace, key, value]);
			return { [key]: value };
		};

		const extension = await loadExtensionFromFactory(
			(pi) => {
				pi.registerSetting({
					id: "prompt-suggestions",
					label: "Prompt suggestions",
					currentValue: "disabled",
					values: ["disabled", "enabled"],
					onChange: (value) => {
						pi.setExtensionConfigValue("prompt-suggestions", "enabled", value === "enabled");
					},
				});
			},
			process.cwd(),
			createEventBus(),
			runtime,
			"<test:extension-settings>",
		);

		extension.registeredSettings.get("prompt-suggestions")?.onChange("enabled");
		expect(changes).toEqual([["prompt-suggestions", "enabled", true]]);
	});
});
