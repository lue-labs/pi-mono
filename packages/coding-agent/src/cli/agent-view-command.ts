import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import chalk from "chalk";
// MUST be "jiti/static", not "jiti": the dynamic "jiti" entry lazy-requires its
// babel transform via a relative path ("../dist/babel.cjs") at call time, which
// doesn't exist inside the compiled Bun binary (only statically-declared
// imports get bundled) and fails with "Cannot find module '../dist/babel.cjs'".
// The main extension loader (core/extensions/loader.ts) already uses the
// static entry for exactly this reason; this loader silently swallowed the
// failure and reported it as "requires the pi-agent-view package" instead.
import { createJiti } from "jiti/static";
import { getAgentDir } from "../config.ts";
import { getExtensionJitiResolutionOptions } from "../core/extensions/loader.ts";
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
	const directCandidates = [configuredModule, AGENT_VIEW_PACKAGE_NAME].filter((candidate): candidate is string =>
		Boolean(candidate),
	);

	for (const candidate of directCandidates) {
		const loaded = await importAgentViewModule(candidate);
		if (loaded) return loaded;
	}

	const configuredEntrypoint = await findConfiguredAgentViewEntrypoint(cwd, agentDir);
	return configuredEntrypoint ? importAgentViewModule(configuredEntrypoint) : undefined;
}

async function importAgentViewModule(specifier: string): Promise<AgentViewModule | undefined> {
	try {
		// Reuse the exact same virtualModules/alias config the main extension
		// loader uses (getExtensionJitiResolutionOptions()) — without it, this
		// jiti instance can resolve the entrypoint file itself but not that
		// file's own `@lue-labs/pi-coding-agent` / `@lue-labs/pi-tui` etc.
		// imports (plain Node resolution has no guarantee a package literally
		// named e.g. `@lue-labs/pi-coding-agent` sits in `node_modules` — npm
		// peer-conflict dedup can rename it), so `pi agents` found the package
		// but then silently failed to actually load its module graph and fell
		// all the way through to the "requires the pi-agent-view package" error.
		const jiti = createJiti(import.meta.url, {
			fsCache: false,
			interopDefault: false,
			...getExtensionJitiResolutionOptions(),
		});
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

async function findConfiguredAgentViewEntrypoint(cwd: string, agentDir: string): Promise<string | undefined> {
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolved = await packageManager.resolve(async () => "skip");

	for (const resource of resolved.extensions) {
		if (!resource.enabled) continue;
		const packageRoot = findPackageRoot(resource.path);
		if (!packageRoot) continue;
		if (isAgentViewPackageName(packageName(packageRoot))) return resource.path;
	}

	return undefined;
}

// Matches both the unscoped package name ("pi-agent-view") and any scoped
// variant published under an npm org ("@valkyriweb/pi-agent-view", etc.) —
// bundles like my-pi-full ship the extension under the publisher's scope, so
// an exact unscoped match alone silently failed to find it here (`pi agents`
// reported "requires the pi-agent-view package" even though it was installed
// and enabled).
function isAgentViewPackageName(name: string | undefined): boolean {
	if (!name) return false;
	if (name === AGENT_VIEW_PACKAGE_NAME) return true;
	const slashIndex = name.lastIndexOf("/");
	return slashIndex !== -1 && name.slice(slashIndex + 1) === AGENT_VIEW_PACKAGE_NAME;
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
	isAgentViewPackageName,
};
