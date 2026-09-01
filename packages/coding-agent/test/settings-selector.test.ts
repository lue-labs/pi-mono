import { setKeybindings } from "@lue-labs/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("SettingsSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("shows extension-contributed settings and invokes their callback", () => {
		const onChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
				extensionSettings: [
					{
						id: "persistent-mode",
						label: "Persistent mode",
						currentValue: "disabled",
						values: ["disabled", "enabled"],
						onChange,
						extensionPath: "/tmp/persistent-mode.ts",
					},
				],
			} as unknown as SettingsConfig,
			{} as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Persistent mode") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange).toHaveBeenCalledWith("enabled");
	});

	it("cycles through fullscreen scrollbar modes", () => {
		const onChange = vi.fn();
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				availableThinkingLevels: [],
				availableThemes: [],
			} as unknown as SettingsConfig,
			{ onFullscreenScrollbarChange: onChange } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Fullscreen scrollbar") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
	});
});
