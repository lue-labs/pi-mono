import { randomUUID } from "node:crypto";
import type {
	AgentSessionRuntime,
	ExtensionUIContext,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

import { theme } from "../../coding-agent/src/modes/interactive/theme/theme.ts";

type DialogRequest =
	| Extract<RpcExtensionUIRequest, { method: "select" }>
	| Extract<RpcExtensionUIRequest, { method: "confirm" }>
	| Extract<RpcExtensionUIRequest, { method: "input" }>
	| Extract<RpcExtensionUIRequest, { method: "editor" }>;

type FireAndForgetRequest = Exclude<RpcExtensionUIRequest, DialogRequest>;

interface PendingExtensionRequest {
	resolve(response: RpcExtensionUIResponse): void;
	cancel(): void;
}

export class AttachUiBridge {
	private readonly pendingRequests = new Map<string, PendingExtensionRequest>();
	private onRequest?: (request: RpcExtensionUIRequest) => void;

	attach(onRequest: (request: RpcExtensionUIRequest) => void): () => void {
		this.onRequest = onRequest;
		return () => {
			if (this.onRequest === onRequest) {
				this.onRequest = undefined;
			}
		};
	}

	handleResponse(response: RpcExtensionUIResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			return;
		}
		this.pendingRequests.delete(response.id);
		pending.resolve(response);
	}

	createUiContext(): ExtensionUIContext {
		const requestDialog = <T>(
			request: DialogRequest,
			fallbackValue: T,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> => {
			if (!this.onRequest) {
				return Promise.resolve(fallbackValue);
			}

			return new Promise<T>((resolve) => {
				this.pendingRequests.set(request.id, {
					resolve: (response) => resolve(parseResponse(response)),
					cancel: () => resolve(fallbackValue),
				});
				this.onRequest?.(request);
			});
		};

		const emit = (request: FireAndForgetRequest): void => {
			if (!this.onRequest) {
				return;
			}
			this.onRequest(request);
		};

		return {
			select: async (title, options, opts) =>
				requestDialog(
					{
						type: "extension_ui_request",
						id: randomUUID(),
						method: "select",
						title,
						options,
						timeout: opts?.timeout,
					},
					undefined,
					(response) => ("value" in response ? response.value : undefined),
				),
			confirm: async (title, message, opts) =>
				requestDialog(
					{
						type: "extension_ui_request",
						id: randomUUID(),
						method: "confirm",
						title,
						message,
						timeout: opts?.timeout,
					},
					false,
					(response) => ("confirmed" in response ? response.confirmed : false),
				),
			input: async (title, placeholder, opts) =>
				requestDialog(
					{
						type: "extension_ui_request",
						id: randomUUID(),
						method: "input",
						title,
						placeholder,
						timeout: opts?.timeout,
					},
					undefined,
					(response) => ("value" in response ? response.value : undefined),
				),
			notify: (message, notifyType) => {
				emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType });
			},
			onTerminalInput: () => () => {},
			setStatus: (statusKey, statusText) => {
				emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey, statusText });
			},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: (widgetKey, widgetLines, options) => {
				if (widgetLines === undefined || Array.isArray(widgetLines)) {
					emit({
						type: "extension_ui_request",
						id: randomUUID(),
						method: "setWidget",
						widgetKey,
						widgetLines,
						widgetPlacement: options?.placement,
					});
				}
			},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: (title) => {
				emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title });
			},
			custom: async () => Promise.reject(new Error("Custom UI not supported in orchestrator attach mode")),
			pasteToEditor: (text) => {
				emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
			},
			setEditorText: (text) => {
				emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text });
			},
			getEditorText: () => "",
			editor: async (title, prefill) =>
				requestDialog(
					{ type: "extension_ui_request", id: randomUUID(), method: "editor", title, prefill },
					undefined,
					(response) => ("value" in response ? response.value : undefined),
				),
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "Theme switching not supported in orchestrator attach mode" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	cancelPendingRequests(): void {
		for (const [id, pending] of this.pendingRequests) {
			this.pendingRequests.delete(id);
			pending.cancel();
		}
	}
}

export async function bindAttachExtensions(runtime: AgentSessionRuntime, uiBridge: AttachUiBridge): Promise<void> {
	const session = runtime.session;
	await session.bindExtensions({
		uiContext: uiBridge.createUiContext(),
		mode: "rpc",
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => runtime.newSession(options),
			fork: async (entryId, forkOptions) => {
				const result = await runtime.fork(entryId, forkOptions);
				return { cancelled: result.cancelled };
			},
			navigateTree: async (targetId, options) => {
				const result = await session.navigateTree(targetId, {
					summarize: options?.summarize,
					customInstructions: options?.customInstructions,
					replaceInstructions: options?.replaceInstructions,
					label: options?.label,
				});
				return { cancelled: result.cancelled };
			},
			switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
			reload: async () => {
				await session.reload();
			},
		},
		shutdownHandler: () => {},
		onError: (error) => {
			console.error("Extension error in orchestrator attach mode", error);
		},
	});
}
