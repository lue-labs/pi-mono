import { describe, expect, it } from "vitest";
import { KEYBINDINGS, KeybindingsManager } from "./keybindings.ts";

describe("app.agentView.back keybinding", () => {
	it("is registered with a default left-arrow binding", () => {
		expect(KEYBINDINGS["app.agentView.back"]).toBeDefined();
		expect(KEYBINDINGS["app.agentView.back"].defaultKeys).toBe("left");
	});

	it("resolves via KeybindingsManager with no user overrides", () => {
		const manager = new KeybindingsManager({});
		const resolved = manager.getEffectiveConfig();
		expect(resolved["app.agentView.back"]).toBeDefined();
	});

	it("is user-remappable like any other app keybinding", () => {
		const manager = new KeybindingsManager({ "app.agentView.back": "ctrl+left" });
		const resolved = manager.getEffectiveConfig();
		expect(resolved["app.agentView.back"]).toBe("ctrl+left");
	});

	it("does not collide with an existing AppKeybindings name", () => {
		const names = Object.keys(KEYBINDINGS);
		const occurrences = names.filter((name) => name === "app.agentView.back");
		expect(occurrences).toHaveLength(1);
	});
});
