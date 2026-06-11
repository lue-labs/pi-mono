import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@valkyriweb/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { getLatestCompactionEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

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

interface UsageSnapshot {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

interface UsageTotals {
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	assistantTurns: number;
	lastUsage?: UsageSnapshot;
	/** True when the latest assistant turn is the first after a compaction —
	 * its cold cache write is expected, not prefix drift. */
	postCompactionTurn: boolean;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private usageCacheKey = "";
	private usageCache: UsageTotals = {
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		assistantTurns: 0,
		postCompactionTurn: false,
	};
	private selectedExtensionFooterId: string | undefined = undefined;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSelectedExtensionFooterId(id: string | undefined): void {
		this.selectedExtensionFooterId = id;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
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
			.map(({ id, spec }) =>
				sanitizeStatusText(
					spec.render({
						width,
						theme,
						selected: id === this.selectedExtensionFooterId,
					}),
				),
			)
			.filter((part) => part.length > 0);
		if (parts.length === 0) return undefined;
		return truncateToWidth(theme.fg("dim", parts.join(" · ")), width, theme.fg("dim", "..."));
	}

	private getUsageEntries() {
		return typeof this.session.sessionManager.getBranch === "function"
			? this.session.sessionManager.getBranch()
			: this.session.sessionManager.getEntries();
	}

	private getUsageTotals(): UsageTotals {
		const entries = this.getUsageEntries();
		let lastUsage: UsageSnapshot | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry?.type === "message" && entry.message.role === "assistant") {
				lastUsage = entry.message.usage;
				break;
			}
		}
		const latestCompaction = getLatestCompactionEntry(entries);
		const cacheKey = [
			entries.length,
			entries.at(-1)?.id ?? "",
			latestCompaction?.id ?? "",
			latestCompaction?.timestamp ?? "",
			lastUsage?.input ?? 0,
			lastUsage?.output ?? 0,
			lastUsage?.cacheRead ?? 0,
			lastUsage?.cacheWrite ?? 0,
			lastUsage?.cost.total ?? 0,
		].join(":");

		if (cacheKey === this.usageCacheKey) {
			return this.usageCache;
		}

		const totals: UsageTotals = {
			totalInput: 0,
			totalOutput: 0,
			totalCacheRead: 0,
			totalCacheWrite: 0,
			totalCost: 0,
			assistantTurns: 0,
			lastUsage,
			postCompactionTurn: false,
		};

		const startIndex =
			latestCompaction === null ? 0 : entries.findIndex((entry) => entry.id === latestCompaction.id) + 1;
		for (const entry of entries.slice(startIndex)) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				totals.totalInput += entry.message.usage.input;
				totals.totalOutput += entry.message.usage.output;
				totals.totalCacheRead += entry.message.usage.cacheRead;
				totals.totalCacheWrite += entry.message.usage.cacheWrite;
				totals.totalCost += entry.message.usage.cost.total;
				totals.assistantTurns += 1;
			}
		}

		// The first assistant turn after a compaction rewrites the full prefix —
		// an expected one-time cache write, not prefix drift. Flag it so render()
		// doesn't alarm on the cold hit-rate (CC notifyCompaction analog: the
		// compaction entry in the session IS the notification; no event needed).
		totals.postCompactionTurn = latestCompaction !== null && totals.assistantTurns <= 1;

		this.usageCacheKey = cacheKey;
		this.usageCache = totals;
		return totals;
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
			postCompactionTurn,
		} = this.getUsageTotals();

		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const contextTokens = contextUsage?.tokens ?? null;
		const knownTokens = contextTokens ?? 0;

		// CWD with ~ substitution
		const basePwd = formatCwdForFooter(
			this.session.sessionManager.getCwd(),
			process.env.HOME || process.env.USERPROFILE,
		);

		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();

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
		const extensionStatuses = this.footerData.getExtensionStatuses();
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
		// cache writes. Show cache warmth for the latest turn, not cumulative
		// session totals: a two-turn Codex session has one cold turn + one warm turn,
		// so cumulative math misleadingly displays 50% even when turn 2 is fully warm.
		const latestCacheRead = lastUsage?.cacheRead ?? 0;
		const latestCacheWrite = lastUsage?.cacheWrite ?? 0;
		const latestInput = lastUsage?.input ?? 0;
		const cacheDenom = latestInput + latestCacheRead + latestCacheWrite;
		if (cacheDenom > 0) {
			const hitPct = (latestCacheRead / cacheDenom) * 100;
			const totalCacheDenom = totalInput + totalCacheRead + totalCacheWrite;
			const avgPct = totalCacheDenom > 0 ? (totalCacheRead / totalCacheDenom) * 100 : undefined;
			const label =
				avgPct === undefined
					? `cache ${hitPct.toFixed(0)}%`
					: `cache ${hitPct.toFixed(0)}% avg ${avgPct.toFixed(0)}%`;
			// Past the warmup window (≥10 assistant turns) the prefix should be
			// steady-state cached. <90% means real drift; <80% means something is
			// mutating the cached prefix every turn. Under 10 turns we keep the
			// loose thresholds because turn 1 always writes the full prefix.
			const steadyState = assistantTurns >= 10;
			let colored: string;
			if (postCompactionTurn) {
				// Expected one-time full-prefix rewrite right after compaction — show
				// it as informational, never as drift.
				colored = theme.fg("dim", `cache ${hitPct.toFixed(0)}% ⟳compact`);
			} else if (steadyState) {
				if (hitPct >= 90) colored = theme.fg("success", label);
				else if (hitPct >= 80) colored = theme.fg("warning", label);
				else colored = theme.fg("error", theme.bold(label));
			} else {
				if (hitPct >= 80) colored = theme.fg("success", label);
				else if (hitPct >= 50) colored = theme.fg("dim", label);
				else colored = theme.fg("warning", label);
			}
			leftParts.push(colored);
		}

		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totalCost || usingSubscription) {
			const costStr = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			leftParts.push(theme.fg("dim", costStr));
		}
		if (assistantTurns) leftParts.push(theme.fg("dim", `t${assistantTurns}`));

		// Context % — each piece coloured independently (no outer dim wrapper)
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextTokensDisplay = contextTokens === null ? "?" : formatTokens(contextTokens);
		const percentLabel = contextPercent === "?" ? "?%" : `${contextPercent}%`;
		const tokensLabel = `${contextTokensDisplay}/${formatTokens(contextWindow)}${autoIndicator}`;

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
		const modelName = state.model?.id || "no-model";
		const rightParts: string[] = [];
		rightParts.push(theme.fg("syntaxFunction", modelName));
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightParts.push(thinkingLevel === "off" ? theme.fg("dim", "thinking off") : theme.fg("accent", thinkingLevel));
		}
		let rightSide = rightParts.join(sep);

		// Prepend provider if multiple providers and there's room
		const minPadding = 2;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
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

		const backgroundStatusLine = this.renderBackgroundStatusLine(width);
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

		return lines;
	}
}
