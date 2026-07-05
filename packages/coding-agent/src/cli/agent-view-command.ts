import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
import { createJiti } from "jiti";
import { getAgentDir } from "../config.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";

type AgentViewCliResult = {
	sessionPath?: string;
	cancelled?: boolean;
};

type AgentViewModule = {
	runAgentViewCli(args?: string[], options?: { cwd?: string }): Promise<AgentViewCliResult>;
};

export type AgentViewCommandResult = { handled: true } | { handled: false; args: string[] };

const AGENT_VIEW_PACKAGE_NAME = "pi-agent-view";

export function isAgentViewCommand(args: string[]): boolean {
	return args[0] === "agents";
}

export async function runAgentViewCommand(
	args: string[],
	cwd: string = process.cwd(),
): Promise<AgentViewCommandResult> {
	if (!isAgentViewCommand(args)) return { handled: false, args };

	const agentView = await loadAgentViewModule(cwd, getAgentDir());
	if (!agentView) {
		console.error(
			chalk.red(
				`Error: \`pi agents\` requires the ${AGENT_VIEW_PACKAGE_NAME} package. Install it with \`pi install <source>\` or add a package that includes ${AGENT_VIEW_PACKAGE_NAME}.`,
			),
		);
		process.exit(1);
	}

	const result = await agentView.runAgentViewCli(args.slice(1), { cwd });
	if (result.sessionPath) {
		return { handled: false, args: ["--session", result.sessionPath] };
	}

	return { handled: true };
}

async function loadAgentViewModule(cwd: string, agentDir: string): Promise<AgentViewModule | undefined> {
	const configuredModule = process.env.PI_AGENT_VIEW_MODULE;
	// Try the configured override and the bare unscoped name first — cheap,
	// synchronous-ish candidates that don't require walking the package
	// manager's resolved resource list.
	const directCandidates = [configuredModule, AGENT_VIEW_PACKAGE_NAME].filter((candidate): candidate is string =>
		Boolean(candidate),
	);

	for (const candidate of directCandidates) {
		const loaded = await importAgentViewModule(candidate);
		if (loaded) return loaded;
	}

	// The bare specifier never resolves for a scoped-only publish (e.g.
	// `@valkyriweb/pi-agent-view`) — resolve the actual configured package name
	// (scoped or not) via the package manager and try importing that directly
	// too, before falling back to the resource-path-based entrypoint lookup.
	const resolvedName = await findConfiguredAgentViewPackageName(cwd, agentDir);
	if (resolvedName && !directCandidates.includes(resolvedName)) {
		const loaded = await importAgentViewModule(resolvedName);
		if (loaded) return loaded;
	}

	const configuredEntrypoint = await findConfiguredAgentViewEntrypoint(cwd, agentDir);
	return configuredEntrypoint ? importAgentViewModule(configuredEntrypoint) : undefined;
}

async function importAgentViewModule(specifier: string): Promise<AgentViewModule | undefined> {
	try {
		const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: false });
		const mod = (await jiti.import(specifier)) as Partial<AgentViewModule> & { default?: Partial<AgentViewModule> };
		const candidate = mod.runAgentViewCli ? mod : mod.default;
		return typeof candidate?.runAgentViewCli === "function" ? (candidate as AgentViewModule) : undefined;
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
			console.error(
				chalk.yellow(
					`Warning: agent-view module "${specifier}" failed to load: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}
		return undefined;
	}
}

/**
 * A resolved package matches the agent-view package when its name is exactly
 * `AGENT_VIEW_PACKAGE_NAME` (unscoped, e.g. a local dev checkout) or is any
 * npm-scoped publish of it (`@<scope>/pi-agent-view`, e.g. this fork's own
 * `@valkyriweb/pi-agent-view`). A literal unscoped-only comparison always
 * fails once the package is published under an npm scope.
 */
function matchesAgentViewPackageName(name: string | undefined): boolean {
	if (!name) return false;
	return name === AGENT_VIEW_PACKAGE_NAME || name.endsWith(`/${AGENT_VIEW_PACKAGE_NAME}`);
}

async function findConfiguredAgentViewEntrypoint(cwd: string, agentDir: string): Promise<string | undefined> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");

	for (const resource of resolved.extensions) {
		if (!resource.enabled) continue;
		const packageRoot = findPackageRoot(resource.path);
		if (!packageRoot) continue;
		if (matchesAgentViewPackageName(packageName(packageRoot))) return resource.path;
	}

	return undefined;
}

/**
 * Resolve the actual (possibly scoped) package name of whichever enabled
 * extension resource matches the agent-view package shape, so callers can try
 * importing it by its real specifier instead of only the bare literal.
 */
async function findConfiguredAgentViewPackageName(cwd: string, agentDir: string): Promise<string | undefined> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");

	for (const resource of resolved.extensions) {
		if (!resource.enabled) continue;
		const packageRoot = findPackageRoot(resource.path);
		if (!packageRoot) continue;
		const name = packageName(packageRoot);
		if (matchesAgentViewPackageName(name)) return name;
	}

	return undefined;
}

function findPackageRoot(startPath: string): string | undefined {
	let dir = dirname(startPath);
	while (dir !== dirname(dir)) {
		const packageJson = join(dir, "package.json");
		if (existsSync(packageJson)) return dir;
		dir = dirname(dir);
	}
	return undefined;
}

function packageName(packageRoot: string): string | undefined {
	try {
		const data = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: unknown };
		return typeof data.name === "string" ? data.name : undefined;
	} catch {
		return undefined;
	}
}

export const __test = {
	findPackageRoot,
	packageName,
	matchesAgentViewPackageName,
	loadAgentViewModule,
};
