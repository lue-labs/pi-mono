export {
	type AgentRenderNormalization,
	type AgentRenderTask,
	type AgentToolDetails,
	type AgentToolInput,
	type AgentToolOptions,
	agentToolSchema,
	createAgentTool,
	createAgentToolDefinition,
	createTaskTool,
	createTaskToolDefinition,
	createUppercaseAgentTool,
	createUppercaseAgentToolDefinition,
	normalizeAgentToolModeForRender,
} from "./agent.ts";
export {
	BASH_BG_DEFAULT_MAX_OUTPUT_BYTES,
	BASH_BG_MAX_LOG_READ_BYTES,
	BASH_BG_STALL_TAIL_BYTES,
	BASH_BG_STALL_THRESHOLD_MS,
	BASH_BG_WATCHDOG_INTERVAL_MS,
	type BackgroundShellNotification,
	type BashBgDetails,
	type BashBgJob,
	type BashBgJobKind,
	type BashBgJobOptions,
	type BashBgJobStore,
	type BashBgLifecycleState,
	type BashBgTerminalReason,
	type BashKillToolInput,
	type BashOperations,
	type BashOutputToolInput,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashTimeout,
	type BashTimeoutOutcome,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	checkBashBgLifecycle,
	createBackgroundShellNotification,
	createBashBgJobStore,
	createBashKillTool,
	createBashKillToolDefinition,
	createBashOutputNativeTool,
	createBashOutputNativeToolDefinition,
	createBashOutputTool,
	createBashOutputToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createKillShellTool,
	createKillShellToolDefinition,
	createLocalBashOperations,
	createUppercaseBashTool,
	createUppercaseBashToolDefinition,
	getBashBgJob,
	getRunningBashBgJobsSorted,
	listBashBgJobs,
	looksLikeBashBgPrompt,
	onBashTimeout,
	subscribeBashBgJobs,
	subscribeBashBgNotificationForOwner,
	subscribeBashBgStall,
	subscribeBashBgTerminal,
} from "./bash.ts";
export {
	type BuildInterfaceDetails,
	type BuildInterfaceInput,
	buildInterfaceSchema,
	createBuildInterfaceToolDefinition,
	dispatchBuildInterface,
	executeBuildInterface,
} from "./build-interface.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createGlobTool,
	createGlobToolDefinition,
	type GlobOperations,
	type GlobToolDetails,
	type GlobToolInput,
	type GlobToolOptions,
} from "./glob.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	LAYOUT_GRAPH_VERSION,
	type LayoutGraph,
	type LayoutNode,
	layoutGraphSchema,
	nodeSchema,
} from "./layout-graph.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export { createPiModelCaller, type PiModelCallerOptions } from "./pi-model-caller.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createLLMHarness,
	exampleQuestionsHarness,
	exampleQuestionsInputId,
	formatHarnessUserPrompt,
	type ModelCaller,
	parseHarnessJSON,
	recordingHarness,
	staticHarness,
	type UIHarness,
	type UIHarnessOptions,
	validateLayoutGraph,
} from "./ui-harness.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@lue-labs/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	type AgentToolOptions,
	createAgentTool,
	createAgentToolDefinition,
	createTaskTool,
	createTaskToolDefinition,
	createUppercaseAgentTool,
	createUppercaseAgentToolDefinition,
} from "./agent.ts";
import {
	type BashToolOptions,
	createBashKillTool,
	createBashKillToolDefinition,
	createBashOutputNativeTool,
	createBashOutputNativeToolDefinition,
	createBashOutputTool,
	createBashOutputToolDefinition,
	createBashTool,
	createBashToolDefinition,
	createKillShellTool,
	createKillShellToolDefinition,
	createUppercaseBashTool,
	createUppercaseBashToolDefinition,
} from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createGlobTool, createGlobToolDefinition, type GlobToolOptions } from "./glob.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

// Tool registries erase concrete TypeBox/detail generics across heterogeneous built-ins.
// `any` is unavoidable here because AgentTool/ToolDefinition are intentionally variant in their schema parameter.
export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "Bash"
	| "bash_output"
	| "BashOutput"
	| "bash_kill"
	| "KillShell"
	| "powershell"
	| "edit"
	| "write"
	| "grep"
	| "Glob"
	| "ls"
	| "agent"
	| "Agent"
	| "Task";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"Bash",
	"bash_output",
	"BashOutput",
	"bash_kill",
	"KillShell",
	"powershell",
	"edit",
	"write",
	"grep",
	"Glob",
	"ls",
	"agent",
	"Agent",
	"Task",
]);

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	glob?: GlobToolOptions;
	ls?: LsToolOptions;
	agent?: AgentToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "Bash":
			return createUppercaseBashToolDefinition(cwd, options?.bash);
		case "bash_output":
			return createBashOutputToolDefinition();
		case "BashOutput":
			return createBashOutputNativeToolDefinition();
		case "bash_kill":
			return createBashKillToolDefinition();
		case "KillShell":
			return createKillShellToolDefinition();
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, options?.edit);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "Glob":
			return createGlobToolDefinition(cwd, options?.glob);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "agent":
			return createAgentToolDefinition(cwd, options?.agent);
		case "Agent":
			return createUppercaseAgentToolDefinition(cwd, options?.agent);
		case "Task":
			return createTaskToolDefinition(cwd, options?.agent);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "read":
			return createReadTool(cwd, options?.read);
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "Bash":
			return createUppercaseBashTool(cwd, options?.bash);
		case "bash_output":
			return createBashOutputTool();
		case "BashOutput":
			return createBashOutputNativeTool();
		case "bash_kill":
			return createBashKillTool();
		case "KillShell":
			return createKillShellTool();
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, options?.edit);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "Glob":
			return createGlobTool(cwd, options?.glob);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "agent":
			return createAgentTool(cwd, options?.agent);
		case "Agent":
			return createUppercaseAgentTool(cwd, options?.agent);
		case "Task":
			return createTaskTool(cwd, options?.agent);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createUppercaseBashToolDefinition(cwd, options?.bash),
		createBashOutputNativeToolDefinition(),
		createKillShellToolDefinition(),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createGlobToolDefinition(cwd, options?.glob),
		createLsToolDefinition(cwd, options?.ls),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		read: createReadToolDefinition(cwd, options?.read),
		bash: createBashToolDefinition(cwd, options?.bash),
		Bash: createUppercaseBashToolDefinition(cwd, options?.bash),
		bash_output: createBashOutputToolDefinition(),
		BashOutput: createBashOutputNativeToolDefinition(),
		bash_kill: createBashKillToolDefinition(),
		KillShell: createKillShellToolDefinition(),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, options?.edit),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		Glob: createGlobToolDefinition(cwd, options?.glob),
		ls: createLsToolDefinition(cwd, options?.ls),
		agent: createAgentToolDefinition(cwd, options?.agent),
		Agent: createUppercaseAgentToolDefinition(cwd, options?.agent),
		Task: createTaskToolDefinition(cwd, options?.agent),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createUppercaseBashTool(cwd, options?.bash),
		createBashOutputNativeTool(),
		createKillShellTool(),
		createEditTool(cwd, options?.edit),
		createWriteTool(cwd, options?.write),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return [
		createReadTool(cwd, options?.read),
		createGrepTool(cwd, options?.grep),
		createGlobTool(cwd, options?.glob),
		createLsTool(cwd, options?.ls),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		read: createReadTool(cwd, options?.read),
		bash: createBashTool(cwd, options?.bash),
		Bash: createUppercaseBashTool(cwd, options?.bash),
		bash_output: createBashOutputTool(),
		BashOutput: createBashOutputNativeTool(),
		bash_kill: createBashKillTool(),
		KillShell: createKillShellTool(),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, options?.edit),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		Glob: createGlobTool(cwd, options?.glob),
		ls: createLsTool(cwd, options?.ls),
		agent: createAgentTool(cwd, options?.agent),
		Agent: createUppercaseAgentTool(cwd, options?.agent),
		Task: createTaskTool(cwd, options?.agent),
	};
}
