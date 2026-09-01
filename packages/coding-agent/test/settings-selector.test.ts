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
		const setting = {
			id: "prompt-suggestions",
			label: "Prompt suggestions",
			currentValue: "disabled",
			values: ["disabled", "enabled"],
			onChange,
			extensionPath: "/tmp/prompt-suggestions.ts",
		};
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				defaultModel: "not set",
				availableDefaultModels: [],
				availableThinkingLevels: [],
				modelThinkingLevels: {},
				availableThemes: [],
				extensionSettings: [setting],
			} as unknown as SettingsConfig,
			{} as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Prompt suggestions") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onChange).toHaveBeenCalledWith("enabled");
		expect(setting.currentValue).toBe("enabled");
	});

	it("contains extension setting callback failures and reports them", () => {
		const onError = vi.fn();
		const setting = {
			id: "broken",
			label: "Broken setting",
			currentValue: "off",
			values: ["off", "on"],
			onChange: () => {
				throw new Error("setting failed");
			},
			extensionPath: "/tmp/broken.ts",
		};
		const selector = new SettingsSelectorComponent(
			{
				fullscreenScrollbar: "auto",
				warnings: {},
				defaultModel: "not set",
				availableDefaultModels: [],
				availableThinkingLevels: [],
				modelThinkingLevels: {},
				availableThemes: [],
				extensionSettings: [setting],
			} as unknown as SettingsConfig,
			{ onExtensionSettingError: onError } as unknown as SettingsCallbacks,
		);
		const settingsList = selector.getSettingsList();

		for (const character of "Broken setting") settingsList.handleInput(character);
		settingsList.handleInput("\r");
		settingsList.handleInput("\r");

		expect(onError).toHaveBeenCalledWith(setting, expect.any(Error));
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn();
		const onScrollbarChange = vi.fn();
		const onCopyOnSelectChange = vi.fn();
		const config = {
			fullscreenExitOutput: "transcript",
			fullscreenScrollbar: "auto",
			fullscreenCopyOnSelect: true,
			warnings: {},
			defaultModel: "not set",
			availableDefaultModels: [],
			availableThinkingLevels: [],
			modelThinkingLevels: {},
			availableThemes: [],
		} as unknown as SettingsConfig;
		const callbacks = {
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		} as unknown as SettingsCallbacks;

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});
});
