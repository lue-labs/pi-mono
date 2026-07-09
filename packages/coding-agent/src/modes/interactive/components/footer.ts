import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@valkyriweb/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { computeCacheHealth } from "../../../core/cache-health.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { theme } from "../theme/theme.ts";
import { FooterUsageTracker, type UsageTotals } from "./footer-usage.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function splitTopRightStatus(text: string): { topRight?: string; remaining?: string } {
	const cleaned = sanitizeStatusText(text);
	const topRightParts: string[] = [];
	const remaining = cleaned
		.replace(/(?:^|\s)([⚡🧠][^⚡🧠]*?(?=\s+[⚡🧠]|$))/gu, (_match, part: string) => {
			const trimmed = part.trim();
			if (trimmed) topRightParts.push(trimmed);
			return " ";
		})
		.replace(/ +/g, " ")
		.trim();
	const topRight = topRightParts.join(" ");
	if (!topRight) return { remaining: cleaned };
	return { topRight, remaining: remaining || undefined };
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private usageTracker = new FooterUsageTracker();
	private selectedExtensionFooterId: string | undefined = undefined;
	private renderCacheKey = "";
	private renderCache: string[] = [];

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSelectedExtensionFooterId(id: string | undefined): void {
		if (this.selectedExtensionFooterId === id) return;
		this.selectedExtensionFooterId = id;
		this.renderCacheKey = "";
		this.renderCache = [];
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Clear rendered lines when an external footer source changes.
	 *
	 * Git branch caching lives in the provider, and registered footer pill
	 * output participates in the render memo key, so most dynamic sources
	 * repaint on the next render pass without this call. This seam remains for
	 * callers that know footer inputs changed out-of-band (core task
	 * subscriptions) and must not race the change-guard.
	 */
	invalidate(): void {
		this.renderCacheKey = "";
		this.renderCache = [];
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/** Render extension-contributed footer pills at the bottom of the footer. */
	private renderBackgroundStatusLine(width: number): string | undefined {
		const parts = this.session.extensionRunner
			.getRegisteredFooters()
			.filter(({ spec }) => spec.visible?.() ?? true)
			.sort((a, b) => (a.spec.order ?? 0) - (b.spec.order ?? 0))
			.map(({ id, spec }) => {
				const selected = id === this.selectedExtensionFooterId;
				const text = sanitizeStatusText(
					spec.render({
						width,
						theme,
						selected,
					}),
				);
				if (!text) return "";
				return selected ? theme.bg("selectedBg", theme.fg("text", ` ${text} `)) : theme.fg("dim", text);
			})
			.filter((part) => part.length > 0);
		if (parts.length === 0) return undefined;
		return truncateToWidth(parts.join(theme.fg("dim", " · ")), width, theme.fg("dim", "..."));
	}

	private getUsageEntries() {
		return typeof this.session.sessionManager.getBranch === "function"
			? this.session.sessionManager.getBranch()
			: this.session.sessionManager.getEntries();
	}

	private getUsageTotals(): UsageTotals {
		return this.usageTracker.getTotals(this.getUsageEntries());
	}

	render(width: number): string[] {
		const state = this.session.state;
		const {
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			assistantTurns,
			lastUsage,
			lastTimestamp,
			lastApi,
			lastProvider,
			lastModel,
			lastResponseModel,
			previousUsage,
			previousTimestamp,
			previousModel,
			cacheHealthExemptions,
			postCompactionTurn,
			followsUserTurn,
		} = this.getUsageTotals();

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextUsageDetails = contextUsage?.details;
		const deferredToolTokens = contextUsageDetails?.deferredToolSchemaTokens ?? 0;
		const loadedDeferredToolCount = contextUsageDetails?.loadedDeferredToolCount ?? 0;
		const loadedContextTokens = contextUsageDetails?.loadedContextTokens ?? null;
		const providerContextTokens = contextUsage?.tokens ?? null;
		const useLoadedEstimate =
			providerContextTokens !== null &&
			contextUsageDetails?.source === "loaded_estimate" &&
			loadedContextTokens !== null;
		const useLoadedDeferredFloor =
			contextUsageDetails?.source === "provider_usage" &&
			contextUsageDetails.nativeDeferredTools === true &&
			providerContextTokens !== null &&
			loadedContextTokens !== null &&
			deferredToolTokens === 0 &&
			loadedDeferredToolCount > 0;
		const displayContextTokens = useLoadedEstimate
			? loadedContextTokens
			: useLoadedDeferredFloor
				? Math.max(providerContextTokens, loadedContextTokens)
				: providerContextTokens;
		const contextPercentValue =
			displayContextTokens === null || contextWindow <= 0 ? 0 : (displayContextTokens / contextWindow) * 100;
		const contextPercent = displayContextTokens === null ? "?" : contextPercentValue.toFixed(1);
		const knownTokens = displayContextTokens ?? 0;

		// CWD with ~ substitution
		const basePwd = formatCwdForFooter(
			this.session.sessionManager.getCwd(),
			process.env.HOME || process.env.USERPROFILE,
		);

		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();

		// Cheap change-guard: gather every input that can affect the rendered
		// lines *before* doing any of the theme.fg()/padding/truncation work
		// below, and skip straight to the memoized lines if nothing changed.
		// Same pattern as FooterUsageTracker's usageCacheKey (footer-usage.ts),
		// extended to the whole footer output (see perf/BASELINE.md fix #1).
		//
		// Registered footer pills have dynamic visible()/render() callbacks, so
		// their output must be part of the change-guard: extensions (monitor,
		// workflow, agents) mutate state and expect the next render pass to
		// repaint the pill without any explicit invalidation call. The callbacks
		// are cheap per-frame renderers (upstream called them on every frame
		// before memoization existed), so evaluating them here keeps the memo
		// for the expensive theme/layout work below.
		const backgroundStatusLine = this.renderBackgroundStatusLine(width);
		const extensionStatuses = this.footerData.getExtensionStatuses();
		const extensionStatusesKey = Array.from(extensionStatuses.entries())
			.map(([id, text]) => `${id}=${text}`)
			.join("\u0001");
		const pendingAutoModelAlias = this.session.pendingAutoModelAlias;
		const thinkingLevel = state.thinkingLevel || "off";
		const providerCount = this.footerData.getAvailableProviderCount();
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		const renderKey = [
			width,
			basePwd,
			branch ?? "",
			sessionName ?? "",
			extensionStatusesKey,
			this.selectedExtensionFooterId ?? "",
			this.autoCompactEnabled,
			contextWindow,
			displayContextTokens,
			contextPercent,
			deferredToolTokens,
			totalInput,
			totalOutput,
			totalCacheRead,
			totalCacheWrite,
			totalCost,
			assistantTurns,
			lastUsage
				? `${lastUsage.input}:${lastUsage.output}:${lastUsage.cacheRead}:${lastUsage.cacheWrite}:${lastUsage.cost.total}`
				: "",
			lastTimestamp ?? "",
			lastApi ?? "",
			lastModel ?? "",
			lastResponseModel ?? "",
			lastProvider ?? "",
			previousUsage ? `${previousUsage.input}:${previousUsage.cacheRead}:${previousUsage.cacheWrite}` : "",
			previousTimestamp ?? "",
			previousModel ?? "",
			cacheHealthExemptions.join(","),
			postCompactionTurn,
			followsUserTurn,
			pendingAutoModelAlias ?? "",
			state.model?.id ?? "",
			state.model?.reasoning ? "1" : "0",
			thinkingLevel,
			providerCount,
			state.model?.provider ?? "",
			state.model?.api ?? "",
			usingSubscription ? "1" : "0",
			backgroundStatusLine ?? "",
		].join("|");

		if (renderKey === this.renderCacheKey) {
			return this.renderCache;
		}

		// Dim middle-dot separator
		const sep = theme.fg("dim", " · ");

		// ── Line 1: pwd · branch · session ────────────────────────────────────────
		let pwdContent = theme.fg("muted", basePwd);
		if (branch) {
			pwdContent += theme.fg("dim", " (") + theme.fg("borderAccent", theme.bold(branch)) + theme.fg("dim", ")");
		}
		if (sessionName) {
			pwdContent += sep + theme.fg("accent", sessionName);
		}
		const sortedStatusParts = Array.from(extensionStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => splitTopRightStatus(text));
		const topRightStatuses = sortedStatusParts
			.map((part) => part.topRight)
			.filter((part): part is string => Boolean(part));
		const bottomStatuses = sortedStatusParts
			.map((part) => part.remaining)
			.filter((part): part is string => Boolean(part));
		const topRightStatus = topRightStatuses.length > 0 ? theme.fg("dim", topRightStatuses.join(" ")) : "";

		let pwdLine: string;
		if (topRightStatus && visibleWidth(pwdContent) + 2 + visibleWidth(topRightStatus) <= width) {
			const padding = " ".repeat(width - visibleWidth(pwdContent) - visibleWidth(topRightStatus));
			pwdLine = pwdContent + padding + topRightStatus;
		} else {
			pwdLine = truncateToWidth(pwdContent, width, theme.fg("dim", "..."));
		}

		// ── Line 2: token stats · context% ··············· model · thinking ───────
		const leftParts: string[] = [];
		if (totalInput) leftParts.push(theme.fg("dim", `↑${formatTokens(totalInput)}`));
		if (totalOutput) leftParts.push(theme.fg("dim", `↓${formatTokens(totalOutput)}`));
		if (totalCacheRead) leftParts.push(theme.fg("dim", `R${formatTokens(totalCacheRead)}`));
		if (totalCacheWrite) leftParts.push(theme.fg("dim", `W${formatTokens(totalCacheWrite)}`));
		// Provider usage is normalized into non-cached input, cache reads, and
		// cache writes. The footer's primary `cache N%` is total input coverage:
		// cacheRead / (input + cacheRead + cacheWrite). Prefix health is separate:
		// warnings call out a large fresh tail or an unexpected cold prefix write.
		const hasLatestUsage =
			lastUsage !== undefined && lastUsage.input + lastUsage.cacheRead + lastUsage.cacheWrite > 0;
		if (hasLatestUsage && lastUsage) {
			const health = computeCacheHealth({
				usage: lastUsage,
				timestamp: lastTimestamp,
				model: lastModel ?? state.model?.id,
				assistantTurn: assistantTurns,
				postCompactionTurn,
				exemptions: cacheHealthExemptions,
				previousAssistant: previousUsage
					? { usage: previousUsage, timestamp: previousTimestamp, model: previousModel }
					: undefined,
				followsUserTurn,
			});
			const markers: string[] = [];
			if (postCompactionTurn) markers.push("⟳compact");
			if (health.warnings.includes("fresh_tail_large")) markers.push("⚠fresh");
			if (health.warnings.includes("cache_write_unhealthy")) markers.push("🔥write");
			if (health.warnings.includes("thinking_strip_likely")) markers.push("⟳think");
			if (health.warnings.includes("ttl_expiry_likely")) markers.push("⌛ttl");
			const label = [`cache ${health.coveragePct}%`, ...markers].join(" ");
			let colored: string;
			if (postCompactionTurn) colored = theme.fg("dim", label);
			else if (health.warnings.includes("cache_write_unhealthy")) colored = theme.fg("error", theme.bold(label));
			else if (health.warnings.includes("thinking_strip_likely")) colored = theme.fg("dim", label);
			else if (health.warnings.includes("ttl_expiry_likely")) colored = theme.fg("warning", theme.bold(label));
			else if (health.warnings.includes("fresh_tail_large")) colored = theme.fg("warning", label);
			else if (health.warmthPct >= 80) colored = theme.fg("success", label);
			else if (assistantTurns <= 1) colored = theme.fg("dim", label);
			else colored = theme.fg("warning", label);
			leftParts.push(colored);
		}

		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			leftParts.push(theme.fg("dim", costStr));
		}
		if (assistantTurns) leftParts.push(theme.fg("dim", `t${assistantTurns}`));

		// Context % — each piece coloured independently (no outer dim wrapper)
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextTokensDisplay = displayContextTokens === null ? "?" : formatTokens(displayContextTokens);
		const percentLabel = contextPercent === "?" ? "?%" : `${contextPercent}%`;
		const deferredLabel = deferredToolTokens > 0 ? `+d${formatTokens(deferredToolTokens)}` : "";
		const tokensLabel = `${contextTokensDisplay}${deferredLabel}/${formatTokens(contextWindow)}${autoIndicator}`;

		let ctxPct: string;
		if (contextPercentValue > 90) {
			ctxPct = theme.fg("error", theme.bold(percentLabel));
		} else if (contextPercentValue > 70) {
			ctxPct = theme.fg("warning", theme.bold(percentLabel));
		} else if (knownTokens < 25_000) {
			ctxPct = theme.fg("success", theme.bold(percentLabel));
		} else {
			ctxPct = theme.fg("success", percentLabel);
		}
		leftParts.push(`${ctxPct} ${theme.fg("dim", tokensLabel)}`);

		const statsLeft = leftParts.join(sep);
		let statsLeftWidth = visibleWidth(statsLeft);
		if (statsLeftWidth > width) statsLeftWidth = visibleWidth(truncateToWidth(statsLeft, width, "..."));

		// Right side: model (warm yellow) · thinking level (teal)
		// While an auto alias is pending, show only the alias: the concrete model in
		// state is just the unrouted compat seed, and rendering it reads as if
		// routing already resolved. The alias clears on resolve, so the routed
		// model shows here as soon as it actually exists.
		const selectedModelName = pendingAutoModelAlias ?? state.model?.id ?? "no-model";
		const resolvedModelName = lastResponseModel ?? lastModel;
		const resolvedProvider = lastProvider ?? state.model?.provider;
		const showResolvedModel =
			Boolean(resolvedModelName) &&
			resolvedModelName !== selectedModelName &&
			resolvedProvider === state.model?.provider;
		const modelName = showResolvedModel ? `${selectedModelName}→${resolvedModelName}` : selectedModelName;
		const rightParts: string[] = [];
		rightParts.push(theme.fg("syntaxFunction", modelName));
		if (state.model?.reasoning) {
			rightParts.push(thinkingLevel === "off" ? theme.fg("dim", "thinking off") : theme.fg("accent", thinkingLevel));
		}
		let rightSide = rightParts.join(sep);

		// Prepend provider if multiple providers and there's room. For deferred auto
		// aliases this exposes the provider scope while the alias itself stays the
		// visible model name until routing resolves.
		const minPadding = 2;
		if (providerCount > 1 && state.model) {
			const withProvider = theme.fg("dim", `(${state.model.provider}) `) + rightSide;
			if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
				rightSide = withProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		let statsLine: string;
		if (statsLeftWidth + minPadding + rightSideWidth <= width) {
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				statsLine = truncateToWidth(statsLeft, width, theme.fg("dim", "..."));
			}
		}

		const lines = [pwdLine, statsLine];

		if (backgroundStatusLine) {
			lines.push(backgroundStatusLine);
		}

		// Add extension statuses on a single line, sorted by key alphabetically.
		// Compact glyph-only observability snippets (⚡ cost, 🧠 recall) are promoted
		// to line 1's right edge so the footer's lowest line stays for actionable text.
		if (bottomStatuses.length > 0) {
			const statusLine = bottomStatuses.join(" ");
			// Truncate to terminal width with dim ellipsis for consistency with footer style
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		this.renderCacheKey = renderKey;
		this.renderCache = lines;
		return lines;
	}
}
